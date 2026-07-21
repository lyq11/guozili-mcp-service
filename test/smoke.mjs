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
const client = new Client({ name: "easyeda-mcp-smoke", version: "0.4.11" });

await client.connect(transport);
// 工具清单是外部契约；缺少任一名称都应立即失败。
const tools = await client.listTools();
const expected = [
  "easyeda_health",
  "schematic_list_pages",
  "schematic_inspect_page",
  "schematic_get_component_inventory",
  "schematic_inspect_region",
  "schematic_get_page_occupancy",
  "schematic_find_free_regions",
  "component_search",
  "schematic_analyze_readability",
  "schematic_apply_operations",
  "schematic_rename_schematic",
  "schematic_rename_page",
  "schematic_delete_page",
  "schematic_delete_primitives",
  "schematic_update_net_labels",
  "schematic_place_components",
  "schematic_move_components",
  "schematic_transform_components",
  "schematic_move_components_with_wires",
  "schematic_create_wires",
  "schematic_connect_pin_pairs",
  "schematic_create_net_flags",
  "schematic_create_ports_for_pins",
  "schematic_set_no_connects",
  "schematic_set_component_attributes",
  "schematic_create_texts",
  "schematic_run_drc",
  "pcb_list_boards",
  "pcb_create_from_schematic",
  "pcb_inspect",
  "pcb_inspect_region",
  "pcb_check",
  "pcb_find_board_outline",
  "pcb_list_stackups",
  "pcb_set_stackup",
  "pcb_check_board_outline",
  "pcb_find_unrouted_nets",
  "pcb_check_component_overlaps",
  "pcb_check_outside_components",
  "pcb_check_schematic_consistency",
  "pcb_run_drc",
  "pcb_apply_operations",
  "pcb_transform_components",
  "pcb_group_components_by_schematic_page",
  "pcb_create_board_outline",
  "pcb_delete_board_outline",
  "pcb_replace_board_outline",
  "pcb_create_tracks",
  "pcb_modify_tracks",
  "pcb_create_vias",
  "pcb_modify_vias",
  "pcb_apply_net_track_policy",
  "pcb_arrange_components",
  "pcb_create_pours",
  "pcb_rebuild_pours",
  "pcb_fix_deterministic",
  "pcb_sync_from_schematic",
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
if (!JSON.stringify(applyTool?.inputSchema).includes("transform_components")) {
  throw new Error("Missing transform_components operation schema");
}
if (!JSON.stringify(applyTool?.inputSchema).includes("translate_group")) {
  throw new Error("Missing translate_group operation schema");
}
if (!JSON.stringify(applyTool?.inputSchema).includes("set_no_connects")) {
  throw new Error("Missing set_no_connects operation schema");
}
if (!JSON.stringify(applyTool?.inputSchema).includes("set_component_attribute")) {
  throw new Error("Missing set_component_attribute operation schema");
}
if (!JSON.stringify(applyTool?.inputSchema).includes("set_net_label")) {
  throw new Error("Missing set_net_label operation schema");
}
const moveTool = tools.tools.find((tool) => tool.name === "schematic_move_components");
if (!JSON.stringify(moveTool?.inputSchema).includes("movements")) {
  throw new Error("Invalid schematic_move_components input schema");
}
const transformTool = tools.tools.find((tool) => tool.name === "schematic_transform_components");
const transformSchema = JSON.stringify(transformTool?.inputSchema);
if (!transformSchema.includes("rotation") || !transformSchema.includes("mirror")) {
  throw new Error("Invalid schematic_transform_components input schema");
}
const moveWithWiresTool = tools.tools.find((tool) => tool.name === "schematic_move_components_with_wires");
if (!JSON.stringify(moveWithWiresTool?.inputSchema).includes("wireIds")) {
  throw new Error("Invalid schematic_move_components_with_wires input schema");
}
const noConnectTool = tools.tools.find((tool) => tool.name === "schematic_set_no_connects");
if (!JSON.stringify(noConnectTool?.inputSchema).includes("pinNumbers")) {
  throw new Error("Invalid schematic_set_no_connects input schema");
}
const attributeTool = tools.tools.find((tool) => tool.name === "schematic_set_component_attributes");
if (!JSON.stringify(attributeTool?.inputSchema).includes("valueVisible")) {
  throw new Error("Invalid schematic_set_component_attributes input schema");
}
const netLabelTool = tools.tools.find((tool) => tool.name === "schematic_update_net_labels");
const netLabelSchema = JSON.stringify(netLabelTool?.inputSchema);
if (!netLabelSchema.includes("labelId") || !netLabelSchema.includes("net")) {
  throw new Error("Invalid schematic_update_net_labels input schema");
}
const occupancyTool = tools.tools.find((tool) => tool.name === "schematic_get_page_occupancy");
if (!JSON.stringify(occupancyTool?.inputSchema).includes("cellSize")) {
  throw new Error("Invalid schematic_get_page_occupancy input schema");
}
const freeRegionsTool = tools.tools.find((tool) => tool.name === "schematic_find_free_regions");
if (!JSON.stringify(freeRegionsTool?.inputSchema).includes("clearance")) {
  throw new Error("Invalid schematic_find_free_regions input schema");
}
const pcbApplyTool = tools.tools.find((tool) => tool.name === "pcb_apply_operations");
const pcbApplySchema = JSON.stringify(pcbApplyTool?.inputSchema);
for (const operation of ["transform_components", "create_board_outline", "create_track", "create_via", "modify_tracks", "modify_vias", "set_stackup", "create_pour", "rebuild_pours", "import_schematic_changes"]) {
  if (!pcbApplySchema.includes(operation)) throw new Error(`Missing PCB operation schema: ${operation}`);
}
const pcbTrackTool = tools.tools.find((tool) => tool.name === "pcb_create_tracks");
if (!JSON.stringify(pcbTrackTool?.inputSchema).includes("width")) throw new Error("PCB tracks must require explicit width");
const pcbViaTool = tools.tools.find((tool) => tool.name === "pcb_create_vias");
if (!JSON.stringify(pcbViaTool?.inputSchema).includes("holeDiameter")) throw new Error("PCB vias must require explicit dimensions");
const pcbCreateOutlineTool = tools.tools.find((tool) => tool.name === "pcb_create_board_outline");
const pcbCreateOutlineSchema = JSON.stringify(pcbCreateOutlineTool?.inputSchema);
if (!pcbCreateOutlineSchema.includes("rectangle") || !pcbCreateOutlineSchema.includes("polygon") || !pcbCreateOutlineSchema.includes("cornerRadius")) throw new Error("PCB outline creation must support rectangles, polygons, and rounded corners");
const pcbModifyTrackTool = tools.tools.find((tool) => tool.name === "pcb_modify_tracks");
if (!JSON.stringify(pcbModifyTrackTool?.inputSchema).includes("trackId")) throw new Error("PCB track modification must target primitive IDs");
const pcbModifyViaTool = tools.tools.find((tool) => tool.name === "pcb_modify_vias");
if (!JSON.stringify(pcbModifyViaTool?.inputSchema).includes("viaId")) throw new Error("PCB via modification must target primitive IDs");
const pcbCreateTool = tools.tools.find((tool) => tool.name === "pcb_create_from_schematic");
const pcbCreateSchema = JSON.stringify(pcbCreateTool?.inputSchema);
if (!pcbCreateSchema.includes("schematicUuid") || !pcbCreateSchema.includes("stackup")) throw new Error("PCB creation must require a schematic UUID and support stackup settings");
const pcbSetStackupTool = tools.tools.find((tool) => tool.name === "pcb_set_stackup");
const pcbSetStackupSchema = JSON.stringify(pcbSetStackupTool?.inputSchema);
if (!pcbSetStackupSchema.includes("copperLayerCount") || !pcbSetStackupSchema.includes("innerLayerNames") || !pcbSetStackupSchema.includes("physicalStackingConfigurationName")) throw new Error("PCB stackup setting must support layer counts, names, and saved configurations");
const pcbNetPolicyTool = tools.tools.find((tool) => tool.name === "pcb_apply_net_track_policy");
const pcbNetPolicySchema = JSON.stringify(pcbNetPolicyTool?.inputSchema);
if (!pcbNetPolicySchema.includes("netNames") || !pcbNetPolicySchema.includes("matchMode") || !pcbNetPolicySchema.includes("apply")) throw new Error("PCB net track policy must support selectors and preview/apply");
const pcbArrangeTool = tools.tools.find((tool) => tool.name === "pcb_arrange_components");
const pcbArrangeSchema = JSON.stringify(pcbArrangeTool?.inputSchema);
for (const operation of ["align", "distribute", "snap_to_grid"]) if (!pcbArrangeSchema.includes(operation)) throw new Error(`Missing PCB arrangement operation: ${operation}`);
const pcbOutlineTool = tools.tools.find((tool) => tool.name === "pcb_check_board_outline");
if (!JSON.stringify(pcbOutlineTool?.inputSchema).includes("tolerance")) throw new Error("PCB outline checking must expose tolerance");
const pcbGroupTool = tools.tools.find((tool) => tool.name === "pcb_group_components_by_schematic_page");
const pcbGroupSchema = JSON.stringify(pcbGroupTool?.inputSchema);
if (!pcbGroupSchema.includes("apply") || !pcbGroupSchema.includes("groupGap")) throw new Error("PCB page grouping must support preview and spacing controls");

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
// 扁平 pages 还包含 [backup] 原理图页面，而工程缓存只服务 [main]；必须从主原理图选测试页。
const mainSchematic = pages.structuredContent.schematics.find((schematic) => /\[main\]/i.test(schematic.name));
const firstPage = mainSchematic?.pages?.[0];
if (!firstPage) throw new Error("No [main] schematic page available for smoke test");
const inspected = await client.callTool({
  name: "schematic_inspect_page",
  arguments: { pageUuid: firstPage.uuid, includeWires: false },
});
if (inspected.isError) throw new Error(inspected.content?.[0]?.text || "Inspect page failed");
const firstPinnedComponent = inspected.structuredContent.components.find((component) => component.type === "part" && component.pins.length > 0);
if (firstPinnedComponent && !firstPinnedComponent.pinLayout) throw new Error("Missing inferred pinLayout metadata");
const occupancy = await client.callTool({
  name: "schematic_get_page_occupancy",
  arguments: { pageUuid: firstPage.uuid, cellSize: 5, includeRows: false },
});
if (occupancy.isError) throw new Error(occupancy.content?.[0]?.text || "Occupancy grid failed");
const freeRegions = await client.callTool({
  name: "schematic_find_free_regions",
  arguments: { pageUuid: firstPage.uuid, width: 80, height: 50, count: 1, clearance: 10, cellSize: 5 },
});
if (freeRegions.isError) throw new Error(freeRegions.content?.[0]?.text || "Free-region search failed");
const largestComponentBounds = inspected.structuredContent.components
  .filter((component) => component.bbox)
  .map((component) => ({
    id: component.id,
    designator: component.designator,
    type: component.type,
    x: component.x,
    y: component.y,
    bbox: component.bbox,
    area: Math.abs((component.bbox.maxX - component.bbox.minX) * (component.bbox.maxY - component.bbox.minY)),
  }))
  .sort((left, right) => right.area - left.area)
  .slice(0, 10);
const readabilityPage = mainSchematic.pages.find((page) => page.name.toLowerCase().includes("rs485")) || firstPage;
const readability = await client.callTool({
  name: "schematic_analyze_readability",
  arguments: { pageUuid: readabilityPage.uuid },
});
if (readability.isError) throw new Error(readability.content?.[0]?.text || "Readability analysis failed");
// PCB 冒烟只执行读取和本地分析，不运行 DRC 或任何写操作。
const pcbBoards = await client.callTool({ name: "pcb_list_boards", arguments: {} });
if (pcbBoards.isError) throw new Error(pcbBoards.content?.[0]?.text || "PCB board list failed");
const pcbInspected = await client.callTool({ name: "pcb_inspect", arguments: { refresh: true } });
if (pcbInspected.isError) throw new Error(pcbInspected.content?.[0]?.text || "PCB inspect failed");
const pcbChecked = await client.callTool({ name: "pcb_check", arguments: { refresh: false } });
if (pcbChecked.isError) throw new Error(pcbChecked.content?.[0]?.text || "PCB check failed");
// 直接写工具会真实修改文档并触发会话备份，所以冒烟测试只检查它已注册，不自动调用。
console.log(JSON.stringify({
  // 输出关键结构，便于人工查看当前连接和可读性分析是否正常。
  tools: names,
  health: health.structuredContent,
  pageCount: pages.structuredContent.pages.length,
  occupancy: {
    canvas: occupancy.structuredContent.canvas,
    columns: occupancy.structuredContent.columns,
    rows: occupancy.structuredContent.rows,
    geometryOccupiedRatio: occupancy.structuredContent.geometryOccupiedRatio,
    placementBlockedRatio: occupancy.structuredContent.placementBlockedRatio,
    freeRegionCount: freeRegions.structuredContent.regions.length,
    freeRegions: freeRegions.structuredContent.regions,
    largestComponentBounds,
  },
  readability: {
    page: readability.structuredContent.page,
    score: readability.structuredContent.score,
    metrics: readability.structuredContent.metrics,
  },
  pcb: {
    active: pcbBoards.structuredContent.active,
    board: pcbInspected.structuredContent.pcb,
    counts: pcbInspected.structuredContent.counts,
    checkCounts: pcbChecked.structuredContent.counts,
  },
  directWriteToolRegistered: names.includes("schematic_apply_operations"),
}, null, 2));
await client.close();
