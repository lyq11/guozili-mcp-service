#!/usr/bin/env node

// EasyEDA MCP 主进程：向 AI 暴露结构化工具，并通过本地 RPC 网关调用编辑器插件。
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { EasyEdaRpcServer } from "./rpc-server.mjs";
import { summarizeOperations, WriteCoordinator } from "./transactions.mjs";
import { analyzeReadability } from "./readability.mjs";
import { annotatePagePinLayouts, planPortForPin } from "./pin-layout.mjs";
import { OCCUPANCY, PageOccupancyCache } from "./page-occupancy.mjs";
import { ProjectCache } from "./project-cache.mjs";

// bridge 管理插件连接；writes 提供会话 ID 和写入串行化。
const bridge = new EasyEdaRpcServer();
const writes = new WriteCoordinator();
const pageOccupancy = new PageOccupancyCache();
const projectCache = new ProjectCache(bridge);
bridge.onRegistration(() => projectCache.initialize({ force: true }));
bridge.onDisconnection(() => projectCache.clear());
// 先占用本地端口，再启动 MCP stdio，插件可以随时连接。
await bridge.start();

// connect_pins 操作的单个引脚端点格式。
const endpointSchema = z.object({
  componentId: z.string().min(1),
  pinNumber: z.string().min(1),
});

const rotationSchema = z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]);

// 所有写操作必须先通过此白名单 Schema；MCP 不接受任意 EasyEDA JavaScript。
const operationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("rename_schematic"), schematicUuid: z.string(), name: z.string().min(1).max(80) }),
  z.object({ type: z.literal("rename_page"), pageUuid: z.string(), name: z.string().min(1).max(80) }),
  z.object({ type: z.literal("delete_page"), pageUuid: z.string() }),
  z.object({
    type: z.literal("delete_primitives"),
    pageUuid: z.string(),
    componentIds: z.array(z.string()).default([]),
    wireIds: z.array(z.string()).default([]),
    textIds: z.array(z.string()).default([]),
  }),
  z.object({
    type: z.literal("create_component"),
    pageUuid: z.string(),
    libraryUuid: z.string(),
    deviceUuid: z.string(),
    x: z.number(),
    y: z.number(),
    rotation: rotationSchema.default(0),
    designator: z.string().optional(),
    addIntoBom: z.boolean().default(true),
    addIntoPcb: z.boolean().default(true),
  }),
  z.object({
    type: z.literal("move_component"),
    pageUuid: z.string().min(1),
    componentId: z.string().min(1),
    x: z.number(),
    y: z.number(),
  }),
  z.object({
    type: z.literal("transform_components"),
    pageUuid: z.string().min(1),
    changes: z.array(z.object({
      componentId: z.string().min(1),
      x: z.number().optional(),
      y: z.number().optional(),
      rotation: rotationSchema.optional(),
      mirror: z.boolean().optional(),
    }).refine(
      (change) => change.x !== undefined || change.y !== undefined || change.rotation !== undefined || change.mirror !== undefined,
      "Each transformation must include x, y, rotation, or mirror",
    )).min(1).max(50),
  }),
  z.object({
    type: z.literal("translate_group"),
    pageUuid: z.string().min(1),
    componentIds: z.array(z.string().min(1)).max(50).default([]),
    wireIds: z.array(z.string().min(1)).max(100).default([]),
    deltaX: z.number(),
    deltaY: z.number(),
  }),
  z.object({
    type: z.literal("create_wire"),
    pageUuid: z.string(),
    line: z.array(z.number()).min(4).refine((line) => line.length % 2 === 0, "line must contain x/y pairs"),
    net: z.string().optional(),
  }),
  z.object({
    type: z.literal("connect_pins"),
    pageUuid: z.string(),
    from: endpointSchema,
    to: endpointSchema,
    net: z.string().optional(),
    horizontalFirst: z.boolean().default(true),
  }),
  z.object({
    type: z.literal("create_net_port"),
    pageUuid: z.string(),
    direction: z.enum(["IN", "OUT", "BI"]),
    net: z.string().min(1),
    x: z.number(),
    y: z.number(),
    rotation: rotationSchema.default(0),
  }),
  z.object({
    type: z.literal("create_net_flag"),
    pageUuid: z.string(),
    identification: z.enum(["Power", "Ground", "AnalogGround", "ProtectGround"]),
    net: z.string().min(1),
    x: z.number(),
    y: z.number(),
    rotation: rotationSchema.default(0),
  }),
  z.object({
    type: z.literal("set_no_connects"),
    pageUuid: z.string().min(1),
    componentId: z.string().min(1),
    pinNumbers: z.array(z.string().min(1)).min(1).max(100),
    noConnected: z.boolean().default(true),
  }),
  z.object({
    type: z.literal("set_component_attribute"),
    pageUuid: z.string().min(1),
    componentId: z.string().min(1),
    key: z.string().min(1).max(100),
    value: z.string().max(500),
    keyVisible: z.boolean().default(false),
    valueVisible: z.boolean().default(true),
  }),
  z.object({
    type: z.literal("set_net_label"),
    pageUuid: z.string().min(1),
    labelId: z.string().min(1),
    x: z.number().optional(),
    y: z.number().optional(),
    net: z.string().min(1).max(200).optional(),
  }).refine(
    (change) => change.x !== undefined || change.y !== undefined || change.net !== undefined,
    "A net-label change must include x, y, or net",
  ),
  z.object({
    type: z.literal("create_port_for_pin"),
    pageUuid: z.string(),
    componentId: z.string().min(1),
    pinNumber: z.string().min(1),
    direction: z.enum(["IN", "OUT", "BI"]),
    net: z.string().min(1),
    offset: z.number().positive().default(40),
    axisBias: z.number().positive().default(1),
  }),
  z.object({
    type: z.literal("create_text"),
    pageUuid: z.string(),
    x: z.number(),
    y: z.number(),
    text: z.string().min(1).max(500),
    rotation: rotationSchema.default(0),
    fontSize: z.number().min(4).max(40).default(8),
    bold: z.boolean().default(false),
  }),
]);

// instructions 会随 MCP 初始化提供给客户端，说明推荐的安全调用顺序。
const server = new McpServer(
  { name: "guozili-mcp-service", version: "0.4.20" },
  {
    instructions: [
      "Inspect pages and components before proposing writes.",
      "Writes use schematic_apply_operations and execute immediately after validation.",
      "Prefer direct connect_pins wires inside one functional block.",
      "Use create_port_for_pin for cross-page connections, power rails, or genuinely long connections so the port extends outward from the pin.",
      "The first write in each MCP session automatically creates one full schematic backup; later writes reuse it.",
      "PCB synchronization is intentionally outside this MCP version.",
    ].join(" "),
  },
);

/** 同时返回人可读 JSON 文本和机器可直接消费的结构化结果。 */
function toolResult(value) {
  // MCP 的 structuredContent 顶层必须是对象；数组结果统一放入 items，文本仍保留原格式。
  const structuredContent = Array.isArray(value) ? { items: value } : value;
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent,
  };
}

/** 把异常转换成 MCP 工具错误，避免错误直接终止服务进程。 */
function toolError(error) {
  return {
    isError: true,
    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
  };
}

// 工具：检查 MCP→RPC→EasyEDA 整条链路，并读取当前编辑上下文。
server.registerTool(
  "easyeda_health",
  { description: "Check the persistent EasyEDA bridge connection and report the active project, schematic, and page." },
  async () => {
    try {
      // context 来自插件中的当前编辑器状态，connection 来自 MCP 本地网关。
      await projectCache.ensureContext();
      const context = projectCache.context;
      const connection = await bridge.status();
      return toolResult({ connection, context, cache: projectCache.status() });
    } catch (error) {
      return toolError(error);
    }
  },
);

// 工具：读取当前工程的原理图和页面目录；不要求先打开图页。
server.registerTool(
  "schematic_list_pages",
  { description: "List every schematic and page in the open EasyEDA project, even when no page is currently open." },
  async () => {
    try { return toolResult(await projectCache.getCatalog()); }
    catch (error) { return toolError(error); }
  },
);

// 工具：读取单页器件、引脚、网络及可选导线。
server.registerTool(
  "schematic_inspect_page",
  {
    description: "Read components, pins, positions, native net labels, nets, and optionally wires from one schematic page.",
    inputSchema: {
      pageUuid: z.string().min(1),
      includeWires: z.boolean().default(true),
    },
  },
  async ({ pageUuid, includeWires }) => {
    try {
      const page = await projectCache.getPage(pageUuid, { includeWires });
      return toolResult(annotatePagePinLayouts(page));
    }
    catch (error) { return toolError(error); }
  },
);

server.registerTool(
  "schematic_get_component_inventory",
  {
    description: "Read the cached project-wide component inventory, grouped by model identity or sourcing fields, to find normalization candidates and inconsistent attributes.",
    inputSchema: {
      groupBy: z.enum(["model", "equivalentSpec", "deviceUuid", "manufacturerPart", "supplierPart", "name"]).default("model"),
      includeSingletons: z.boolean().default(false),
    },
  },
  async ({ groupBy, includeSingletons }) => {
    try { return toolResult(await projectCache.getComponentInventory({ groupBy, includeSingletons })); }
    catch (error) { return toolError(error); }
  },
);

// 工具：只返回指定矩形区域内的图元，避免大页面检查结果过大而难以定位局部失败。
server.registerTool(
  "schematic_inspect_region",
  {
    description: "Read components and wires that touch a rectangular schematic region.",
    inputSchema: {
      pageUuid: z.string().min(1),
      left: z.number(),
      top: z.number(),
      right: z.number(),
      bottom: z.number(),
      includeComponents: z.boolean().default(true),
      includeWires: z.boolean().default(true),
    },
  },
  async ({ pageUuid, left, top, right, bottom, includeComponents, includeWires }) => {
    try {
      if (left > right || top > bottom) throw new Error("Invalid region bounds");
      const page = await projectCache.getPage(pageUuid, { includeWires });
      const inside = (x, y) => x >= left && x <= right && y >= top && y <= bottom;
      const components = includeComponents
        ? page.components.filter((component) => inside(component.x, component.y))
        : [];
      const wires = includeWires ? page.wires.filter((wire) => {
        for (let index = 0; index < wire.line.length; index += 2) {
          if (inside(wire.line[index], wire.line[index + 1])) return true;
        }
        return false;
      }) : [];
      return toolResult(annotatePagePinLayouts({
        page: page.page,
        region: { left, top, right, bottom },
        components,
        wires,
      }));
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "schematic_get_page_occupancy",
  {
    description: "Build or reuse a placement-aware two-dimensional occupancy grid. It reports literal geometry coverage separately from blocked placement area, including clearances, sheet border and title block.",
    inputSchema: {
      pageUuid: z.string().min(1),
      cellSize: z.number().min(2).max(50).default(5),
      componentClearance: z.number().min(0).max(200).default(10),
      portClearance: z.number().min(0).max(200).default(10),
      wireClearance: z.number().min(0).max(100).default(5),
      borderMargin: z.number().min(0).max(200).default(20),
      reserveTitleBlock: z.boolean().default(true),
      includeRows: z.boolean().default(false),
    },
  },
  async ({ pageUuid, cellSize, componentClearance, portClearance, wireClearance, borderMargin, reserveTitleBlock, includeRows }) => {
    try {
      const page = await projectCache.getPage(pageUuid, { includeWires: true });
      const grid = pageOccupancy.get(pageUuid, page, { cellSize, componentClearance, portClearance, wireClearance, borderMargin, reserveTitleBlock });
      return toolResult(grid.describe({ includeRows }));
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "schematic_find_free_regions",
  {
    description: "Find one or more empty rectangular placement regions using the cached page occupancy grid.",
    inputSchema: {
      pageUuid: z.string().min(1),
      width: z.number().positive(),
      height: z.number().positive(),
      count: z.number().int().min(1).max(50).default(1),
      clearance: z.number().min(0).max(200).default(10),
      preferredX: z.number().optional(),
      preferredY: z.number().optional(),
      cellSize: z.number().min(2).max(50).default(5),
      componentClearance: z.number().min(0).max(200).default(10),
      portClearance: z.number().min(0).max(200).default(10),
      wireClearance: z.number().min(0).max(100).default(5),
      borderMargin: z.number().min(0).max(200).default(20),
      reserveTitleBlock: z.boolean().default(true),
    },
  },
  async ({ pageUuid, width, height, count, clearance, preferredX, preferredY, cellSize, componentClearance, portClearance, wireClearance, borderMargin, reserveTitleBlock }) => {
    try {
      const page = await projectCache.getPage(pageUuid, { includeWires: true });
      const grid = pageOccupancy.get(pageUuid, page, { cellSize, componentClearance, portClearance, wireClearance, borderMargin, reserveTitleBlock });
      const regions = grid.findFreeRectangles({ width, height, count, clearance, preferredX, preferredY });
      return toolResult({ page: page.page, grid: grid.describe(), requested: { width, height, count, clearance, preferredX, preferredY }, regions });
    } catch (error) {
      return toolError(error);
    }
  },
);

// 工具：搜索 EasyEDA 器件库，为 create_component 获取稳定 UUID。
server.registerTool(
  "component_search",
  {
    description: "Search the EasyEDA device library and return stable library/device UUIDs and sourcing metadata.",
    inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(50).default(10) },
  },
  async ({ query, limit }) => {
    try { return toolResult(await bridge.call("library.searchComponents", { query, limit })); }
    catch (error) { return toolError(error); }
  },
);

// 工具：在 MCP 本地运行启发式可读性检查，不修改文档。
server.registerTool(
  "schematic_analyze_readability",
  {
    description: "Estimate human readability using port density, zero-length wires, component spacing, and wire crossings.",
    inputSchema: { pageUuid: z.string().min(1) },
  },
  async ({ pageUuid }) => {
    try {
      // 可读性分析运行在 MCP 侧，所以先向插件读取完整页面数据。
      const page = await projectCache.getPage(pageUuid, { includeWires: true });
      return toolResult(analyzeReadability(page));
    } catch (error) {
      return toolError(error);
    }
  },
);

// 工具：校验后直接执行白名单操作；当前会话首次写入时由插件自动备份一次。
server.registerTool(
  "schematic_apply_operations",
  {
    description: "Validate and immediately apply EasyEDA operations. The first write in this MCP session creates one schematic backup automatically.",
    inputSchema: {
      operations: z.array(operationSchema).min(1).max(100),
      reason: z.string().min(1).max(500),
    },
  },
  async ({ operations, reason }) => {
    return executeOperations(operations, reason);
  },
);

/**
 * 所有写工具共用的唯一执行入口。
 * MCP 侧逐条调用插件可避开 EasyEDA 连续创建图元时的竞态，同时仍复用同一会话备份。
 */
async function executeOperations(operations, reason) {
  const affectedPageUuids = [...new Set(operations.map((operation) => operation.pageUuid).filter(Boolean))];
  try {
    return await writes.serialize(async (sessionId) => {
      const { expandedOperations, pinPortPlans } = await expandPinPortOperations(operations);
      const validation = await bridge.call("operations.validate", { operations: expandedOperations });
      if (!validation?.valid) {
        throw new Error(`Operation preflight failed: ${JSON.stringify(validation?.findings || [])}`);
      }
      const results = [];
      let schematicUuid;
      let backupUuid;
      let backupCreated = false;

      for (let index = 0; index < expandedOperations.length; index += 1) {
        const operation = expandedOperations[index];
        const applied = await bridge.call("operations.apply", {
          sessionId,
          reason,
          operations: [operation],
        });
        schematicUuid = applied.schematicUuid;
        backupUuid = applied.backupUuid;
        backupCreated ||= applied.backupCreated === true;
        for (const item of applied.results || []) results.push({ ...item, index });
      }

      return toolResult({
        sessionId,
        reason,
        summary: summarizeOperations(operations),
        appliedSummary: summarizeOperations(expandedOperations),
        pinPortPlans,
        success: true,
        schematicUuid,
        backupUuid,
        backupCreated,
        results,
      });
    });
  } catch (error) {
    return toolError(error);
  } finally {
    pageOccupancy.invalidate(affectedPageUuids);
    const changesCatalog = operations.some((operation) => operation.type === "delete_page" || operation.type === "rename_page" || operation.type === "rename_schematic");
    try {
      if (changesCatalog) await projectCache.rebuildCatalog();
      else await projectCache.refreshPages(affectedPageUuids);
    } catch {
      projectCache.clear();
    }
  }
}

/** 注册一个把简洁参数转换成白名单 operation 的直接写工具。 */
function registerWriteTool(name, description, inputSchema, buildOperations) {
  server.registerTool(name, { description, inputSchema }, async (args) =>
    executeOperations(buildOperations(args), args.reason));
}

registerWriteTool(
  "schematic_rename_schematic",
  "Rename one schematic document by UUID. This changes the schematic name, not its individual page names.",
  { schematicUuid: z.string().min(1), name: z.string().min(1).max(80), reason: z.string().min(1).max(500).default("Rename schematic document") },
  ({ schematicUuid, name }) => [{ type: "rename_schematic", schematicUuid, name }],
);

registerWriteTool(
  "schematic_rename_page",
  "Rename one schematic page directly.",
  { pageUuid: z.string().min(1), name: z.string().min(1).max(80), reason: z.string().min(1).max(500).default("重命名原理图页") },
  ({ pageUuid, name }) => [{ type: "rename_page", pageUuid, name }],
);

registerWriteTool(
  "schematic_delete_page",
  "Delete one schematic page; the only remaining page cannot be deleted.",
  { pageUuid: z.string().min(1), reason: z.string().min(1).max(500).default("删除原理图页") },
  ({ pageUuid }) => [{ type: "delete_page", pageUuid }],
);

registerWriteTool(
  "schematic_delete_primitives",
  "Delete components, wires, and free-text annotations by primitive ID.",
  {
    pageUuid: z.string().min(1),
    componentIds: z.array(z.string().min(1)).default([]),
    wireIds: z.array(z.string().min(1)).default([]),
    textIds: z.array(z.string().min(1)).default([]),
    reason: z.string().min(1).max(500).default("删除原理图图元"),
  },
  ({ pageUuid, componentIds, wireIds, textIds }) => [{ type: "delete_primitives", pageUuid, componentIds, wireIds, textIds }],
);

registerWriteTool(
  "schematic_update_net_labels",
  "Move and/or rename native EasyEDA net labels by primitive ID. Inspect the page first and place each label exactly on its intended wire endpoint or segment.",
  {
    pageUuid: z.string().min(1),
    changes: z.array(z.object({
      labelId: z.string().min(1),
      x: z.number().optional(),
      y: z.number().optional(),
      net: z.string().min(1).max(200).optional(),
    }).refine(
      (change) => change.x !== undefined || change.y !== undefined || change.net !== undefined,
      "Each net-label change must include x, y, or net",
    )).min(1).max(100),
    reason: z.string().min(1).max(500).default("Move or rename native net labels"),
  },
  ({ pageUuid, changes }) => changes.map((change) => ({ type: "set_net_label", pageUuid, ...change })),
);

registerWriteTool(
  "schematic_place_components",
  "Place one or more library components. Use component_search UUIDs and finish placement before wiring.",
  {
    pageUuid: z.string().min(1),
    components: z.array(z.object({
      libraryUuid: z.string().min(1), deviceUuid: z.string().min(1),
      x: z.number(), y: z.number(), rotation: rotationSchema.default(0),
      designator: z.string().optional(), addIntoBom: z.boolean().default(true), addIntoPcb: z.boolean().default(true),
    })).min(1).max(50),
    reason: z.string().min(1).max(500).default("批量放置原理图器件"),
  },
  ({ pageUuid, components }) => components.map((component) => ({ type: "create_component", pageUuid, ...component })),
);

registerWriteTool(
  "schematic_move_components",
  "Move one or more existing part components to absolute schematic coordinates. Inspect the page first to obtain primitive IDs.",
  {
    pageUuid: z.string().min(1),
    movements: z.array(z.object({
      componentId: z.string().min(1),
      x: z.number(),
      y: z.number(),
    })).min(1).max(50),
    reason: z.string().min(1).max(500).default("移动既有原理图器件"),
  },
  ({ pageUuid, movements }) => movements.map((movement) => ({ type: "move_component", pageUuid, ...movement })),
);

registerWriteTool(
  "schematic_transform_components",
  "Move, rotate, and/or mirror existing part components. Omitted fields keep their current values. Returns before/after component and pin coordinates; wires are not modified automatically.",
  {
    pageUuid: z.string().min(1),
    changes: z.array(z.object({
      componentId: z.string().min(1),
      x: z.number().optional(),
      y: z.number().optional(),
      rotation: rotationSchema.optional(),
      mirror: z.boolean().optional(),
    }).refine(
      (change) => change.x !== undefined || change.y !== undefined || change.rotation !== undefined || change.mirror !== undefined,
      "Each transformation must include x, y, rotation, or mirror",
    )).min(1).max(50),
    reason: z.string().min(1).max(500).default("批量移动、旋转或镜像已有器件"),
  },
  ({ pageUuid, changes }) => [{ type: "transform_components", pageUuid, changes }],
);

registerWriteTool(
  "schematic_move_components_with_wires",
  "Translate selected existing part components and complete wire polylines together by one delta. Only explicitly listed wires are moved.",
  {
    pageUuid: z.string().min(1),
    componentIds: z.array(z.string().min(1)).max(50).default([]),
    wireIds: z.array(z.string().min(1)).max(100).default([]),
    deltaX: z.number(),
    deltaY: z.number(),
    reason: z.string().min(1).max(500).default("成组移动既有器件和导线"),
  },
  ({ pageUuid, componentIds, wireIds, deltaX, deltaY }) => {
    if (componentIds.length === 0 && wireIds.length === 0) throw new Error("At least one componentId or wireId is required");
    if (deltaX === 0 && deltaY === 0) throw new Error("deltaX and deltaY cannot both be zero");
    return [{ type: "translate_group", pageUuid, componentIds, wireIds, deltaX, deltaY }];
  },
);

registerWriteTool(
  "schematic_create_wires",
  "Create direct named wires. A net name can be assigned without placing a net port or label first.",
  {
    pageUuid: z.string().min(1),
    wires: z.array(z.object({
      line: z.array(z.number()).min(4).refine((line) => line.length % 2 === 0, "line must contain x/y pairs"),
      net: z.string().optional(),
    })).min(1).max(100),
    reason: z.string().min(1).max(500).default("创建原理图直接导线"),
  },
  ({ pageUuid, wires }) => wires.map((wire) => ({ type: "create_wire", pageUuid, ...wire })),
);

registerWriteTool(
  "schematic_connect_pin_pairs",
  "Connect component pin pairs with a straight line or one orthogonal bend.",
  {
    pageUuid: z.string().min(1),
    connections: z.array(z.object({
      from: endpointSchema, to: endpointSchema, net: z.string().optional(), horizontalFirst: z.boolean().default(true),
    })).min(1).max(50),
    reason: z.string().min(1).max(500).default("连接器件引脚"),
  },
  ({ pageUuid, connections }) => connections.map((connection) => ({ type: "connect_pins", pageUuid, ...connection })),
);

registerWriteTool(
  "schematic_create_net_flags",
  "Create standard power, ground, analog-ground, or protection-ground flags.",
  {
    pageUuid: z.string().min(1),
    flags: z.array(z.object({
      identification: z.enum(["Power", "Ground", "AnalogGround", "ProtectGround"]),
      net: z.string().min(1), x: z.number(), y: z.number(), rotation: rotationSchema.default(0),
    })).min(1).max(50),
    reason: z.string().min(1).max(500).default("创建标准网络标志"),
  },
  ({ pageUuid, flags }) => flags.map((flag) => ({ type: "create_net_flag", pageUuid, ...flag })),
);

registerWriteTool(
  "schematic_create_ports_for_pins",
  "Create outward-facing ports using rectangular symbol/label bounds and obstacle-aware orthogonal routing. Existing components, wires, and earlier ports in the same batch are avoided. Reserve for cross-page or genuinely long connections.",
  {
    pageUuid: z.string().min(1),
    ports: z.array(z.object({
      componentId: z.string().min(1), pinNumber: z.string().min(1), direction: z.enum(["IN", "OUT", "BI"]),
      net: z.string().min(1), offset: z.number().positive().default(40), axisBias: z.number().positive().default(1),
    })).min(1).max(40),
    reason: z.string().min(1).max(500).default("按引脚朝向创建跨页端口"),
  },
  ({ pageUuid, ports }) => ports.map((port) => ({ type: "create_port_for_pin", pageUuid, ...port })),
);

registerWriteTool(
  "schematic_set_no_connects",
  "Set or clear native EasyEDA no-connect markers on one or more component pins. Inspect the page first and use this only for intentionally unused pins.",
  {
    pageUuid: z.string().min(1),
    changes: z.array(z.object({
      componentId: z.string().min(1),
      pinNumbers: z.array(z.string().min(1)).min(1).max(100),
      noConnected: z.boolean().default(true),
    })).min(1).max(50),
    reason: z.string().min(1).max(500).default("设置原理图引脚非连接标识"),
  },
  ({ pageUuid, changes }) => changes.map((change) => ({ type: "set_no_connects", pageUuid, ...change })),
);

registerWriteTool(
  "schematic_set_component_attributes",
  "Write real EasyEDA component attributes such as Value and control their native schematic visibility. This updates BOM/property data; it does not create free text.",
  {
    pageUuid: z.string().min(1),
    changes: z.array(z.object({
      componentId: z.string().min(1),
      key: z.string().min(1).max(100),
      value: z.string().max(500),
      keyVisible: z.boolean().default(false),
      valueVisible: z.boolean().default(true),
    })).min(1).max(100),
    reason: z.string().min(1).max(500).default("修改器件原生属性"),
  },
  ({ pageUuid, changes }) => changes.map((change) => ({ type: "set_component_attribute", pageUuid, ...change })),
);

registerWriteTool(
  "schematic_create_texts",
  "Create one or more human-readable schematic annotations.",
  {
    pageUuid: z.string().min(1),
    texts: z.array(z.object({
      x: z.number(), y: z.number(), text: z.string().min(1).max(500), rotation: rotationSchema.default(0),
      fontSize: z.number().min(4).max(40).default(8), bold: z.boolean().default(false),
    })).min(1).max(50),
    reason: z.string().min(1).max(500).default("创建原理图文字标注"),
  },
  ({ pageUuid, texts }) => texts.map((item) => ({ type: "create_text", pageUuid, ...item })),
);

/**
 * 把按引脚放置端口的高层操作展开为插件已经支持的“端口 + 导线”原子操作。
 * 页面数据按 pageUuid 缓存一次，保证同一批操作采用一致的引脚几何快照。
 */
async function expandPinPortOperations(operations) {
  const pageCache = new Map();
  const occupancyCache = new Map();
  const expandedOperations = [];
  const pinPortPlans = [];

  for (const operation of operations) {
    if (operation.type !== "create_port_for_pin") {
      expandedOperations.push(operation);
      continue;
    }

    let page = pageCache.get(operation.pageUuid);
    if (!page) {
      page = await bridge.call("schematic.inspectPage", { pageUuid: operation.pageUuid, includeWires: true });
      pageCache.set(operation.pageUuid, page);
    }
    let occupancy = occupancyCache.get(operation.pageUuid);
    if (!occupancy) {
      occupancy = pageOccupancy.get(operation.pageUuid, page);
      occupancyCache.set(operation.pageUuid, occupancy);
    }
    const component = page.components?.find((item) => item.id === operation.componentId);
    if (!component) throw new Error(`Component not found: ${operation.componentId}`);
    if (component.type !== "part") {
      throw new Error(`create_port_for_pin requires a part component: ${operation.componentId}`);
    }
    const plan = planPortForPin(component, operation.pinNumber, {
      offset: operation.offset,
      axisBias: operation.axisBias,
      obstacles: page,
      net: operation.net,
      direction: operation.direction,
      occupancy,
    });

    // 插件侧将端口与导线作为一个可补偿操作：端口实测矩形冲突或画线失败时会删除已创建图元。
    expandedOperations.push({
      type: "create_port_with_wire",
      pageUuid: operation.pageUuid,
      sourceComponentId: operation.componentId,
      direction: operation.direction,
      net: operation.net,
      x: plan.port.x,
      y: plan.port.y,
      rotation: plan.port.rotation,
      line: plan.line,
      expectedBounds: plan.portBounds,
    });
    pinPortPlans.push({ net: operation.net, ...plan });

    // Keep the geometry snapshot current so later ports in this batch avoid earlier planned ports and wires.
    page.components.push({
      id: `planned-port-${pinPortPlans.length}`,
      type: "netport",
      x: plan.port.x,
      y: plan.port.y,
      bbox: plan.portBounds,
      pins: [{ number: "1", x: plan.port.x, y: plan.port.y }],
    });
    page.wires.push({ id: `planned-wire-${pinPortPlans.length}`, net: operation.net, line: plan.line });
    occupancy.markBounds(plan.portBounds, OCCUPANCY.PORT | OCCUPANCY.PLANNED);
    occupancy.markPolyline(plan.line, OCCUPANCY.WIRE | OCCUPANCY.PLANNED);
  }
  if (expandedOperations.length > 100) {
    throw new Error(`Expanded operation count ${expandedOperations.length} exceeds the plugin limit of 100`);
  }
  return { expandedOperations, pinPortPlans };
}

// 工具：调用 EasyEDA 自带原理图 DRC。
server.registerTool(
  "schematic_run_drc",
  {
    description: "Run strict schematic DRC on a page. EasyEDA may return only aggregate counts in some versions.",
    inputSchema: { pageUuid: z.string().min(1) },
  },
  async ({ pageUuid }) => {
    try { return toolResult(await bridge.call("schematic.runDrc", { pageUuid })); }
    catch (error) { return toolError(error); }
  },
);

// MCP 协议走 stdin/stdout；日志必须写 stderr，不能污染协议帧。
const transport = new StdioServerTransport();
await server.connect(transport);

// 正常退出时主动关闭 WebSocket，通知 EasyEDA 插件进入重连状态。
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    bridge.close();
    process.exit(0);
  });
}
