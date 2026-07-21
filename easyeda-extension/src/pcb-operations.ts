// Registry of every whitelisted PCB write operation: one entry per `type`, each owning both its
// own validation and its own application against the eda.pcb_* API. This replaces two parallel
// `if/else if` chains (one for validation, one for application) that used to live in handlers.ts
// and had to be kept in lockstep by hand. Adding an operation now means adding one entry here;
// the whitelist of allowed types is derived from this registry's keys, not maintained separately.
//
// This registry only exists on the EasyEDA-extension side. The MCP-side zod schemas in
// src/pcb-tools.mjs are a separate, independently-maintained registry in a different process —
// that duplication is intentional (the extension must not trust the MCP process's validation
// alone) and is not something this file tries to unify.
import { BOARD_OUTLINE_LAYER, compileBoardOutline } from './board-outline.ts';
import {
  serializePcbArc, serializePcbLine, serializePcbPad, serializePcbPolyline, serializePcbPour, serializePcbVia,
} from './pcb-serialize.ts';
import { applyPcbStackupSettings, VALID_COPPER_LAYER_COUNTS } from './pcb-stackup.ts';

type JsonObject = Record<string, unknown>;

/** Board-wide lookups computed once per validate/apply call and shared by every operation entry. */
export interface PcbOperationContext {
  board: any;
  componentIds: Set<string>;
  netNames: Set<string>;
  layerIds: Set<number>;
  copperLayerIds: Set<number>;
  copperLineIds: Set<string>;
  copperTrackIds: Set<string>;
  boardOutlineIds: Set<string>;
  viaById: Map<string, any>;
  pourIds: Set<string>;
}

export interface PcbOperationDefinition {
  /** Push zero or more findings into `findings`; must not touch the document. */
  validate(operation: JsonObject, index: number, ctx: PcbOperationContext, findings: JsonObject[]): void;
  /**
   * Perform the write against eda.pcb_* and return the per-operation result value.
   * No operation currently needs board-wide context at apply time — every apply()
   * re-fetches and re-verifies the specific primitives it touches instead.
   */
  apply(operation: JsonObject): Promise<unknown>;
}

function finiteNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

function positiveNumber(value: unknown): boolean {
  return finiteNumber(value) && Number(value) > 0;
}

type BoardOutlinePrimitiveRef = {type: 'line' | 'arc' | 'polyline'; id: string};

async function getBoardOutlinePrimitiveRefs(): Promise<BoardOutlinePrimitiveRef[]> {
  const [lines, arcs, polylines] = await Promise.all([
    eda.pcb_PrimitiveLine.getAll(), eda.pcb_PrimitiveArc.getAll(), eda.pcb_PrimitivePolyline.getAll(),
  ]);
  return [
    ...lines.filter(item => Number(item.getState_Layer()) === BOARD_OUTLINE_LAYER).map(item => ({ type: 'line' as const, id: item.getState_PrimitiveId() })),
    ...arcs.filter(item => Number(item.getState_Layer()) === BOARD_OUTLINE_LAYER).map(item => ({ type: 'arc' as const, id: item.getState_PrimitiveId() })),
    ...polylines.filter(item => Number(item.getState_Layer()) === BOARD_OUTLINE_LAYER).map(item => ({ type: 'polyline' as const, id: item.getState_PrimitiveId() })),
  ];
}

async function deleteBoardOutlinePrimitiveRefs(refs: BoardOutlinePrimitiveRef[]): Promise<string[]> {
  const lineIds = refs.filter(item => item.type === 'line').map(item => item.id);
  const arcIds = refs.filter(item => item.type === 'arc').map(item => item.id);
  const polylineIds = refs.filter(item => item.type === 'polyline').map(item => item.id);
  if (lineIds.length && !await eda.pcb_PrimitiveLine.delete(lineIds)) throw new Error('Board outline line deletion failed');
  if (arcIds.length && !await eda.pcb_PrimitiveArc.delete(arcIds)) throw new Error('Board outline arc deletion failed');
  if (polylineIds.length && !await eda.pcb_PrimitivePolyline.delete(polylineIds)) throw new Error('Board outline polyline deletion failed');
  const remaining = new Set((await getBoardOutlinePrimitiveRefs()).map(item => item.id));
  const undeleted = refs.map(item => item.id).filter(id => remaining.has(id));
  if (undeleted.length) throw new Error(`Board outline deletion verification failed: ${undeleted.join(', ')}`);
  return refs.map(item => item.id);
}

async function createBoardOutlinePrimitives(rawOutline: unknown): Promise<{refs: BoardOutlinePrimitiveRef[]; primitives: unknown[]}> {
  const refs: BoardOutlinePrimitiveRef[] = [];
  const primitives = [];
  try {
    for (const primitive of compileBoardOutline(rawOutline)) {
      const item = primitive.type === 'line'
        ? await eda.pcb_PrimitiveLine.create('', BOARD_OUTLINE_LAYER as any, primitive.startX, primitive.startY, primitive.endX, primitive.endY, primitive.lineWidth, primitive.locked)
        : await eda.pcb_PrimitiveArc.create('', BOARD_OUTLINE_LAYER as any, primitive.startX, primitive.startY, primitive.endX, primitive.endY, Number(primitive.angle), primitive.lineWidth, undefined, primitive.locked);
      if (!item) throw new Error(`Board outline ${primitive.type} creation failed`);
      refs.push({ type: primitive.type, id: item.getState_PrimitiveId() });
      primitives.push(primitive.type === 'line' ? serializePcbLine(item) : serializePcbArc(item));
    }
    return { refs, primitives };
  } catch (error) {
    try { await deleteBoardOutlinePrimitiveRefs(refs); } catch { /* Preserve the original creation error. */ }
    throw error;
  }
}

export const PCB_OPERATIONS: Record<string, PcbOperationDefinition> = {
  transform_components: {
    validate(operation, index, ctx, findings) {
      const changes = operation.changes as unknown;
      if (!Array.isArray(changes) || changes.length < 1 || changes.length > 100) {
        findings.push({ index, level: 'error', message: 'changes must contain 1-100 component transformations' });
        return;
      }
      const seen = new Set<string>();
      for (const raw of changes) {
        const change = raw as JsonObject;
        const id = String(change.componentId || '');
        if (!ctx.componentIds.has(id)) findings.push({ index, level: 'error', message: 'PCB component not found', id });
        if (seen.has(id)) findings.push({ index, level: 'error', message: 'PCB component appears more than once', id });
        seen.add(id);
        if (![change.x, change.y, change.rotation].some(value => value !== undefined) && change.locked === undefined) {
          findings.push({ index, level: 'error', message: 'Transformation must include x, y, rotation, or locked', id });
        }
        for (const key of ['x', 'y', 'rotation']) {
          if (change[key] !== undefined && !finiteNumber(change[key])) findings.push({ index, level: 'error', message: `${key} must be finite`, id });
        }
        if (change.locked !== undefined && typeof change.locked !== 'boolean') findings.push({ index, level: 'error', message: 'locked must be boolean', id });
      }
    },
    async apply(operation) {
      const transformed = [];
      for (const change of operation.changes as JsonObject[]) {
        const id = String(change.componentId);
        const beforeItem = await eda.pcb_PrimitiveComponent.get(id);
        if (!beforeItem || Array.isArray(beforeItem)) throw new Error(`PCB component not found: ${id}`);
        const before = { x: beforeItem.getState_X(), y: beforeItem.getState_Y(), rotation: beforeItem.getState_Rotation(), locked: beforeItem.getState_PrimitiveLock() };
        const item = await eda.pcb_PrimitiveComponent.modify(id, {
          x: change.x === undefined ? before.x : Number(change.x),
          y: change.y === undefined ? before.y : Number(change.y),
          rotation: change.rotation === undefined ? before.rotation : Number(change.rotation),
          primitiveLock: change.locked === undefined ? before.locked : change.locked === true,
        });
        if (!item) throw new Error(`PCB component transformation failed: ${id}`);
        transformed.push({ id, designator: item.getState_Designator(), before, after: { x: item.getState_X(), y: item.getState_Y(), rotation: item.getState_Rotation(), locked: item.getState_PrimitiveLock() } });
      }
      return { components: transformed };
    },
  },

  create_board_outline: {
    validate(operation, index, ctx, findings) {
      if (!ctx.layerIds.has(BOARD_OUTLINE_LAYER)) findings.push({ index, level: 'error', message: 'Board Outline layer is not available', layer: BOARD_OUTLINE_LAYER });
      try { compileBoardOutline(operation.outline); }
      catch (error) { findings.push({ index, level: 'error', message: error instanceof Error ? error.message : String(error) }); }
    },
    async apply(operation) {
      const created = await createBoardOutlinePrimitives(operation.outline);
      return { layer: BOARD_OUTLINE_LAYER, primitiveCount: created.primitives.length, primitives: created.primitives };
    },
  },

  delete_board_outline: {
    validate(operation, index, ctx, findings) {
      const primitiveIds = Array.isArray(operation.primitiveIds) ? operation.primitiveIds.map(String) : [];
      const deleteAll = operation.deleteAll === true;
      if (!deleteAll && primitiveIds.length < 1) findings.push({ index, level: 'error', message: 'primitiveIds must be non-empty unless deleteAll is true' });
      if (deleteAll && primitiveIds.length) findings.push({ index, level: 'error', message: 'primitiveIds must be empty when deleteAll is true' });
      if (primitiveIds.length > 2000) findings.push({ index, level: 'error', message: 'primitiveIds must contain at most 2000 Board Outline primitive IDs' });
      const seen = new Set<string>();
      for (const id of primitiveIds) {
        if (!ctx.boardOutlineIds.has(id)) findings.push({ index, level: 'error', message: 'Board Outline primitive not found', id });
        if (seen.has(id)) findings.push({ index, level: 'error', message: 'Board Outline primitive appears more than once', id });
        seen.add(id);
      }
      if (deleteAll && ctx.boardOutlineIds.size < 1) findings.push({ index, level: 'error', message: 'No Board Outline primitives exist' });
    },
    async apply(operation) {
      const all = await getBoardOutlinePrimitiveRefs();
      const requested = operation.deleteAll === true ? null : new Set((operation.primitiveIds as unknown[]).map(String));
      const targets = requested ? all.filter(item => requested.has(item.id)) : all;
      const deletedPrimitiveIds = await deleteBoardOutlinePrimitiveRefs(targets);
      return { layer: BOARD_OUTLINE_LAYER, deletedPrimitiveCount: deletedPrimitiveIds.length, deletedPrimitiveIds };
    },
  },

  replace_board_outline: {
    validate(operation, index, ctx, findings) {
      if (!ctx.layerIds.has(BOARD_OUTLINE_LAYER)) findings.push({ index, level: 'error', message: 'Board Outline layer is not available', layer: BOARD_OUTLINE_LAYER });
      try { compileBoardOutline(operation.outline); }
      catch (error) { findings.push({ index, level: 'error', message: error instanceof Error ? error.message : String(error) }); }
    },
    async apply(operation) {
      const existing = await getBoardOutlinePrimitiveRefs();
      const created = await createBoardOutlinePrimitives(operation.outline);
      try {
        const deletedPrimitiveIds = await deleteBoardOutlinePrimitiveRefs(existing);
        return {
          layer: BOARD_OUTLINE_LAYER,
          deletedPrimitiveCount: deletedPrimitiveIds.length,
          deletedPrimitiveIds,
          primitiveCount: created.primitives.length,
          primitives: created.primitives,
        };
      } catch (error) {
        try { await deleteBoardOutlinePrimitiveRefs(created.refs); } catch { /* Keep the old outline and surface the deletion error. */ }
        throw error;
      }
    },
  },

  create_track: {
    validate(operation, index, ctx, findings) {
      if (!ctx.netNames.has(String(operation.net || ''))) findings.push({ index, level: 'error', message: 'PCB net not found', net: operation.net });
      if (!ctx.layerIds.has(Number(operation.layer)) || !ctx.copperLayerIds.has(Number(operation.layer))) findings.push({ index, level: 'error', message: 'Routing layer must be an enabled copper layer', layer: operation.layer });
      for (const key of ['startX', 'startY', 'endX', 'endY']) if (!finiteNumber(operation[key])) findings.push({ index, level: 'error', message: `${key} must be finite` });
      if (!positiveNumber(operation.width)) findings.push({ index, level: 'error', message: 'Track width must be explicitly positive' });
    },
    async apply(operation) {
      const item = await eda.pcb_PrimitiveLine.create(String(operation.net), Number(operation.layer) as any,
        Number(operation.startX), Number(operation.startY), Number(operation.endX), Number(operation.endY), Number(operation.width), operation.locked === true);
      if (!item) throw new Error('Track creation failed');
      return serializePcbLine(item);
    },
  },

  create_via: {
    validate(operation, index, ctx, findings) {
      if (!ctx.netNames.has(String(operation.net || ''))) findings.push({ index, level: 'error', message: 'PCB net not found', net: operation.net });
      if (!finiteNumber(operation.x) || !finiteNumber(operation.y)) findings.push({ index, level: 'error', message: 'Via x/y must be finite' });
      if (!positiveNumber(operation.holeDiameter) || !positiveNumber(operation.diameter)
        || Number(operation.diameter) <= Number(operation.holeDiameter)) {
        findings.push({ index, level: 'error', message: 'Via diameter must be greater than its positive hole diameter' });
      }
    },
    async apply(operation) {
      const item = await eda.pcb_PrimitiveVia.create(String(operation.net), Number(operation.x), Number(operation.y),
        Number(operation.holeDiameter), Number(operation.diameter), operation.viaType as any, null, null, operation.locked === true);
      if (!item) throw new Error('Via creation failed');
      return serializePcbVia(item);
    },
  },

  modify_tracks: {
    validate(operation, index, ctx, findings) {
      const changes = operation.changes as unknown;
      if (!Array.isArray(changes) || changes.length < 1 || changes.length > 100) { findings.push({ index, level: 'error', message: 'changes must contain 1-100 track modifications' }); return; }
      const seen = new Set<string>();
      for (const raw of changes) {
        const change = raw as JsonObject; const id = String(change.trackId || '');
        if (!ctx.copperTrackIds.has(id)) findings.push({ index, level: 'error', message: 'Copper track, arc, or polyline not found', id });
        if (seen.has(id)) findings.push({ index, level: 'error', message: 'Track appears more than once', id });
        seen.add(id);
        if (![change.width, change.layer, change.net, change.locked].some(value => value !== undefined)) findings.push({ index, level: 'error', message: 'Track change must include width, layer, net, or locked', id });
        if (change.width !== undefined && !positiveNumber(change.width)) findings.push({ index, level: 'error', message: 'Track width must be positive', id });
        if (change.layer !== undefined && (!ctx.layerIds.has(Number(change.layer)) || !ctx.copperLayerIds.has(Number(change.layer)))) findings.push({ index, level: 'error', message: 'Track layer must be an enabled copper layer', id, layer: change.layer });
        if (change.net !== undefined && !ctx.netNames.has(String(change.net))) findings.push({ index, level: 'error', message: 'PCB net not found', id, net: change.net });
        if (change.locked !== undefined && typeof change.locked !== 'boolean') findings.push({ index, level: 'error', message: 'locked must be boolean', id });
      }
    },
    async apply(operation) {
      const modified = [];
      for (const change of operation.changes as JsonObject[]) {
        const id = String(change.trackId);
        const line = await eda.pcb_PrimitiveLine.get(id);
        const arc = line ? undefined : await eda.pcb_PrimitiveArc.get(id);
        const polyline = line || arc ? undefined : await eda.pcb_PrimitivePolyline.get(id);
        const current = line || arc || polyline;
        if (!current || Array.isArray(current)) throw new Error(`Copper track, arc, or polyline not found: ${id}`);
        const primitiveType = line ? 'line' : arc ? 'arc' : 'polyline';
        const before = primitiveType === 'line' ? serializePcbLine(current) : primitiveType === 'arc' ? serializePcbArc(current) : await serializePcbPolyline(current);
        const property: any = {};
        if (change.width !== undefined) property.lineWidth = Number(change.width);
        if (change.layer !== undefined) property.layer = Number(change.layer);
        if (change.net !== undefined) property.net = String(change.net);
        if (change.locked !== undefined) property.primitiveLock = change.locked === true;
        const item = primitiveType === 'line' ? await eda.pcb_PrimitiveLine.modify(id, property)
          : primitiveType === 'arc' ? await eda.pcb_PrimitiveArc.modify(id, property)
            : await eda.pcb_PrimitivePolyline.modify(id, property);
        if (!item || item.getState_PrimitiveId() !== id) throw new Error(`Track modification failed to preserve primitive ID: ${id}`);
        const after = primitiveType === 'line' ? serializePcbLine(item) : primitiveType === 'arc' ? serializePcbArc(item) : await serializePcbPolyline(item);
        modified.push({ id, primitiveType, before, after });
      }
      return { modifiedTrackCount: modified.length, tracks: modified };
    },
  },

  modify_vias: {
    validate(operation, index, ctx, findings) {
      const changes = operation.changes as unknown;
      if (!Array.isArray(changes) || changes.length < 1 || changes.length > 100) { findings.push({ index, level: 'error', message: 'changes must contain 1-100 via modifications' }); return; }
      const seen = new Set<string>();
      for (const raw of changes) {
        const change = raw as JsonObject; const id = String(change.viaId || ''); const current = ctx.viaById.get(id) as any;
        if (!current) findings.push({ index, level: 'error', message: 'PCB via not found', id });
        if (seen.has(id)) findings.push({ index, level: 'error', message: 'Via appears more than once', id });
        seen.add(id);
        if (![change.x, change.y, change.holeDiameter, change.diameter, change.viaType, change.net, change.locked].some(value => value !== undefined)) findings.push({ index, level: 'error', message: 'Via change contains no modifications', id });
        for (const key of ['x', 'y']) if (change[key] !== undefined && !finiteNumber(change[key])) findings.push({ index, level: 'error', message: `${key} must be finite`, id });
        if (change.viaType !== undefined && !Number.isInteger(change.viaType)) findings.push({ index, level: 'error', message: 'viaType must be an integer', id });
        if (change.net !== undefined && !ctx.netNames.has(String(change.net))) findings.push({ index, level: 'error', message: 'PCB net not found', id, net: change.net });
        if (change.locked !== undefined && typeof change.locked !== 'boolean') findings.push({ index, level: 'error', message: 'locked must be boolean', id });
        if (current) {
          const holeDiameter = change.holeDiameter === undefined ? Number(current.getState_HoleDiameter()) : Number(change.holeDiameter);
          const diameter = change.diameter === undefined ? Number(current.getState_Diameter()) : Number(change.diameter);
          if (!positiveNumber(holeDiameter) || !positiveNumber(diameter) || diameter <= holeDiameter) findings.push({ index, level: 'error', message: 'Via diameter must remain greater than its positive hole diameter', id });
        }
      }
    },
    async apply(operation) {
      const modified = [];
      for (const change of operation.changes as JsonObject[]) {
        const id = String(change.viaId); const current = await eda.pcb_PrimitiveVia.get(id);
        if (!current || Array.isArray(current)) throw new Error(`PCB via not found: ${id}`);
        const before = serializePcbVia(current); const property: any = {};
        for (const key of ['x', 'y', 'holeDiameter', 'diameter', 'viaType']) if (change[key] !== undefined) property[key] = Number(change[key]);
        if (change.net !== undefined) property.net = String(change.net);
        if (change.locked !== undefined) property.primitiveLock = change.locked === true;
        const item = await eda.pcb_PrimitiveVia.modify(id, property);
        if (!item || item.getState_PrimitiveId() !== id) throw new Error(`Via modification failed to preserve primitive ID: ${id}`);
        modified.push({ id, before, after: serializePcbVia(item) });
      }
      return { modifiedViaCount: modified.length, vias: modified };
    },
  },

  set_stackup: {
    validate(operation, index, ctx, findings) {
      const hasCount = operation.copperLayerCount !== undefined;
      const hasName = operation.physicalStackingConfigurationName !== undefined;
      const hasConfiguration = operation.physicalStackingConfiguration !== undefined;
      const hasLayerNames = Array.isArray(operation.layerNames) && operation.layerNames.length > 0;
      const hasInnerLayerNames = Array.isArray(operation.innerLayerNames) && operation.innerLayerNames.length > 0;
      if (!hasCount && !hasName && !hasConfiguration && !hasLayerNames && !hasInnerLayerNames) findings.push({ index, level: 'error', message: 'Stackup operation contains no changes' });
      if (hasCount && !VALID_COPPER_LAYER_COUNTS.has(Number(operation.copperLayerCount))) findings.push({ index, level: 'error', message: 'Copper layer count must be an even number from 2 through 32' });
      if (hasName && hasConfiguration) findings.push({ index, level: 'error', message: 'Use either a named or raw physical stackup configuration, not both' });
      if (hasCount && (hasName || hasConfiguration)) findings.push({ index, level: 'error', message: 'Use either copperLayerCount or a physical stackup configuration, not both' });
      if (hasLayerNames && hasInnerLayerNames) findings.push({ index, level: 'error', message: 'Use either explicit layerNames or ordered innerLayerNames, not both' });
      if (hasName && !String(operation.physicalStackingConfigurationName || '')) findings.push({ index, level: 'error', message: 'Physical stackup configuration name cannot be empty' });
      if (hasConfiguration && (!operation.physicalStackingConfiguration || typeof operation.physicalStackingConfiguration !== 'object' || Array.isArray(operation.physicalStackingConfiguration))) findings.push({ index, level: 'error', message: 'Physical stackup configuration must be an object' });
      if (operation.layerNames !== undefined && (!Array.isArray(operation.layerNames) || operation.layerNames.length > 30)) findings.push({ index, level: 'error', message: 'layerNames must contain at most 30 entries' });
      if (operation.innerLayerNames !== undefined && (!Array.isArray(operation.innerLayerNames) || operation.innerLayerNames.length > 30 || operation.innerLayerNames.some(name => typeof name !== 'string' || !name))) findings.push({ index, level: 'error', message: 'innerLayerNames must contain at most 30 non-empty names' });
    },
    async apply(operation) {
      return applyPcbStackupSettings(operation);
    },
  },

  create_pad: {
    validate(operation, index, ctx, findings) {
      const layer = Number(operation.layer);
      if (![1, 2, 12].includes(layer)) findings.push({ index, level: 'error', message: 'Pad layer must be top (1), bottom (2), or multi-layer (12)', layer });
      if (String(operation.net || '') && !ctx.netNames.has(String(operation.net))) findings.push({ index, level: 'error', message: 'PCB net not found', net: operation.net });
      if (!String(operation.padNumber || '')) findings.push({ index, level: 'error', message: 'Pad number is required' });
      for (const key of ['x', 'y', 'rotation', 'holeOffsetX', 'holeOffsetY', 'holeRotation']) if (!finiteNumber(operation[key])) findings.push({ index, level: 'error', message: `${key} must be finite` });
      const shape = operation.shape as JsonObject;
      if (!shape || !['ELLIPSE', 'OVAL', 'RECT', 'NGON'].includes(String(shape.type))) findings.push({ index, level: 'error', message: 'Unsupported pad shape' });
      else if (shape.type === 'NGON') {
        if (!positiveNumber(shape.diameter) || !Number.isInteger(shape.sides) || Number(shape.sides) < 3) findings.push({ index, level: 'error', message: 'NGON requires a positive diameter and at least 3 sides' });
      } else if (!positiveNumber(shape.width) || !positiveNumber(shape.height) || (shape.type === 'RECT' && (!finiteNumber(shape.roundRadius) || Number(shape.roundRadius) < 0))) {
        findings.push({ index, level: 'error', message: 'Pad width/height must be positive and rectangle roundRadius must be non-negative' });
      }
      const hole = operation.hole as JsonObject;
      if (!hole || !['NONE', 'ROUND', 'SLOT'].includes(String(hole.type))) findings.push({ index, level: 'error', message: 'Unsupported pad hole type' });
      else if (layer === 12 && hole.type === 'NONE') findings.push({ index, level: 'error', message: 'Multi-layer pads require a hole' });
      else if (layer !== 12 && hole.type !== 'NONE') findings.push({ index, level: 'error', message: 'Top/bottom SMD pads cannot have a hole' });
      else if (hole.type === 'ROUND' && !positiveNumber(hole.diameter)) findings.push({ index, level: 'error', message: 'Round hole diameter must be positive' });
      else if (hole.type === 'SLOT' && (!positiveNumber(hole.diameter) || !positiveNumber(hole.length) || Number(hole.length) < Number(hole.diameter))) findings.push({ index, level: 'error', message: 'Slot length must be at least its positive diameter' });
      if (![0, 1, 2].includes(Number(operation.padType))) findings.push({ index, level: 'error', message: 'padType must be 0 (normal), 1 (test), or 2 (mark point)' });
      if (typeof operation.metallized !== 'boolean' || typeof operation.locked !== 'boolean') findings.push({ index, level: 'error', message: 'metallized and locked must be boolean' });
    },
    async apply(operation) {
      const shape = operation.shape as JsonObject;
      const padShape = shape.type === 'NGON'
        ? [String(shape.type), Number(shape.diameter), Number(shape.sides)]
        : shape.type === 'RECT'
          ? [String(shape.type), Number(shape.width), Number(shape.height), Number(shape.roundRadius)]
          : [String(shape.type), Number(shape.width), Number(shape.height)];
      const hole = operation.hole as JsonObject;
      const padHole = hole.type === 'NONE' ? null : hole.type === 'ROUND'
        ? [String(hole.type), Number(hole.diameter)]
        : [String(hole.type), Number(hole.diameter), Number(hole.length)];
      const item = await eda.pcb_PrimitivePad.create(
        Number(operation.layer) as any, String(operation.padNumber), Number(operation.x), Number(operation.y), Number(operation.rotation),
        padShape as any, String(operation.net || ''), padHole as any, Number(operation.holeOffsetX), Number(operation.holeOffsetY),
        Number(operation.holeRotation), operation.metallized === true, Number(operation.padType) as any, undefined, null, null, operation.locked === true,
      );
      if (!item) throw new Error('Pad creation failed');
      return serializePcbPad(item);
    },
  },

  create_pour: {
    validate(operation, index, ctx, findings) {
      if (!ctx.netNames.has(String(operation.net || ''))) findings.push({ index, level: 'error', message: 'PCB net not found', net: operation.net });
      if (!ctx.layerIds.has(Number(operation.layer)) || !ctx.copperLayerIds.has(Number(operation.layer))) findings.push({ index, level: 'error', message: 'Pour layer must be an enabled copper layer', layer: operation.layer });
      if (!Array.isArray(operation.polygon) || !eda.pcb_MathPolygon.createPolygon(operation.polygon as any)) {
        findings.push({ index, level: 'error', message: 'Invalid EasyEDA polygon source' });
      }
      if (!positiveNumber(operation.width)) findings.push({ index, level: 'error', message: 'Pour line width must be explicitly positive' });
    },
    async apply(operation) {
      const polygon = eda.pcb_MathPolygon.createPolygon(operation.polygon as any);
      if (!polygon) throw new Error('Pour polygon creation failed');
      const item = await eda.pcb_PrimitivePour.create(String(operation.net), Number(operation.layer) as any, polygon,
        operation.fillMethod as any, operation.preserveSilos !== false, operation.name ? String(operation.name) : undefined,
        operation.priority === undefined ? undefined : Number(operation.priority), Number(operation.width), operation.locked === true);
      if (!item) throw new Error('Pour creation failed');
      return serializePcbPour(item);
    },
  },

  delete_tracks: {
    validate(operation, index, ctx, findings) {
      if (!Array.isArray(operation.trackIds) || operation.trackIds.length < 1 || operation.trackIds.length > 2000) {
        findings.push({ index, level: 'error', message: 'trackIds must contain 1-2000 straight copper-track IDs' });
        return;
      }
      const seen = new Set<string>();
      for (const rawId of operation.trackIds) {
        const id = String(rawId || '');
        if (!ctx.copperLineIds.has(id)) findings.push({ index, level: 'error', message: 'Straight copper track not found', id });
        if (seen.has(id)) findings.push({ index, level: 'error', message: 'Track appears more than once', id });
        seen.add(id);
      }
    },
    async apply(operation) {
      const trackIds = (operation.trackIds as unknown[]).map(String);
      if (!await eda.pcb_PrimitiveLine.delete(trackIds)) throw new Error('Track deletion failed');
      const remaining = new Set((await eda.pcb_PrimitiveLine.getAll()).map(item => item.getState_PrimitiveId()));
      const undeleted = trackIds.filter(id => remaining.has(id));
      if (undeleted.length) throw new Error(`Track deletion verification failed: ${undeleted.join(', ')}`);
      return { deletedTrackIds: trackIds, deletedTrackCount: trackIds.length };
    },
  },

  rebuild_pours: {
    validate(operation, index, ctx, findings) {
      if (!Array.isArray(operation.pourIds)) return;
      for (const id of operation.pourIds) if (!ctx.pourIds.has(String(id))) findings.push({ index, level: 'error', message: 'Pour not found', id });
    },
    async apply(operation) {
      const requested = Array.isArray(operation.pourIds) ? new Set(operation.pourIds.map(String)) : null;
      const pours = (await eda.pcb_PrimitivePour.getAll()).filter(item => !requested || requested.has(item.getState_PrimitiveId()));
      const rebuilt = [];
      for (const pour of pours) {
        const poured = await pour.rebuildCopperRegion();
        rebuilt.push({ pourId: pour.getState_PrimitiveId(), pouredId: poured?.getState_PrimitiveId() || null });
      }
      return { rebuilt };
    },
  },

  import_schematic_changes: {
    validate(operation, index, ctx, findings) {
      // openPcb already proves the target PCB belongs to the [main] schematic Board.
      if (operation.schematicUuid !== undefined && typeof operation.schematicUuid !== 'string') {
        findings.push({ index, level: 'error', message: 'schematicUuid must be a string when provided' });
      } else if (operation.schematicUuid && operation.schematicUuid !== ctx.board.schematic?.uuid) {
        findings.push({ index, level: 'error', message: 'Only the associated [main] schematic can be imported', schematicUuid: operation.schematicUuid });
      }
    },
    async apply(operation) {
      const imported = await eda.pcb_Document.importChanges(operation.schematicUuid ? String(operation.schematicUuid) : undefined);
      if (!imported) throw new Error('Importing schematic changes into PCB failed');
      return { imported: true, schematicUuid: operation.schematicUuid || null };
    },
  },
};
