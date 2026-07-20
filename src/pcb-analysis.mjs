const EPSILON = 0.5;

function bboxOf(value) {
  const box = value?.bbox;
  if (!box) return null;
  const left = Number(box.minX ?? box.left);
  const right = Number(box.maxX ?? box.right);
  const top = Number(box.minY ?? box.top);
  const bottom = Number(box.maxY ?? box.bottom);
  return [left, right, top, bottom].every(Number.isFinite) ? { left, right, top, bottom } : null;
}

function overlap(a, b, clearance = 0) {
  return a.left < b.right + clearance && a.right > b.left - clearance
    && a.top < b.bottom + clearance && a.bottom > b.top - clearance;
}

export function boardBounds(snapshot) {
  const points = [];
  for (const item of [...(snapshot?.boardOutline?.lines || []), ...(snapshot?.boardOutline?.arcs || [])]) {
    points.push([Number(item.startX), Number(item.startY)], [Number(item.endX), Number(item.endY)]);
  }
  const polylineBoxes = (snapshot?.boardOutline?.polylines || []).map(bboxOf).filter(Boolean);
  for (const box of polylineBoxes) points.push([box.left, box.top], [box.right, box.bottom]);
  const valid = points.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (!valid.length) return null;
  return {
    left: Math.min(...valid.map(([x]) => x)), right: Math.max(...valid.map(([x]) => x)),
    top: Math.min(...valid.map(([, y]) => y)), bottom: Math.max(...valid.map(([, y]) => y)),
    approximate: (snapshot?.boardOutline?.arcs?.length || 0) > 0 || polylineBoxes.length > 0,
  };
}

export function findComponentOverlaps(snapshot, { clearance = 0 } = {}) {
  const components = (snapshot?.components || []).map((component) => ({ component, box: bboxOf(component) })).filter((item) => item.box);
  const overlaps = [];
  for (let left = 0; left < components.length; left += 1) {
    for (let right = left + 1; right < components.length; right += 1) {
      const a = components[left]; const b = components[right];
      if (Number(a.component.layer) !== 12 && Number(b.component.layer) !== 12
        && Number(a.component.layer) !== Number(b.component.layer)) continue;
      if (overlap(a.box, b.box, clearance)) overlaps.push({
        first: { id: a.component.id, designator: a.component.designator, layer: a.component.layer, bbox: a.component.bbox },
        second: { id: b.component.id, designator: b.component.designator, layer: b.component.layer, bbox: b.component.bbox },
      });
    }
  }
  return overlaps;
}

export function findOutsideComponents(snapshot, { margin = 0 } = {}) {
  const board = boardBounds(snapshot);
  if (!board) return { boardBounds: null, components: [], reliable: false, reason: "No board-outline primitives" };
  const components = (snapshot?.components || []).flatMap((component) => {
    const box = bboxOf(component);
    if (!box) return [];
    const outside = box.left < board.left - margin || box.right > board.right + margin
      || box.top < board.top - margin || box.bottom > board.bottom + margin;
    return outside ? [{ id: component.id, designator: component.designator, layer: component.layer, bbox: component.bbox }] : [];
  });
  return { boardBounds: board, components, reliable: !board.approximate, reason: board.approximate ? "Board containment uses the outline bounding box; curved or concave edges require visual confirmation" : null };
}

function distanceToSegment(point, line) {
  const x1 = Number(line.startX); const y1 = Number(line.startY); const x2 = Number(line.endX); const y2 = Number(line.endY);
  const dx = x2 - x1; const dy = y2 - y1;
  if (dx === 0 && dy === 0) return Math.hypot(point.x - x1, point.y - y1);
  const t = Math.max(0, Math.min(1, ((point.x - x1) * dx + (point.y - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(point.x - (x1 + t * dx), point.y - (y1 + t * dy));
}

function netName(item) {
  return typeof item === "string" ? item : String(item?.name || item?.net || "");
}

export function findUnroutedNets(snapshot, { tolerance = EPSILON } = {}) {
  const names = new Set((snapshot?.nets || []).map(netName).filter(Boolean));
  for (const component of snapshot?.components || []) for (const pad of component.pads || []) if (pad.net) names.add(pad.net);
  const results = [];
  for (const net of names) {
    const pads = (snapshot?.components || []).flatMap((component) => (component.pads || [])
      .filter((pad) => pad.net === net)
      .map((pad) => ({ id: pad.id, componentId: component.id, designator: component.designator, number: pad.number, x: Number(pad.x), y: Number(pad.y), layer: pad.layer })));
    if (pads.length < 2) continue;
    const tracks = (snapshot?.tracks || []).filter((track) => track.net === net);
    const vias = (snapshot?.vias || []).filter((via) => via.net === net).map((via) => ({ x: Number(via.x), y: Number(via.y) }));
    const nodes = [...pads.map((pad) => ({ x: pad.x, y: pad.y })), ...vias,
      ...tracks.flatMap((track) => [{ x: Number(track.startX), y: Number(track.startY) }, { x: Number(track.endX), y: Number(track.endY) }])];
    const parent = nodes.map((_, index) => index);
    const root = (index) => { while (parent[index] !== index) { parent[index] = parent[parent[index]]; index = parent[index]; } return index; };
    const join = (a, b) => { a = root(a); b = root(b); if (a !== b) parent[b] = a; };
    for (let a = 0; a < nodes.length; a += 1) for (let b = a + 1; b < nodes.length; b += 1) {
      if (Math.hypot(nodes[a].x - nodes[b].x, nodes[a].y - nodes[b].y) <= tolerance) join(a, b);
    }
    tracks.forEach((track, trackIndex) => {
      const offset = pads.length + vias.length + trackIndex * 2;
      join(offset, offset + 1);
      nodes.forEach((point, index) => { if (distanceToSegment(point, track) <= tolerance) join(offset, index); });
    });
    const groups = new Map();
    pads.forEach((pad, index) => {
      const key = root(index);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(pad);
    });
    if (groups.size > 1) results.push({
      net, padCount: pads.length, connectedGroups: [...groups.values()],
      hasPours: (snapshot?.pours || []).some((pour) => pour.net === net),
      hasArcTracks: (snapshot?.trackArcs || []).some((arc) => arc.net === net),
      hasPolylineTracks: (snapshot?.trackPolylines || []).some((polyline) => polyline.net === net),
    });
  }
  return {
    tolerance, unroutedNetCount: results.length, nets: results,
    caveat: "Connectivity includes pad centers, straight tracks, and vias. Copper pours, arc tracks, and polyline tracks are reported but not used to prove connectivity.",
  };
}

function identity(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value).trim().toLocaleLowerCase();
  return identity(value.name || value.uuid || value.libraryUuid || value.id || JSON.stringify(value));
}

export function compareSchematicToPcb(schematicComponents, snapshot) {
  const schematicByDesignator = new Map(); const pcbByDesignator = new Map();
  for (const item of schematicComponents || []) {
    const key = String(item.designator || "").trim().toUpperCase();
    if (!key) continue;
    if (!schematicByDesignator.has(key)) schematicByDesignator.set(key, []);
    schematicByDesignator.get(key).push(item);
  }
  for (const item of snapshot?.components || []) {
    const key = String(item.designator || "").trim().toUpperCase();
    if (!key) continue;
    if (!pcbByDesignator.has(key)) pcbByDesignator.set(key, []);
    pcbByDesignator.get(key).push(item);
  }
  const duplicateSchematic = [...schematicByDesignator].filter(([, items]) => items.length > 1).map(([designator, items]) => ({ designator, count: items.length }));
  const duplicatePcb = [...pcbByDesignator].filter(([, items]) => items.length > 1).map(([designator, items]) => ({ designator, count: items.length }));
  const missingOnPcb = [...schematicByDesignator.keys()].filter((key) => !pcbByDesignator.has(key));
  const extraOnPcb = [...pcbByDesignator.keys()].filter((key) => !schematicByDesignator.has(key));
  const mismatches = [];
  for (const [designator, schematicItems] of schematicByDesignator) {
    const pcbItems = pcbByDesignator.get(designator);
    if (schematicItems.length !== 1 || pcbItems?.length !== 1) continue;
    const schematic = schematicItems[0]; const pcb = pcbItems[0];
    const fields = [
      ["footprint", schematic.footprint, pcb.footprint],
      ["manufacturer", schematic.manufacturer, pcb.manufacturer],
      ["manufacturerPart", schematic.manufacturerPart, pcb.manufacturerId],
      ["supplier", schematic.supplier, pcb.supplier],
      ["supplierPart", schematic.supplierPart, pcb.supplierId],
    ];
    const differences = fields.flatMap(([field, left, right]) => identity(left) && identity(right) && identity(left) !== identity(right)
      ? [{ field, schematic: left, pcb: right }] : []);
    if (differences.length) mismatches.push({ designator, differences });
  }
  const schematicNets = new Set((schematicComponents || []).flatMap((component) => component.nets || []).filter(Boolean));
  const pcbNets = new Set((snapshot?.nets || []).map(netName).filter(Boolean));
  return {
    schematicComponentCount: schematicComponents?.length || 0, pcbComponentCount: snapshot?.components?.length || 0,
    duplicateSchematic, duplicatePcb, missingOnPcb, extraOnPcb, mismatches,
    nets: {
      schematicOnly: [...schematicNets].filter((net) => !pcbNets.has(net)),
      pcbOnly: [...pcbNets].filter((net) => !schematicNets.has(net)),
    },
  };
}

export function inspectWholeBoard(snapshot, options = {}) {
  const overlaps = findComponentOverlaps(snapshot, options);
  const outside = findOutsideComponents(snapshot, options);
  const unrouted = findUnroutedNets(snapshot, options);
  return {
    board: snapshot?.board, unit: snapshot?.unit || "mil", boardBounds: outside.boardBounds,
    counts: {
      layers: snapshot?.layers?.length || 0, components: snapshot?.components?.length || 0,
      pads: (snapshot?.components || []).reduce((sum, item) => sum + (item.pads?.length || 0), 0),
      nets: snapshot?.nets?.length || 0, tracks: (snapshot?.tracks?.length || 0) + (snapshot?.trackArcs?.length || 0) + (snapshot?.trackPolylines?.length || 0),
      vias: snapshot?.vias?.length || 0, pours: snapshot?.pours?.length || 0,
    },
    findings: { componentOverlaps: overlaps, outsideBoard: outside, unrouted },
  };
}
