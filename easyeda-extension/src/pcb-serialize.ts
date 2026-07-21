// Shared PCB primitive serializers. Used by both read paths (inspectPcb/inspectPcbRegion in
// handlers.ts) and the PCB operation registry (pcb-operations.ts) so write results are reported
// in the exact same shape as reads.
type JsonObject = Record<string, unknown>;

export type PrimitiveBounds = {minX: number; minY: number; maxX: number; maxY: number};

export function polygonSource(polygon: any): unknown {
  try { return polygon?.getSource?.() ?? null; } catch { return null; }
}

export async function primitiveBBox(primitiveId: string): Promise<PrimitiveBounds | undefined> {
  try { return await eda.pcb_Primitive.getPrimitivesBBox([primitiveId]); }
  catch { return undefined; }
}

export async function serializePcbPad(pad: any): Promise<JsonObject> {
  const id = pad.getState_PrimitiveId();
  return {
    id,
    parentComponentId: pad.getState_ParentComponentPrimitiveId?.() || null,
    number: pad.getState_PadNumber(),
    net: pad.getState_Net() || '',
    layer: pad.getState_Layer(),
    x: pad.getState_X(),
    y: pad.getState_Y(),
    rotation: pad.getState_Rotation(),
    pad: pad.getState_Pad(),
    hole: pad.getState_Hole(),
    padType: pad.getState_PadType(),
    locked: pad.getState_PrimitiveLock(),
    bbox: await primitiveBBox(id),
  };
}

export function serializePcbLine(line: any): JsonObject {
  return {
    id: line.getState_PrimitiveId(), net: line.getState_Net() || '', layer: line.getState_Layer(),
    startX: line.getState_StartX(), startY: line.getState_StartY(),
    endX: line.getState_EndX(), endY: line.getState_EndY(),
    width: line.getState_LineWidth(), locked: line.getState_PrimitiveLock(),
  };
}

export function serializePcbArc(arc: any): JsonObject {
  return {
    id: arc.getState_PrimitiveId(), net: arc.getState_Net() || '', layer: arc.getState_Layer(),
    startX: arc.getState_StartX(), startY: arc.getState_StartY(),
    endX: arc.getState_EndX(), endY: arc.getState_EndY(), angle: arc.getState_ArcAngle(),
    width: arc.getState_LineWidth(), locked: arc.getState_PrimitiveLock(),
  };
}

export async function serializePcbPolyline(polyline: any): Promise<JsonObject> {
  const id = polyline.getState_PrimitiveId();
  return {
    id, net: polyline.getState_Net() || '', layer: polyline.getState_Layer(),
    polygon: polygonSource(polyline.getState_Polygon()), width: polyline.getState_LineWidth(),
    locked: polyline.getState_PrimitiveLock(), bbox: await primitiveBBox(id),
  };
}

export function serializePcbVia(via: any): JsonObject {
  return {
    id: via.getState_PrimitiveId(), net: via.getState_Net() || '', x: via.getState_X(), y: via.getState_Y(),
    holeDiameter: via.getState_HoleDiameter(), diameter: via.getState_Diameter(),
    viaType: via.getState_ViaType(), designRuleBlindViaName: via.getState_DesignRuleBlindViaName(),
    solderMaskExpansion: via.getState_SolderMaskExpansion(), locked: via.getState_PrimitiveLock(),
  };
}

export function serializePcbPour(pour: any): JsonObject {
  return {
    id: pour.getState_PrimitiveId(), net: pour.getState_Net() || '', layer: pour.getState_Layer(),
    polygon: polygonSource(pour.getState_ComplexPolygon()), fillMethod: pour.getState_PourFillMethod(),
    preserveSilos: pour.getState_PreserveSilos(), name: pour.getState_PourName(),
    priority: pour.getState_PourPriority(), width: pour.getState_LineWidth(), locked: pour.getState_PrimitiveLock(),
  };
}
