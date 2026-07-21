import {
  checkBoardOutline, compareSchematicToPcb, findBoardOutline, findComponentOverlaps,
  findDanglingTracks, findOutsideComponents, findUnroutedNets, inspectWholeBoard,
  planComponentsBySchematicPage,
} from "./pcb-analysis.mjs";
import { planComponentArrangement } from "./pcb-layout.mjs";
import { planNetTrackPolicy } from "./pcb-policy.mjs";

function addSchematicPageLabels(snapshot, schematicComponents) {
  const pagesByDesignator = new Map();
  for (const component of schematicComponents || []) {
    const designator = String(component?.designator || "").trim().toUpperCase();
    if (!designator) continue;
    const page = component.pageUuid || component.pageName
      ? { uuid: component.pageUuid || null, name: component.pageName || null }
      : null;
    if (!pagesByDesignator.has(designator)) pagesByDesignator.set(designator, page);
    else {
      const existing = pagesByDesignator.get(designator);
      if (existing?.uuid !== page?.uuid || existing?.name !== page?.name) pagesByDesignator.set(designator, null);
    }
  }
  return {
    ...snapshot,
    components: (snapshot?.components || []).map((component) => ({
      ...component,
      schematicPage: pagesByDesignator.get(String(component?.designator || "").trim().toUpperCase()) || null,
    })),
  };
}

export function registerPcbTools({ server, z, bridge, writes, projectCache, pcbCache, toolResult, toolError }) {
  const transform = z.object({
    componentId: z.string().min(1), x: z.number().optional(), y: z.number().optional(),
    rotation: z.number().optional(), locked: z.boolean().optional(),
  }).refine((item) => item.x !== undefined || item.y !== undefined || item.rotation !== undefined || item.locked !== undefined,
    "Each transformation must include x, y, rotation, or locked");
  const track = z.object({ net: z.string().min(1), layer: z.number().int(), startX: z.number(), startY: z.number(), endX: z.number(), endY: z.number(), width: z.number().positive(), locked: z.boolean().default(false) });
  const via = z.object({ net: z.string().min(1), x: z.number(), y: z.number(), holeDiameter: z.number().positive(), diameter: z.number().positive(), viaType: z.number().int().optional(), locked: z.boolean().default(false) });
  const point = z.object({ x: z.number(), y: z.number() });
  const boardOutline = z.discriminatedUnion("type", [
    z.object({
      type: z.literal("rectangle"), x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive(),
      cornerRadius: z.number().min(0).default(0), lineWidth: z.number().positive().default(1), locked: z.boolean().default(false),
    }).refine((item) => item.cornerRadius <= Math.min(item.width, item.height) / 2, "Rectangle cornerRadius cannot exceed half its shortest side"),
    z.object({
      type: z.literal("polygon"), points: z.array(point).min(2).max(100), closed: z.boolean().default(true),
      cornerRadius: z.number().min(0).default(0), lineWidth: z.number().positive().default(1), locked: z.boolean().default(false),
    }).superRefine((item, context) => {
      if (item.closed && item.points.length < 3) context.addIssue({ code: "custom", message: "A closed polygon requires at least 3 points" });
      if (!item.closed && item.cornerRadius > 0) context.addIssue({ code: "custom", message: "An open repair path cannot use cornerRadius" });
    }),
  ]);
  const trackChange = z.object({
    trackId: z.string().min(1), width: z.number().positive().optional(), layer: z.number().int().optional(),
    net: z.string().min(1).optional(), locked: z.boolean().optional(),
  }).refine((item) => item.width !== undefined || item.layer !== undefined || item.net !== undefined || item.locked !== undefined,
    "Each track change must include width, layer, net, or locked");
  const viaChange = z.object({
    viaId: z.string().min(1), x: z.number().optional(), y: z.number().optional(),
    holeDiameter: z.number().positive().optional(), diameter: z.number().positive().optional(), viaType: z.number().int().optional(),
    net: z.string().min(1).optional(), locked: z.boolean().optional(),
  }).refine((item) => item.x !== undefined || item.y !== undefined || item.holeDiameter !== undefined || item.diameter !== undefined
    || item.viaType !== undefined || item.net !== undefined || item.locked !== undefined,
  "Each via change must include x, y, holeDiameter, diameter, viaType, net, or locked");
  const copperLayerCount = z.union([2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32].map(value => z.literal(value)));
  const stackupSettings = z.object({
    copperLayerCount: copperLayerCount.optional(),
    physicalStackingConfigurationName: z.string().min(1).optional(),
    physicalStackingConfiguration: z.record(z.string(), z.unknown()).optional(),
    layerNames: z.array(z.object({ layer: z.number().int(), name: z.string().min(1).max(80) })).max(30).optional(),
    innerLayerNames: z.array(z.string().min(1).max(80)).max(30).optional(),
  }).superRefine((item, context) => {
    if (item.physicalStackingConfigurationName !== undefined && item.physicalStackingConfiguration !== undefined) context.addIssue({ code: "custom", message: "Use either a named or raw physical stackup configuration, not both" });
    if (item.copperLayerCount !== undefined && (item.physicalStackingConfigurationName !== undefined || item.physicalStackingConfiguration !== undefined)) context.addIssue({ code: "custom", message: "Use either copperLayerCount or a physical stackup configuration, not both" });
    if (item.layerNames?.length && item.innerLayerNames?.length) context.addIssue({ code: "custom", message: "Use either explicit layerNames or ordered innerLayerNames, not both" });
    if (item.copperLayerCount === undefined && item.physicalStackingConfigurationName === undefined && item.physicalStackingConfiguration === undefined && !item.layerNames?.length && !item.innerLayerNames?.length) context.addIssue({ code: "custom", message: "Stackup settings must include at least one change" });
  });
  const arrangement = z.discriminatedUnion("type", [
    z.object({ type: z.literal("align"), mode: z.enum(["left", "right", "top", "bottom", "centerX", "centerY"]) }),
    z.object({ type: z.literal("distribute"), axis: z.enum(["horizontal", "vertical"]), gap: z.number().min(0).optional() }),
    z.object({ type: z.literal("snap_to_grid"), gridX: z.number().positive(), gridY: z.number().positive(), originX: z.number().default(0), originY: z.number().default(0) }),
  ]);
  const padShape = z.discriminatedUnion("type", [
    z.object({ type: z.enum(["ELLIPSE", "OVAL"]), width: z.number().positive(), height: z.number().positive() }),
    z.object({ type: z.literal("RECT"), width: z.number().positive(), height: z.number().positive(), roundRadius: z.number().min(0) }),
    z.object({ type: z.literal("NGON"), diameter: z.number().positive(), sides: z.number().int().min(3) }),
  ]);
  const padHole = z.discriminatedUnion("type", [
    z.object({ type: z.literal("NONE") }),
    z.object({ type: z.literal("ROUND"), diameter: z.number().positive() }),
    z.object({ type: z.literal("SLOT"), diameter: z.number().positive(), length: z.number().positive() }),
  ]);
  const pad = z.object({
    net: z.string(), layer: z.union([z.literal(1), z.literal(2), z.literal(12)]), padNumber: z.string().min(1),
    x: z.number(), y: z.number(), rotation: z.number(), shape: padShape, hole: padHole,
    holeOffsetX: z.number().default(0), holeOffsetY: z.number().default(0), holeRotation: z.number().default(0),
    metallized: z.boolean(), padType: z.union([z.literal(0), z.literal(1), z.literal(2)]), locked: z.boolean().default(false),
  }).superRefine((item, context) => {
    if (item.layer === 12 && item.hole.type === "NONE") context.addIssue({ code: "custom", message: "Multi-layer pads require an explicit ROUND or SLOT hole" });
    if (item.layer !== 12 && item.hole.type !== "NONE") context.addIssue({ code: "custom", message: "Top/bottom SMD pads must use hole.type NONE" });
    if (item.hole.type === "SLOT" && item.hole.length < item.hole.diameter) context.addIssue({ code: "custom", message: "Slot length must be at least its diameter" });
  });
  const pour = z.object({ net: z.string().min(1), layer: z.number().int(), polygon: z.array(z.union([z.string(), z.number()])).min(4), width: z.number().positive(), fillMethod: z.number().int().optional(), preserveSilos: z.boolean().default(true), name: z.string().min(1).max(100).optional(), priority: z.number().int().optional(), locked: z.boolean().default(false) });
  // One entry per PCB operation type, colocated with the rest of that operation's schema pieces
  // above. Adding an operation means adding one entry here; the discriminated union below is
  // derived from this array instead of being assembled by hand.
  const PCB_OPERATION_SCHEMAS = [
    { type: "transform_components", schema: z.object({ type: z.literal("transform_components"), pcbUuid: z.string().min(1), changes: z.array(transform).min(1).max(100) }) },
    { type: "create_board_outline", schema: z.object({ type: z.literal("create_board_outline"), pcbUuid: z.string().min(1), outline: boardOutline }) },
    { type: "delete_board_outline", schema: z.object({ type: z.literal("delete_board_outline"), pcbUuid: z.string().min(1), primitiveIds: z.array(z.string().min(1)).max(2000).default([]), deleteAll: z.boolean().default(false) }) },
    { type: "replace_board_outline", schema: z.object({ type: z.literal("replace_board_outline"), pcbUuid: z.string().min(1), outline: boardOutline }) },
    { type: "create_track", schema: z.object({ type: z.literal("create_track"), pcbUuid: z.string().min(1), ...track.shape }) },
    { type: "create_via", schema: z.object({ type: z.literal("create_via"), pcbUuid: z.string().min(1), ...via.shape }) },
    { type: "modify_tracks", schema: z.object({ type: z.literal("modify_tracks"), pcbUuid: z.string().min(1), changes: z.array(trackChange).min(1).max(100) }) },
    { type: "modify_vias", schema: z.object({ type: z.literal("modify_vias"), pcbUuid: z.string().min(1), changes: z.array(viaChange).min(1).max(100) }) },
    { type: "set_stackup", schema: z.object({ type: z.literal("set_stackup"), pcbUuid: z.string().min(1), ...stackupSettings.shape }) },
    { type: "create_pad", schema: z.object({ type: z.literal("create_pad"), pcbUuid: z.string().min(1), ...pad.shape }) },
    { type: "create_pour", schema: z.object({ type: z.literal("create_pour"), pcbUuid: z.string().min(1), ...pour.shape }) },
    { type: "delete_tracks", schema: z.object({ type: z.literal("delete_tracks"), pcbUuid: z.string().min(1), trackIds: z.array(z.string().min(1)).min(1).max(2000) }) },
    { type: "rebuild_pours", schema: z.object({ type: z.literal("rebuild_pours"), pcbUuid: z.string().min(1), pourIds: z.array(z.string().min(1)).max(100).default([]) }) },
    { type: "import_schematic_changes", schema: z.object({ type: z.literal("import_schematic_changes"), pcbUuid: z.string().min(1), schematicUuid: z.string().min(1).optional() }) },
  ];
  const operation = z.discriminatedUnion("type", PCB_OPERATION_SCHEMAS.map((entry) => entry.schema));

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

  server.registerTool("pcb_create_from_schematic", {
    description: "Create a new PCB, associate it with a schematic as one EasyEDA Board, import schematic changes, and save the PCB. Refuses schematics that already own a PCB Board.",
    inputSchema: {
      schematicUuid: z.string().min(1), pcbName: z.string().min(1).max(80).optional(),
      stackup: stackupSettings.optional(),
      importChanges: z.boolean().default(true),
      reason: z.string().min(1).max(500).default("Create an associated PCB from a schematic"),
    },
  }, async ({ schematicUuid, pcbName, stackup, importChanges, reason }) => {
    try {
      const result = await writes.serialize(async (sessionId) => bridge.call("pcb.create", { sessionId, schematicUuid, pcbName, stackup, importChanges, reason }));
      projectCache.clear(); pcbCache.clear();
      try { await projectCache.initialize({ force: true }); } catch {}
      try { await pcbCache.refresh(); } catch {}
      return toolResult(result);
    } catch (error) { return toolError(error); }
  });

  server.registerTool("pcb_inspect", {
    description: "Read the cached [main] PCB: board outline, layers, stackup, footprints, pads, nets, tracks, vias, pours, regions, and design rules. Each matched footprint includes schematicPage {uuid, name}.",
    inputSchema: { refresh: z.boolean().default(false) },
  }, async ({ refresh }) => {
    try {
      const [snapshot, schematicComponents] = await Promise.all([pcbCache.getSnapshot({ refresh }), projectCache.getComponents()]);
      return toolResult(addSchematicPageLabels(snapshot, schematicComponents));
    }
    catch (error) { return toolError(error); }
  });

  server.registerTool("pcb_inspect_region", {
    description: "Read PCB primitives inside or touching a local rectangular region. Coordinates are mil.",
    inputSchema: { pcbUuid: z.string().min(1), left: z.number(), right: z.number(), top: z.number(), bottom: z.number(), fullyContained: z.boolean().default(false) },
  }, async (args) => {
    try {
      const [snapshot, schematicComponents] = await Promise.all([bridge.call("pcb.inspectRegion", args), projectCache.getComponents()]);
      return toolResult(addSchematicPageLabels(snapshot, schematicComponents));
    }
    catch (error) { return toolError(error); }
  });

  server.registerTool("pcb_check", {
    description: "Run cached whole-board checks for component overlap, outside-board placement, and unrouted nets.",
    inputSchema: { refresh: z.boolean().default(false), clearance: z.number().min(0).default(0), tolerance: z.number().positive().default(0.5) },
  }, async ({ refresh, clearance, tolerance }) => {
    try { return toolResult(inspectWholeBoard(await pcbCache.getSnapshot({ refresh }), { clearance, tolerance })); }
    catch (error) { return toolError(error); }
  });

  server.registerTool("pcb_find_board_outline", {
    description: "Locate every board-outline primitive on the Board Outline layer and report its IDs, geometry, counts, and bounds.",
    inputSchema: { refresh: z.boolean().default(false) },
  }, async ({ refresh }) => {
    try { return toolResult(findBoardOutline(await pcbCache.getSnapshot({ refresh }))); }
    catch (error) { return toolError(error); }
  });

  server.registerTool("pcb_list_stackups", {
    description: "List the current/default physical PCB stackup, every saved physical stackup configuration, copper-layer count, and layer names.",
    inputSchema: { pcbUuid: z.string().min(1) },
  }, async ({ pcbUuid }) => {
    try { return toolResult(await bridge.call("pcb.stackups.list", { pcbUuid })); }
    catch (error) { return toolError(error); }
  });

  server.registerTool("pcb_set_stackup", {
    description: "Set PCB copper-layer count, overwrite the current physical stackup from a saved/raw configuration, and/or rename enabled inner copper layers. Creates the normal session PCB backup.",
    inputSchema: { pcbUuid: z.string().min(1), ...stackupSettings.shape, reason: z.string().min(1).max(500).default("Configure PCB layer count and physical stackup") },
  }, async ({ pcbUuid, reason, ...settings }) => execute([{ type: "set_stackup", pcbUuid, ...settings }], reason));

  server.registerTool("pcb_check_board_outline", {
    description: "Check whether the PCB board outline is present and closed. Reports open endpoints, open/unknown polylines, branch vertices, and confidence.",
    inputSchema: { refresh: z.boolean().default(false), tolerance: z.number().positive().default(0.5) },
  }, async ({ refresh, tolerance }) => {
    try { return toolResult(checkBoardOutline(await pcbCache.getSnapshot({ refresh }), { tolerance })); }
    catch (error) { return toolError(error); }
  });

  server.registerTool("pcb_find_unrouted_nets", {
    description: "Find nets whose PCB pads are split into multiple straight-track/via connectivity groups.",
    inputSchema: { refresh: z.boolean().default(false), tolerance: z.number().positive().default(0.5) },
  }, async ({ refresh, tolerance }) => {
    try { return toolResult(findUnroutedNets(await pcbCache.getSnapshot({ refresh }), { tolerance })); }
    catch (error) { return toolError(error); }
  });

  server.registerTool("pcb_find_dangling_tracks", {
    description: "Find conservative straight-track copper islands that touch no component pad or via. Nets using pours, arcs, or polylines are reported as skipped.",
    inputSchema: { refresh: z.boolean().default(false), tolerance: z.number().positive().default(0.5), includeLocked: z.boolean().default(false) },
  }, async ({ refresh, tolerance, includeLocked }) => {
    try { return toolResult(findDanglingTracks(await pcbCache.getSnapshot({ refresh }), { tolerance, includeLocked })); }
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
      const [components, nets, pcb] = await Promise.all([projectCache.getComponents(), projectCache.getNets(), pcbCache.getSnapshot({ refresh })]);
      return toolResult(compareSchematicToPcb(components, pcb, nets));
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

  server.registerTool("pcb_delete_dangling_tracks", {
    description: "Re-scan and delete conservative straight-track islands that touch no pad or via. The first write creates a detached [backup] PCB; poured, arc/polyline, and locked connectivity is skipped by default.",
    inputSchema: {
      pcbUuid: z.string().min(1), tolerance: z.number().positive().default(0.5), includeLocked: z.boolean().default(false),
      reason: z.string().min(1).max(500).default("Delete verified dangling straight-track islands"),
    },
  }, async ({ pcbUuid, tolerance, includeLocked, reason }) => {
    try {
      const before = findDanglingTracks(await pcbCache.getSnapshot({ refresh: true }), { tolerance, includeLocked });
      const trackIds = before.groups.flatMap((group) => group.trackIds);
      if (!trackIds.length) return toolResult({ success: true, changed: false, pcbUuid, before });
      const applied = await writes.serialize(async (sessionId) => {
        const operations = [{ type: "delete_tracks", pcbUuid, trackIds }];
        const validation = await bridge.call("pcb.operations.validate", { operations });
        if (!validation?.valid) throw new Error(`PCB operation preflight failed: ${JSON.stringify(validation?.findings || [])}`);
        return { sessionId, ...(await bridge.call("pcb.operations.apply", { sessionId, reason, operations })) };
      });
      await pcbCache.refresh();
      const after = findDanglingTracks(await pcbCache.getSnapshot({ refresh: true }), { tolerance, includeLocked });
      return toolResult({ success: true, changed: true, pcbUuid, deletedTrackCount: trackIds.length, deletedTrackIds: trackIds, before, applied, after });
    } catch (error) { return toolError(error); }
    finally { try { await pcbCache.refresh(); } catch { pcbCache.clear(); } }
  });

  server.registerTool("pcb_transform_components", {
    description: "Move, rotate, and/or lock PCB footprints as one layout group. Omitted fields retain current values.",
    inputSchema: { pcbUuid: z.string().min(1), changes: z.array(transform).min(1).max(100), reason: z.string().min(1).max(500).default("Move, rotate, or lock PCB footprints") },
  }, async ({ pcbUuid, changes, reason }) => execute([{ type: "transform_components", pcbUuid, changes }], reason));

  server.registerTool("pcb_group_components_by_schematic_page", {
    description: "Plan or apply a deterministic PCB placement that keeps components from each schematic page together. Defaults to preview-only; set apply=true to move footprints and create the normal session PCB backup.",
    inputSchema: {
      pcbUuid: z.string().min(1), apply: z.boolean().default(false),
      originX: z.number().optional(), originY: z.number().optional(),
      componentGap: z.number().positive().default(50), groupGap: z.number().positive().default(200),
      maxGroupWidth: z.number().positive().default(1500), maxLayoutWidth: z.number().positive().default(6000),
      includeLocked: z.boolean().default(false),
      reason: z.string().min(1).max(500).default("Group PCB components by schematic page"),
    },
  }, async ({ pcbUuid, apply, originX, originY, componentGap, groupGap, maxGroupWidth, maxLayoutWidth, includeLocked, reason }) => {
    try {
      const [snapshot, schematicComponents] = await Promise.all([pcbCache.getSnapshot({ refresh: true }), projectCache.getComponents()]);
      if (snapshot?.board?.pcb?.uuid && snapshot.board.pcb.uuid !== pcbUuid) throw new Error(`Active PCB is ${snapshot.board.pcb.uuid}, not ${pcbUuid}`);
      const plan = planComponentsBySchematicPage(snapshot, schematicComponents, { originX, originY, componentGap, groupGap, maxGroupWidth, maxLayoutWidth, includeLocked });
      if (!apply || !plan.changes.length) return toolResult({ applied: false, plan });
      const operations = [];
      for (let index = 0; index < plan.changes.length; index += 100) operations.push({ type: "transform_components", pcbUuid, changes: plan.changes.slice(index, index + 100) });
      const applied = await writes.serialize(async (sessionId) => {
        const validation = await bridge.call("pcb.operations.validate", { operations });
        if (!validation?.valid) throw new Error(`PCB operation preflight failed: ${JSON.stringify(validation?.findings || [])}`);
        return { sessionId, ...(await bridge.call("pcb.operations.apply", { sessionId, reason, operations })) };
      });
      await pcbCache.refresh();
      return toolResult({ applied: true, plan, result: applied });
    } catch (error) { return toolError(error); }
    finally { try { await pcbCache.refresh(); } catch { pcbCache.clear(); } }
  });

  server.registerTool("pcb_create_tracks", {
    description: "Create straight track segments with explicit net, copper layer, and width. No width defaults are inferred.",
    inputSchema: { pcbUuid: z.string().min(1), tracks: z.array(track).min(1).max(100), reason: z.string().min(1).max(500).default("Create PCB tracks") },
  }, async ({ pcbUuid, tracks, reason }) => execute(tracks.map((item) => ({ type: "create_track", pcbUuid, ...item })), reason));

  server.registerTool("pcb_create_board_outline", {
    description: "Create or repair Board Outline geometry independently of copper routing. Supports rectangles, closed polygons, open repair paths, and rounded closed corners; uses layer 11 and an empty net.",
    inputSchema: {
      pcbUuid: z.string().min(1), outlines: z.array(boardOutline).min(1).max(20),
      reason: z.string().min(1).max(500).default("Create or repair PCB board outline"),
    },
  }, async ({ pcbUuid, outlines, reason }) => execute(outlines.map((outline) => ({ type: "create_board_outline", pcbUuid, outline })), reason));

  server.registerTool("pcb_delete_board_outline", {
    description: "Delete Board Outline line, arc, or polyline primitives by ID, or explicitly delete the entire current outline. Copper tracks are never accepted.",
    inputSchema: {
      pcbUuid: z.string().min(1), primitiveIds: z.array(z.string().min(1)).max(2000).default([]), deleteAll: z.boolean().default(false),
      reason: z.string().min(1).max(500).default("Delete PCB board outline primitives"),
    },
  }, async ({ pcbUuid, primitiveIds, deleteAll, reason }) => execute([{ type: "delete_board_outline", pcbUuid, primitiveIds, deleteAll }], reason));

  server.registerTool("pcb_replace_board_outline", {
    description: "Replace every existing Board Outline primitive with one validated rectangle or polygon in a single backed-up operation.",
    inputSchema: {
      pcbUuid: z.string().min(1), outline: boardOutline,
      reason: z.string().min(1).max(500).default("Replace PCB board outline"),
    },
  }, async ({ pcbUuid, outline, reason }) => execute([{ type: "replace_board_outline", pcbUuid, outline }], reason));

  server.registerTool("pcb_modify_tracks", {
    description: "Modify existing copper line, arc, or polyline tracks in place while preserving primitive IDs. Supports width, enabled copper layer, net, and lock state.",
    inputSchema: {
      pcbUuid: z.string().min(1), changes: z.array(trackChange).min(1).max(100),
      reason: z.string().min(1).max(500).default("Modify existing PCB tracks in place"),
    },
  }, async ({ pcbUuid, changes, reason }) => execute([{ type: "modify_tracks", pcbUuid, changes }], reason));

  server.registerTool("pcb_modify_vias", {
    description: "Modify existing vias in place while preserving primitive IDs. Supports position, hole/outer diameter, via type, net, and lock state.",
    inputSchema: {
      pcbUuid: z.string().min(1), changes: z.array(viaChange).min(1).max(100),
      reason: z.string().min(1).max(500).default("Modify existing PCB vias in place"),
    },
  }, async ({ pcbUuid, changes, reason }) => execute([{ type: "modify_vias", pcbUuid, changes }], reason));

  server.registerTool("pcb_apply_net_track_policy", {
    description: "Preview or apply one width/layer/lock policy to every copper line, arc, and polyline on exact or glob-matched nets. Defaults to preview-only and preserves every primitive ID.",
    inputSchema: {
      pcbUuid: z.string().min(1), netNames: z.array(z.string().min(1)).min(1).max(100), matchMode: z.enum(["exact", "glob"]).default("exact"),
      caseSensitive: z.boolean().default(false), width: z.number().positive().optional(), layer: z.number().int().optional(), locked: z.boolean().optional(),
      includeLocked: z.boolean().default(false), apply: z.boolean().default(false),
      reason: z.string().min(1).max(500).default("Apply a bulk PCB track policy by net"),
    },
  }, async ({ pcbUuid, netNames, matchMode, caseSensitive, width, layer, locked, includeLocked, apply, reason }) => {
    try {
      if (width === undefined && layer === undefined && locked === undefined) throw new Error("Track policy must include width, layer, or locked");
      const snapshot = await pcbCache.getSnapshot({ refresh: true });
      if (snapshot?.board?.pcb?.uuid && snapshot.board.pcb.uuid !== pcbUuid) throw new Error(`Active PCB is ${snapshot.board.pcb.uuid}, not ${pcbUuid}`);
      const plan = planNetTrackPolicy(snapshot, { netNames, matchMode, caseSensitive, width, layer, locked, includeLocked });
      if (!apply || !plan.changes.length) return toolResult({ applied: false, plan });
      const operations = [];
      for (let index = 0; index < plan.changes.length; index += 100) operations.push({ type: "modify_tracks", pcbUuid, changes: plan.changes.slice(index, index + 100) });
      const result = await writes.serialize(async (sessionId) => {
        const validation = await bridge.call("pcb.operations.validate", { operations });
        if (!validation?.valid) throw new Error(`PCB operation preflight failed: ${JSON.stringify(validation?.findings || [])}`);
        return { sessionId, ...(await bridge.call("pcb.operations.apply", { sessionId, reason, operations })) };
      });
      return toolResult({ applied: true, plan, result });
    } catch (error) { return toolError(error); }
    finally { try { await pcbCache.refresh(); } catch { pcbCache.clear(); } }
  });

  server.registerTool("pcb_arrange_components", {
    description: "Preview or apply sequential PCB component alignment, equal-edge-gap distribution, and grid snapping. Defaults to preview-only; apply uses ID-preserving component transforms.",
    inputSchema: {
      pcbUuid: z.string().min(1), componentIds: z.array(z.string().min(1)).min(1).max(500), arrangements: z.array(arrangement).min(1).max(20),
      includeLocked: z.boolean().default(false), apply: z.boolean().default(false),
      reason: z.string().min(1).max(500).default("Align, distribute, or grid-snap PCB components"),
    },
  }, async ({ pcbUuid, componentIds, arrangements, includeLocked, apply, reason }) => {
    try {
      const snapshot = await pcbCache.getSnapshot({ refresh: true });
      if (snapshot?.board?.pcb?.uuid && snapshot.board.pcb.uuid !== pcbUuid) throw new Error(`Active PCB is ${snapshot.board.pcb.uuid}, not ${pcbUuid}`);
      const plan = planComponentArrangement(snapshot, componentIds, arrangements, { includeLocked });
      if (plan.missing.length) throw new Error(`PCB components not found: ${plan.missing.join(", ")}`);
      if (!apply || !plan.changes.length) return toolResult({ applied: false, plan });
      const operations = [];
      for (let index = 0; index < plan.changes.length; index += 100) operations.push({ type: "transform_components", pcbUuid, changes: plan.changes.slice(index, index + 100) });
      const result = await writes.serialize(async (sessionId) => {
        const validation = await bridge.call("pcb.operations.validate", { operations });
        if (!validation?.valid) throw new Error(`PCB operation preflight failed: ${JSON.stringify(validation?.findings || [])}`);
        return { sessionId, ...(await bridge.call("pcb.operations.apply", { sessionId, reason, operations })) };
      });
      return toolResult({ applied: true, plan, result });
    } catch (error) { return toolError(error); }
    finally { try { await pcbCache.refresh(); } catch { pcbCache.clear(); } }
  });

  server.registerTool("pcb_create_vias", {
    description: "Create vias with explicit net, hole diameter, and outer diameter. No via-rule defaults are inferred.",
    inputSchema: { pcbUuid: z.string().min(1), vias: z.array(via).min(1).max(100), reason: z.string().min(1).max(500).default("Create PCB vias") },
  }, async ({ pcbUuid, vias, reason }) => execute(vias.map((item) => ({ type: "create_via", pcbUuid, ...item })), reason));

  server.registerTool("pcb_create_pads", {
    description: "Create standalone PCB pads with explicit net, layer, number, geometry, hole, metallization, and pad type. Top/bottom pads are SMD; multi-layer pads require a round or slot hole.",
    inputSchema: { pcbUuid: z.string().min(1), pads: z.array(pad).min(1).max(100), reason: z.string().min(1).max(500).default("Create standalone PCB pads") },
  }, async ({ pcbUuid, pads, reason }) => execute(pads.map((item) => ({ type: "create_pad", pcbUuid, ...item })), reason));

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
