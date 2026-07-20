// 端到端冒烟测试：启动真实 MCP stdio 子进程，并通过 MCP SDK 调用只读与预览工具。
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// stderr 继承到当前终端，stdout 则由 MCP SDK 专用于协议传输。
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["src/server.mjs"],
  cwd: process.cwd(),
  stderr: "inherit",
});
const client = new Client({ name: "easyeda-mcp-smoke", version: "0.4.1" });

await client.connect(transport);
// 工具清单是外部契约；缺少任一名称都应立即失败。
const tools = await client.listTools();
const expected = [
  "easyeda_health",
  "schematic_list_pages",
  "schematic_inspect_page",
  "schematic_inspect_region",
  "component_search",
  "schematic_analyze_readability",
  "schematic_apply_operations",
  "schematic_rename_page",
  "schematic_delete_page",
  "schematic_delete_primitives",
  "schematic_place_components",
  "schematic_move_components",
  "schematic_create_wires",
  "schematic_connect_pin_pairs",
  "schematic_create_net_flags",
  "schematic_create_ports_for_pins",
  "schematic_create_texts",
  "schematic_run_drc",
];
const names = tools.tools.map((tool) => tool.name);
for (const name of expected) {
  if (!names.includes(name)) throw new Error(`Missing MCP tool: ${name}`);
}
const applyTool = tools.tools.find((tool) => tool.name === "schematic_apply_operations");
if (!JSON.stringify(applyTool?.inputSchema).includes("create_port_for_pin")) {
  throw new Error("Missing create_port_for_pin operation schema");
}
if (!JSON.stringify(applyTool?.inputSchema).includes("move_component")) {
  throw new Error("Missing move_component operation schema");
}
const moveTool = tools.tools.find((tool) => tool.name === "schematic_move_components");
if (!JSON.stringify(moveTool?.inputSchema).includes("movements")) {
  throw new Error("Invalid schematic_move_components input schema");
}

// 发布构建可只验证工具契约，不要求 EasyEDA 此时已经加载最新版扩展。
if (process.argv.includes("--tools-only")) {
  console.log(JSON.stringify({ toolCount: names.length, tools: names }, null, 2));
  await client.close();
  process.exit(0);
}

// 以下调用需要真实 EasyEDA 插件已连接到本机 RPC 网关。
let health;
for (let attempt = 0; attempt < 20; attempt += 1) {
  health = await client.callTool({ name: "easyeda_health", arguments: {} });
  if (!health.isError) break;
  // 插件从旧 MCP 断开后需要一个重连周期，冒烟测试给它最多约 5 秒。
  await new Promise(resolve => setTimeout(resolve, 250));
}
if (health.isError) throw new Error(health.content?.[0]?.text || "Health tool failed");
const pages = await client.callTool({ name: "schematic_list_pages", arguments: {} });
if (pages.isError) throw new Error(pages.content?.[0]?.text || "List pages failed");
const firstPage = pages.structuredContent.pages[0];
const inspected = await client.callTool({
  name: "schematic_inspect_page",
  arguments: { pageUuid: firstPage.uuid, includeWires: false },
});
if (inspected.isError) throw new Error(inspected.content?.[0]?.text || "Inspect page failed");
const firstPinnedComponent = inspected.structuredContent.components.find((component) => component.type === "part" && component.pins.length > 0);
if (firstPinnedComponent && !firstPinnedComponent.pinLayout) throw new Error("Missing inferred pinLayout metadata");
const readabilityPage = pages.structuredContent.pages.find((page) => page.name.toLowerCase().includes("rs485")) || firstPage;
const readability = await client.callTool({
  name: "schematic_analyze_readability",
  arguments: { pageUuid: readabilityPage.uuid },
});
if (readability.isError) throw new Error(readability.content?.[0]?.text || "Readability analysis failed");
// 直接写工具会真实修改文档并触发会话备份，所以冒烟测试只检查它已注册，不自动调用。
console.log(JSON.stringify({
  // 输出关键结构，便于人工查看当前连接和可读性分析是否正常。
  tools: names,
  health: health.structuredContent,
  pageCount: pages.structuredContent.pages.length,
  readability: {
    page: readability.structuredContent.page,
    score: readability.structuredContent.score,
    metrics: readability.structuredContent.metrics,
  },
  directWriteToolRegistered: names.includes("schematic_apply_operations"),
}, null, 2));
await client.close();
