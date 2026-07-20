import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";

// MCP 与插件必须使用相同令牌和协议版本。环境变量可覆盖令牌，便于部署时轮换。
const DEFAULT_TOKEN = "8a0d39d86c764be59260eafb7aa45ff7baf23088c03744dd84cdb186d0411324";
const PROTOCOL_VERSION = 1;

/** 使用恒定时间比较令牌，减少通过响应时间猜测令牌内容的可能性。 */
function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * MCP 侧的本地 RPC 网关。
 *
 * MCP 通过 stdio 服务 AI 客户端，本类则在 127.0.0.1 上接受 EasyEDA 插件的
 * WebSocket 连接，并把白名单方法调用转发给最近注册的编辑器窗口。
 */
export class EasyEdaRpcServer {
  constructor({
    host = "127.0.0.1",
    portStart = Number(process.env.EASYEDA_MCP_PORT_START || 49620),
    portEnd = Number(process.env.EASYEDA_MCP_PORT_END || 49629),
    token = process.env.EASYEDA_MCP_TOKEN || DEFAULT_TOKEN,
    timeoutMs = Number(process.env.EASYEDA_REQUEST_TIMEOUT_MS || 30_000),
  } = {}) {
    // 只绑定回环地址，避免局域网设备直接调用编辑器插件。
    this.host = host;
    this.portStart = portStart;
    this.portEnd = portEnd;
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.httpServer = null;
    this.wsServer = null;
    this.port = null;
    // windows 保存已认证的 EasyEDA 窗口；pending 保存等待插件应答的 RPC。
    this.windows = new Map();
    this.pending = new Map();
    this.startPromise = null;
    this.debug = process.env.EASYEDA_MCP_DEBUG === "1";
  }

  /** 仅在 EASYEDA_MCP_DEBUG=1 时向 stderr 输出诊断信息，避免污染 MCP stdout。 */
  #log(event, details = {}) {
    if (this.debug) console.error(`[easyeda-mcp:rpc] ${event} ${JSON.stringify(details)}`);
  }

  /** 幂等启动；并发调用会等待同一个启动 Promise。 */
  async start() {
    if (this.httpServer) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.#listenOnAvailablePort().finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  /** 从配置的端口区间依次寻找可用监听端口。 */
  async #listenOnAvailablePort() {
    for (let port = this.portStart; port <= this.portEnd; port += 1) {
      try {
        await this.#listen(port);
        return;
      } catch (error) {
        if (error?.code !== "EADDRINUSE") throw error;
      }
    }
    throw new Error(`No free EasyEDA MCP port in ${this.portStart}-${this.portEnd}`);
  }

  /** 创建 HTTP 升级入口；普通 HTTP 请求一律返回 404。 */
  #listen(port) {
    return new Promise((resolve, reject) => {
      const httpServer = createServer((request, response) => {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "Not found" }));
      });
      const wsServer = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
      httpServer.on("upgrade", (request, socket, head) => {
        // 只允许固定路径升级为 WebSocket，缩小本地暴露面。
        this.#log("upgrade", { url: request.url, remoteAddress: request.socket.remoteAddress });
        if (request.url !== "/easyeda-mcp") {
          socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }
        wsServer.handleUpgrade(request, socket, head, (ws) => wsServer.emit("connection", ws, request));
      });
      wsServer.on("connection", (socket) => this.#handleConnection(socket));
      httpServer.once("error", reject);
      httpServer.listen(port, this.host, () => {
        httpServer.removeListener("error", reject);
        this.httpServer = httpServer;
        this.wsServer = wsServer;
        this.port = port;
        this.#log("listening", { host: this.host, port });
        resolve();
      });
    });
  }

  /** 完成握手、鉴权、心跳应答和 RPC 结果分发。 */
  #handleConnection(socket) {
    this.#log("connected");
    const connection = { authenticated: false, windowId: null, capabilities: [] };
    socket.send(JSON.stringify({
      type: "handshake",
      service: "easyeda-mcp",
      protocolVersion: PROTOCOL_VERSION,
      authentication: "token",
      timestamp: Date.now(),
    }));

    // 未在 5 秒内注册的连接会被主动关闭，避免半开连接长期占用资源。
    const authTimer = setTimeout(() => socket.close(1008, "Authentication timeout"), 5_000);
    socket.on("message", (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); }
      catch { socket.close(1003, "Invalid JSON"); return; }

      if (!connection.authenticated) {
        this.#log("registration-attempt", { type: message.type, protocolVersion: message.protocolVersion, hasToken: Boolean(message.token) });
        if (message.type !== "register" || message.protocolVersion !== PROTOCOL_VERSION || !constantTimeEqual(message.token, this.token)) {
          socket.send(JSON.stringify({ type: "error", id: message.id, error: "Authentication failed" }));
          socket.close(1008, "Authentication failed");
          return;
        }
        clearTimeout(authTimer);
        connection.authenticated = true;
        // windowId 用来区分多个 EasyEDA 窗口；缺失时由 MCP 生成。
        connection.windowId = String(message.windowId || randomUUID());
        connection.capabilities = Array.isArray(message.capabilities) ? message.capabilities : [];
        this.windows.set(connection.windowId, { socket, connection, registeredAt: new Date().toISOString() });
        this.#log("registered", { windowId: connection.windowId, capabilities: connection.capabilities });
        socket.send(JSON.stringify({ type: "registered", windowId: connection.windowId, protocolVersion: PROTOCOL_VERSION }));
        return;
      }

      if (message.type === "ping") {
        socket.send(JSON.stringify({ type: "pong", id: message.id, timestamp: Date.now() }));
        return;
      }
      if (message.type === "pong") return;
      if (message.type === "result" || message.type === "error") {
        // 通过请求 id 找到 call() 中对应的 Promise，并完成或拒绝它。
        const request = this.pending.get(message.id);
        if (!request) return;
        clearTimeout(request.timer);
        this.pending.delete(message.id);
        if (message.type === "error") request.reject(new Error(message.error || "EasyEDA RPC failed"));
        else request.resolve(message.result);
      }
    });
    socket.on("close", () => {
      this.#log("closed", { windowId: connection.windowId });
      clearTimeout(authTimer);
      if (connection.windowId) this.windows.delete(connection.windowId);
      // 连接断开后立即拒绝该窗口上的所有待处理请求，避免只能等超时。
      for (const [id, request] of this.pending) {
        if (request.socket !== socket) continue;
        clearTimeout(request.timer);
        request.reject(new Error("EasyEDA extension disconnected"));
        this.pending.delete(id);
      }
    });
  }

  /** 等待至少一个插件窗口注册；当前实现是一次定时等待，不做高频轮询。 */
  async waitForExtension(waitMs = 20_000) {
    await this.start();
    if (this.windows.size) return;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    if (!this.windows.size) throw new Error(`EasyEDA MCP Extension is not connected (listening on ws://${this.host}:${this.port}/easyeda-mcp)`);
  }

  /**
   * 调用插件白名单方法。
   * 未指定 windowId 时选择最后注册的窗口，适合用户当前正在操作的 EasyEDA 实例。
   */
  async call(method, params = {}, { windowId } = {}) {
    await this.waitForExtension();
    const target = windowId ? this.windows.get(windowId) : [...this.windows.values()].at(-1);
    if (!target || target.socket.readyState !== WebSocket.OPEN) throw new Error("No active EasyEDA extension window");
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      // 每个调用都有独立超时；超时后从 pending 删除，迟到应答会被忽略。
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`EasyEDA RPC ${method} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, socket: target.socket });
      target.socket.send(JSON.stringify({ type: "rpc", id, method, params, timestamp: Date.now() }));
    });
  }

  /** 返回监听地址和当前已认证窗口，供 easyeda_health 使用。 */
  async status() {
    await this.start();
    return {
      listening: true,
      endpoint: `ws://${this.host}:${this.port}/easyeda-mcp`,
      protocolVersion: PROTOCOL_VERSION,
      connectedWindows: [...this.windows.entries()].map(([windowId, value]) => ({
        windowId,
        registeredAt: value.registeredAt,
        capabilities: value.connection.capabilities,
      })),
    };
  }

  /** 关闭所有插件连接和本地监听器；主要用于进程退出与测试清理。 */
  close() {
    for (const value of this.windows.values()) value.socket.close(1001, "MCP server stopping");
    this.wsServer?.close();
    this.httpServer?.close();
    this.windows.clear();
  }
}
