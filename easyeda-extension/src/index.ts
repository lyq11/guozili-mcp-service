// EasyEDA 插件入口：发现本机 MCP、维持 WebSocket 心跳、分发白名单 RPC，并显示状态悬浮窗。
import * as extensionConfig from '../extension.json';
import { dispatch } from './handlers';
import { AUTH_TOKEN, CAPABILITIES, PORT_END, PORT_START, PROTOCOL_VERSION, RpcRequest, SERVICE_ID } from './protocol';

// 每个插件实例使用独立 WebSocket ID，避免多个 EasyEDA 窗口相互覆盖。
const WS_ID_PREFIX = 'easyeda-mcp-rpc';
const WS_ID = `${WS_ID_PREFIX}-${crypto.randomUUID()}`;
const RETRY_DELAY_MS = 3000;
const CONNECTION_TIMEOUT_MS = 1500;
const HEARTBEAT_INTERVAL_MS = 15000;
const HEARTBEAT_TIMEOUT_MS = 5000;
const MBUS_TOPIC_STATUS = 'easyeda-mcp-status';
const MBUS_TOPIC_CONTROL = 'easyeda-mcp-control';
const STATUS_FRAME_ID = 'easyeda-mcp-status-frame';

// 以下变量描述当前插件实例的连接状态；不会跨 EasyEDA 重启持久化。
let currentPort: number | null = null;
let windowId: string | null = null;
let connected = false;
let stopped = false;
let scanGeneration = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let heartbeatPending = false;
let messageBusRegistered = false;
let statusFrameFingerprint = '';
let statusFrameClosedByUser = false;

interface ConnectionStatus {
  connected: boolean;
  connecting: boolean;
  stopped: boolean;
  port: number | null;
  windowId: string | null;
}

/** 生成可通过消息总线和悬浮窗读取的连接状态快照。 */
function getConnectionStatus(): ConnectionStatus {
  return { connected, connecting: !connected && !stopped, stopped, port: currentPort, windowId };
}

/**
 * 根据连接状态选择 iframe 页面并刷新悬浮窗标题。
 * fingerprint 用来避免状态未变化时反复关闭、重开 iframe 导致闪烁。
 */
async function renderStatusFrame(force = false): Promise<void> {
  if (statusFrameClosedByUser && !force) return;
  let info = getConnectionStatus();
  // 多入口加载插件时，优先从已经注册服务的实例取得权威状态；失败则使用本地状态。
  try { info = await eda.sys_MessageBus.rpcCall(MBUS_TOPIC_STATUS, undefined, 300) as ConnectionStatus; } catch {}
  let pageName = '未打开原理图';
  try { pageName = (await eda.dmt_Schematic.getCurrentSchematicPageInfo())?.name || pageName; } catch {}
  const state = info.connected ? 'connected' : info.stopped ? 'stopped' : 'waiting';
  const fingerprint = `${state}|${info.port}|${pageName}`;
  if (!force && fingerprint === statusFrameFingerprint) return;
  statusFrameFingerprint = fingerprint;
  // EasyEDA 没有原地切换 iframe 内容的接口，因此状态变化时先关旧窗再开新窗。
  await eda.sys_IFrame.closeIFrame(STATUS_FRAME_ID).catch(() => false);
  const frameProps = {
    title: info.connected ? `果子狸MCP · ${pageName} · ${info.port}` : `果子狸MCP · ${pageName}`,
    x: 24,
    y: 88,
    grayscaleMask: false,
    maximizeButton: false,
    minimizeButton: true,
    minimizeStyle: 'collapsed' as const,
    buttonCallbackFn: (button: 'close' | 'minimize' | 'maximize') => {
      if (button === 'close') statusFrameClosedByUser = true;
    },
  };
  await eda.sys_IFrame.openIFrame(`/iframe/status-${state}.html`, 300, 156, STATUS_FRAME_ID, frameProps);
}

/** 用户请求重连：清理旧连接并重新扫描端口。 */
function performReconnect(): void {
  stopped = false;
  disconnect();
  void scanAndConnect();
}

/** 用户主动停止连接；自动重试在 stopped 状态下不会继续。 */
function performStop(): void {
  stopped = true;
  disconnect();
}

/**
 * 注册插件内部消息总线服务。
 * 这使菜单命令和可能重复加载的入口可以共享同一份连接状态与控制动作。
 */
function ensureMessageBusServices(): void {
  if (messageBusRegistered) return;
  eda.sys_MessageBus.rpcService(MBUS_TOPIC_STATUS, () => getConnectionStatus());
  eda.sys_MessageBus.rpcService(MBUS_TOPIC_CONTROL, (request?: {command?: string}) => {
    if (request?.command === 'reconnect') performReconnect();
    if (request?.command === 'stop') performStop();
    return { handled: true, ...getConnectionStatus() };
  });
  messageBusRegistered = true;
}

/** 优先通过消息总线控制已有实例；没有服务时回退到当前实例直接执行。 */
async function dispatchControl(command: 'reconnect' | 'stop'): Promise<void> {
  try {
    const response = await eda.sys_MessageBus.rpcCall(MBUS_TOPIC_CONTROL, { command }, 500) as {handled?: boolean};
    if (response?.handled) return;
  } catch {}
  ensureMessageBusServices();
  if (command === 'reconnect') performReconnect();
  else performStop();
}

/** 将对象序列化后发送给 MCP；不接受外部传入 WebSocket 地址。 */
function send(message: unknown): void {
  eda.sys_WebSocket.send(WS_ID, JSON.stringify(message));
}

/** 清理重试和心跳计时器，防止一次断线产生多组后台任务。 */
function clearTimers(): void {
  if (retryTimer) clearTimeout(retryTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  retryTimer = null;
  heartbeatTimer = null;
}

/** 使当前扫描代次失效并关闭 WebSocket，然后刷新状态窗。 */
function disconnect(): void {
  scanGeneration += 1;
  connected = false;
  currentPort = null;
  windowId = null;
  heartbeatPending = false;
  clearTimers();
  try { eda.sys_WebSocket.close(WS_ID); } catch {}
  void renderStatusFrame();
}

/** 处理 MCP 的注册确认、心跳和白名单 RPC 请求。 */
async function handleMessage(message: Record<string, unknown>): Promise<void> {
  if (message.type === 'registered') {
    connected = true;
    heartbeatPending = false;
    eda.sys_Message.showToastMessage(`果子狸MCP服务已连接（端口 ${currentPort}）`);
    void renderStatusFrame();
    return;
  }
  if (message.type === 'ping') {
    send({ type: 'pong', id: message.id, timestamp: Date.now() });
    return;
  }
  if (message.type === 'pong') {
    heartbeatPending = false;
    return;
  }
  if (message.type !== 'rpc') return;
  const request = message as unknown as RpcRequest;
  if (!request.id || typeof request.method !== 'string') return;
  try {
    // dispatch 只允许 handlers.ts 映射表中的方法，不能执行任意代码。
    const result = await dispatch(request.method, request.params || {});
    send({ type: 'result', id: request.id, result: result ?? null, timestamp: Date.now() });
  } catch (error) {
    send({
      type: 'error', id: request.id,
      error: error instanceof Error ? error.message : String(error), timestamp: Date.now(),
    });
  }
}

/**
 * 尝试连接单个端口并完成握手。
 * generation 用于忽略上一次扫描留下的迟到回调，避免旧连接覆盖新状态。
 */
function tryPort(port: number, generation: number): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    // WebSocket 回调和超时可能同时到达，settled 保证 Promise 只完成一次。
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!value) try { eda.sys_WebSocket.close(WS_ID); } catch {}
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), CONNECTION_TIMEOUT_MS);
    try { eda.sys_WebSocket.close(WS_ID); } catch {}
    try {
      eda.sys_WebSocket.register(
        WS_ID,
        `ws://127.0.0.1:${port}/easyeda-mcp`,
        async (event: MessageEvent) => {
          if (generation !== scanGeneration || stopped) { finish(false); return; }
          try {
            const message = JSON.parse(String(event.data)) as Record<string, unknown>;
            if (message.type === 'handshake') {
              // 只有服务标识和协议版本同时匹配，才发送令牌进行注册。
              if (message.service !== SERVICE_ID || message.protocolVersion !== PROTOCOL_VERSION) { finish(false); return; }
              currentPort = port;
              windowId = crypto.randomUUID();
              send({
                type: 'register', token: AUTH_TOKEN, protocolVersion: PROTOCOL_VERSION,
                windowId, extensionVersion: extensionConfig.version, capabilities: CAPABILITIES, timestamp: Date.now(),
              });
              finish(true);
              return;
            }
            await handleMessage(message);
          } catch (error) {
            console.error('[果子狸MCP] 消息无效', error);
          }
        },
        () => {},
      );
    } catch { finish(false); }
  });
}

/** 扫描约定端口范围；成功后启动心跳，全部失败则延迟后重试。 */
async function scanAndConnect(): Promise<void> {
  if (stopped) return;
  const generation = ++scanGeneration;
  connected = false;
  for (let port = PORT_START; port <= PORT_END; port += 1) {
    if (generation !== scanGeneration || stopped) return;
    if (await tryPort(port, generation)) {
      // 心跳请求发出后若 5 秒仍未收到 pong，就重建整条连接。
      heartbeatTimer = setInterval(() => {
        if (!connected) return;
        const heartbeatGeneration = scanGeneration;
        heartbeatPending = true;
        try {
          send({ type: 'ping', id: `hb-${Date.now()}`, timestamp: Date.now() });
          setTimeout(() => {
            if (heartbeatPending && heartbeatGeneration === scanGeneration) performReconnect();
          }, HEARTBEAT_TIMEOUT_MS);
        }
        catch {
          performReconnect();
        }
      }, HEARTBEAT_INTERVAL_MS);
      return;
    }
  }
  retryTimer = setTimeout(() => void scanAndConnect(), RETRY_DELAY_MS);
}

/** EasyEDA 启动完成时的插件生命周期入口。 */
export function activate(_status?: 'onStartupFinished', _arg?: string): void {
  ensureMessageBusServices();
  stopped = false;
  void scanAndConnect();
  void renderStatusFrame();
}

/** 插件停用时关闭连接与悬浮窗。 */
export function deactivate(): void {
  stopped = true;
  disconnect();
  void eda.sys_IFrame.closeIFrame(STATUS_FRAME_ID);
}

/** 菜单命令：重新扫描并连接 MCP。 */
export function reconnect(): void {
  void dispatchControl('reconnect');
}

/** 菜单命令：停止自动连接，直到用户再次选择重连。 */
export function stopConnection(): void {
  void dispatchControl('stop');
  eda.sys_Message.showToastMessage('果子狸MCP服务连接已停止');
}

/** 菜单命令：显示版本、协议和当前连接信息。 */
export async function about(): Promise<void> {
  let info = getConnectionStatus();
  try { info = await eda.sys_MessageBus.rpcCall(MBUS_TOPIC_STATUS, undefined, 500) as ConnectionStatus; } catch {}
  const status = info.connected ? `已连接\n端口：${info.port}\n窗口：${info.windowId}` : info.stopped ? '已停止' : '正在等待 MCP 服务';
  eda.sys_Dialog.showInformationMessage(
    `果子狸MCP服务 v${extensionConfig.version}\n${status}\n协议：RPC v${PROTOCOL_VERSION}\n不支持任意 JavaScript 执行`,
    '果子狸MCP服务',
  );
}

/** 菜单命令：用户关闭悬浮窗后，可通过此入口强制再次显示。 */
export async function showStatusPanel(): Promise<void> {
  statusFrameClosedByUser = false;
  statusFrameFingerprint = '';
  await renderStatusFrame(true);
}
