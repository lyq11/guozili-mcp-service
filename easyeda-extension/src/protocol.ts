// MCP 与 EasyEDA 插件共享的固定协议参数。
// 修改端口、令牌或协议版本时，必须同步修改 MCP 侧 rpc-server.mjs。
export const SERVICE_ID = 'easyeda-mcp';
export const PROTOCOL_VERSION = 1;
export const PORT_START = 49620;
export const PORT_END = 49629;
export const AUTH_TOKEN = '8a0d39d86c764be59260eafb7aa45ff7baf23088c03744dd84cdb186d0411324';
// 插件只会执行下列白名单能力；这里不提供任意 JavaScript 执行入口。
export const CAPABILITIES = [
  'system.health',
  'schematic.listPages',
  'schematic.inspectPage',
  'library.searchComponents',
  'operations.validate',
  'operations.apply',
  'schematic.runDrc',
  'pcb.listBoards',
  'pcb.create',
  'pcb.stackups.list',
  'pcb.inspect',
  'pcb.inspectRegion',
  'pcb.runDrc',
  'pcb.operations.validate',
  'pcb.operations.apply',
] as const;

/** MCP 发往插件的标准 RPC 请求结构。 */
export interface RpcRequest {
  type: 'rpc';
  id: string;
  method: string;
  params?: Record<string, unknown>;
}
