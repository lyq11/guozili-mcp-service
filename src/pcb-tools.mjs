import { compareSchematicToPcb, findComponentOverlaps, findOutsideComponents, findUnroutedNets, inspectWholeBoard } from "./pcb-analysis.mjs";

export function registerPcbTools({ server, z, bridge, writes, projectCache, pcbCache, toolResult, toolError }) {
  const transform = z.object({
    componentId: z.string().min(1), x: z.number().optional(), y: z.number().optional(),
    rotation: z.number().optional(), locked: z.boolean().optional(),
  }).refine((item) => item.x !== undefined || item.y !== undefined || item.rotation !== undefined || item.locked !== undefined,
    "Each transformation must include x, y, rotation, or locked");
  const track = z.object({ net: z.string().min(1), layer: z.number().int(), startX: z.number(), startY: z.number(), endX: z.number(), endY: z.number(), width: z.number().positive(), locked: z.boolean().default(false) });
  const via = z.object({ net: z.string().min(1), x: z.number(), y: z.number(), holeDiameter: z.number().positive(), diameter: z.number().positive(), viaType: z.number().int().optional(), locked: z.boolean().default(false) });
  const pour = z.object({ net: z.string().min(1), layer: z.number().int(), polygon: z.array(z.union([z.string(), z.number()])).min(4), width: z.number().positive(), fillMethod: z.number().int().optional(), preserveSilos: z.boolean().default(true), name: z.string().min(1).max(100).optional(), priority: z.number().int().optional(), locked: z.boolean().default(false) });
  const operation = z.discriminatedUnion("type", [
    z.object({ type: z.literal("transform_components"), pcbUuid: z.string().min(1), changes: z.array(transform).min(1).max(100) }),
    z.object({ type: z.literal("create_track"), pcbUuid: z.string().min(1), ...track.shape }),
    z.object({ type: z.literal("create_via"), pcbUuid: z.string().min(1), ...via.shape }),
    z.object({ type: z.literal("create_pour"), pcbUuid: z.string().min(1), ...pour.shape }),
    z.object({ type: z.literal("rebuild_pours"), pcbUuid: z.string().min(1), pourIds: z.array(z.string().min(1)).max(100).default([]) }),
    z.object({ type: z.literal("import_schematic_changes"), pcbUuid: z.string().min(1), schematicUuid: z.string().min(1).optional() }),
  ]);

  async function execute(operations, reason) {
    try {
      return await writes.serialize(async (sessionId) => {
        const validation = await bridge.call("pcb.operations.validate", { operations });
        if (!validation?.valid) throw new Error(`PCB operation preflight failed: ${JSON.stringify(validation?.findings || [])}`);
        const applied = await bridge.call("pcb.operations.apply", { sessionId, reason, operations });
        return toolResult({ sessionId, reason, operationCount: operations.length, ...applied });
      });
    } catch (error) { return toolError(error); }
    finally {
      try { await pcbCache.refresh(); } catch { pcbCache.clear(); }
    }
  }

  server.registerTool("pcb_list_boards", {
    description: "List PCB Boards and identify the PCB cached for the [main] schematic. Backup PCBs are never selected.",
  }, async () => {
    try { return toolResult({ catalog: await pcbCache.getCatalog(), active: pcbCache.status() }); }
    catch (error) { return toolError(error); }
  });

  server.registerTool("pcb_inspect", {
    description: "Read the cached [main] PCB: board outline, layers, stackup, footprints, pads, nets, tracks, vias, pours, regions, and design rules.",
    inputSchema: { refresh: z.boolean().default(false) },
  }, async ({ refresh }) => {
    try { return toolResult(await pcbCache.getSnapshot({ refresh })); }
    catch (error) { return toolError(error); }
  });

  server.registerTool("pcb_inspect_region", {
    description: "Read PCB primitives inside or touching a local rectangular region. Coordinates are mil.",
    inputSchema: { pcbUuid: z.string().min(1), left: z.number(), right: z.number(), top: z.number(), bottom: z.number(), fullyContained: z.boolean().default(false) },
  }, async (args) => {
    try { return toolResult(await bridge.call("pcb.inspectRegion", args)); }
    catch (error) { return toolError(error); }
  });

  server.registerTool("pcb_check", {
    description: "Run cached whole-board checks for component overlap, outside-board placement, and unrouted nets.",
    inputSchema: { refresh: z.boolean().default(false), clearance: z.number().min(0).default(0), tolerance: z.number().positive().default(0.5) },
  }, async ({ refresh, clearance, tolerance }) => {
    try { return toolResult(inspectWholeBoard(await pcbCache.getSnapshot({ refresh }), { clearance, tolerance })); }
    catch (error) { return toolError(error); }
  });

  server.registerTool("pcb_find_unrouted_nets", {
    description: "Find nets whose PCB pads are split into multiple straight-track/via connectivity groups.",
    inputSchema: { refresh: z.boolean().default(false), tolerance: z.number().positive().default(0.5) },
  }, async ({ refresh, tolerance }) => {
    try { return toolResult(findUnroutedNets(await pcbCache.getSnapshot({ refresh }), { tolerance })); }
    catch (error) { return toolError(error); }
  });

  server.registerTool("pcb_check_component_overlaps", {
    description: "Check cached footprint bounding boxes for same-side overlap.",
    inputSchema: { refresh: z.boolean().default(false), clearance: z.number().min(0).default(0) },
  }, async ({ refresh, clearance }) => {
    try {
      const overlaps = findComponentOverlaps(await pcbCache.getSnapshot({ refresh }), { clearance });
      return toolResult({ overlapCount: overlaps.length, overlaps, clearance, unit: "mil" });
    } catch (error) { return toolError(error); }
  });

  server.registerTool("pcb_check_outside_components", {
    description: "Check footprint bounding boxes against the cached board-outline bounds.",
    inputSchema: { refresh: z.boolean().default(false), margin: z.number().min(0).default(0) },
  }, async ({ refresh, margin }) => {
    try { return toolResult(findOutsideComponents(await pcbCache.getSnapshot({ refresh }), { margin })); }
    catch (error) { return toolError(error); }
  });

  server.registerTool("pcb_check_schematic_consistency", {
    description: "Compare [main] schematic and PCB designators, footprints, BOM sourcing models, and net names; report duplicates and missing footprints before synchronization.",
    inputSchema: { refresh: z.boolean().default(false) },
  }, async ({ refresh }) => {
    try {
      const [components, pcb] = await Promise.all([projectCache.getComponents(), pcbCache.getSnapshot({ refresh })]);
      return toolResult(compareSchematicToPcb(components, pcb));
    } catch (error) { return toolError(error); }
  });

  server.registerTool("pcb_run_drc", {
    description: "Run EasyEDA strict PCB DRC and report findings without modifying the board.",
    inputSchema: { pcbUuid: z.string().min(1) },
  }, async ({ pcbUuid }) => {
    try { return toolResult(await bridge.call("pcb.runDrc", { pcbUuid })); }
    catch (error) { return toolError(error); }
  });

  server.registerTool("pcb_apply_operations", {
    description: "Validate and apply explicit PCB operations. The first PCB write in this MCP session creates one detached [backup] PCB.",
    inputSchema: { operations: z.array(operation).min(1).max(100), reason: z.string().min(1).max(500) },
  }, async ({ operations, reason }) => execute(operations, reason));

  server.registerTool("pcb_transform_components", {
    description: "Move, rotate, and/or lock PCB footprints as one layout group. Omitted fields retain current values.",
    inputSchema: { pcbUuid: z.string().min(1), changes: z.array(transform).min(1).max(100), reason: z.string().min(1).max(500).default("Move, rotate, or lock PCB footprints") },
  }, async ({ pcbUuid, changes, reason }) => execute([{ type: "transform_components", pcbUuid, changes }], reason));

  server.registerTool("pcb_create_tracks", {
    description: "Create straight track segments with explicit net, copper layer, and width. No width defaults are inferred.",
    inputSchema: { pcbUuid: z.string().min(1), tracks: z.array(track).min(1).max(100), reason: z.string().min(1).max(500).default("Create PCB tracks") },
  }, async ({ pcbUuid, tracks, reason }) => execute(tracks.map((item) => ({ type: "create_track", pcbUuid, ...item })), reason));

  server.registerTool("pcb_create_vias", {
    description: "Create vias with explicit net, hole diameter, and outer diameter. No via-rule defaults are inferred.",
    inputSchema: { pcbUuid: z.string().min(1), vias: z.array(via).min(1).max(100), reason: z.string().min(1).max(500).default("Create PCB vias") },
  }, async ({ pcbUuid, vias, reason }) => execute(vias.map((item) => ({ type: "create_via", pcbUuid, ...item })), reason));

  server.registerTool("pcb_create_pours", {
    description: "Create copper pours using EasyEDA polygon-source arrays and explicit net, layer, and boundary width.",
    inputSchema: { pcbUuid: z.string().min(1), pours: z.array(pour).min(1).max(50), reason: z.string().min(1).max(500).default("Create PCB copper pours") },
  }, async ({ pcbUuid, pours, reason }) => execute(pours.map((item) => ({ type: "create_pour", pcbUuid, ...item })), reason));

  server.registerTool("pcb_rebuild_pours", {
    description: "Rebuild all or selected copper pours after reporting/inspection.",
    inputSchema: { pcbUuid: z.string().min(1), pourIds: z.array(z.string().min(1)).max(100).default([]), reason: z.string().min(1).max(500).default("Rebuild PCB copper pours") },
  }, async ({ pcbUuid, pourIds, reason }) => execute([{ type: "rebuild_pours", pcbUuid, pourIds }], reason));

  server.registerTool("pcb_fix_deterministic", {
    description: "Run PCB DRC, rebuild all or selected copper pours as the currently supported deterministic repair, then run DRC again. Electrical dimensions and rules are never changed.",
    inputSchema: { pcbUuid: z.string().min(1), pourIds: z.array(z.string().min(1)).max(100).default([]), reason: z.string().min(1).max(500).default("Rebuild copper pours after PCB DRC") },
  }, async ({ pcbUuid, pourIds, reason }) => {
    try {
      return await writes.serialize(async (sessionId) => {
        const before = await bridge.call("pcb.runDrc", { pcbUuid });
        const operations = [{ type: "rebuild_pours", pcbUuid, pourIds }];
        const validation = await bridge.call("pcb.operations.validate", { operations });
        if (!validation?.valid) throw new Error(`PCB operation preflight failed: ${JSON.stringify(validation?.findings || [])}`);
        const applied = await bridge.call("pcb.operations.apply", { sessionId, reason, operations });
        const after = await bridge.call("pcb.runDrc", { pcbUuid });
        return toolResult({ sessionId, reason, deterministicFixes: ["rebuild_pours"], before, applied, after });
      });
    } catch (error) { return toolError(error); }
    finally { try { await pcbCache.refresh(); } catch { pcbCache.clear(); } }
  });

  server.registerTool("pcb_sync_from_schematic", {
    description: "Import component, designator, footprint, net, and BOM-model changes from the associated [main] schematic into its PCB. Run the consistency check first.",
    inputSchema: { pcbUuid: z.string().min(1), schematicUuid: z.string().min(1).optional(), reason: z.string().min(1).max(500).default("Synchronize PCB from [main] schematic") },
  }, async ({ pcbUuid, schematicUuid, reason }) => execute([{ type: "import_schematic_changes", pcbUuid, schematicUuid }], reason));
}
