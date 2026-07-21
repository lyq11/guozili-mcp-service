const EPSILON = 0.5;

function allPads(snapshot) {
  return [
    ...(snapshot?.components || []).flatMap((component) => (component.pads || []).map((pad) => ({
      ...pad, designator: component.designator, componentId: component.id,
    }))),
    ...(snapshot?.standalonePads || []).map((pad) => ({ ...pad, designator: null, componentId: null })),
  ];
}

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

function outlineItems(snapshot) {
  return [
    ...(snapshot?.boardOutline?.lines || []).map(item => ({ ...item, kind: "line" })),
    ...(snapshot?.boardOutline?.arcs || []).map(item => ({ ...item, kind: "arc" })),
  ];
}

function outlinePointKey(point, tolerance) {
  return `${Math.round(point.x / tolerance)}:${Math.round(point.y / tolerance)}`;
}

function polylineClosure(polyline, tolerance) {
  const source = polyline?.polygon;
  if (!Array.isArray(source)) return { closed: null, reason: "polygon_source_unavailable" };
  const flat = source.flat(Infinity);
  if (flat.some(value => typeof value === "string" && value.trim().toUpperCase() === "Z")) {
    return { closed: true, reason: "explicit_close_command" };
  }
  const numbers = flat.filter(value => typeof value === "number" && Number.isFinite(value));
  if (numbers.length >= 4 && numbers.length % 2 === 0) {
    const first = { x: numbers[0], y: numbers[1] };
    const last = { x: numbers[numbers.length - 2], y: numbers[numbers.length - 1] };
    return { closed: Math.hypot(first.x - last.x, first.y - last.y) <= tolerance, reason: "endpoint_comparison" };
  }
  return { closed: null, reason: "polygon_source_not_decodable" };
}

/** Locate board-outline primitives and summarize their physical extent. */
export function findBoardOutline(snapshot) {
  const lines = snapshot?.boardOutline?.lines || [];
  const arcs = snapshot?.boardOutline?.arcs || [];
  const polylines = snapshot?.boardOutline?.polylines || [];
  return {
    unit: snapshot?.unit || "mil",
    layer: 11,
    primitiveCount: lines.length + arcs.length + polylines.length,
    counts: { lines: lines.length, arcs: arcs.length, polylines: polylines.length },
    bounds: boardBounds(snapshot),
    primitives: { lines, arcs, polylines },
    found: lines.length + arcs.length + polylines.length > 0,
  };
}

/**
 * Check whether every board-outline chain is closed. Lines and arcs are checked
 * exactly by endpoint topology. Polyline closure is reported separately and
 * produces an indeterminate result when EasyEDA does not expose a decodable path.
 */
export function checkBoardOutline(snapshot, { tolerance = EPSILON } = {}) {
  const items = outlineItems(snapshot);
  const polylines = snapshot?.boardOutline?.polylines || [];
  const endpointBuckets = new Map();
  for (const item of items) {
    for (const point of [{ x: Number(item.startX), y: Number(item.startY) }, { x: Number(item.endX), y: Number(item.endY) }]) {
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
      const key = outlinePointKey(point, tolerance);
      if (!endpointBuckets.has(key)) endpointBuckets.set(key, { x: point.x, y: point.y, count: 0, primitiveIds: [] });
      const bucket = endpointBuckets.get(key);
      bucket.count += 1;
      bucket.primitiveIds.push(item.id || null);
    }
  }
  const openEndpoints = [...endpointBuckets.values()].filter(item => item.count % 2 !== 0);
  const branchPoints = [...endpointBuckets.values()].filter(item => item.count > 2);
  const polylineChecks = polylines.map(item => ({ id: item.id, ...polylineClosure(item, tolerance) }));
  const unknownPolylines = polylineChecks.filter(item => item.closed === null);
  const openPolylines = polylineChecks.filter(item => item.closed === false);
  const primitiveCount = items.length + polylines.length;
  let status = "complete";
  const reasons = [];
  if (!primitiveCount) { status = "incomplete"; reasons.push("no_board_outline_primitives"); }
  if (openEndpoints.length) { status = "incomplete"; reasons.push("open_line_or_arc_endpoints"); }
  if (openPolylines.length) { status = "incomplete"; reasons.push("open_polylines"); }
  if (status === "complete" && unknownPolylines.length) { status = "indeterminate"; reasons.push("polyline_closure_unavailable"); }
  if (branchPoints.length) reasons.push("branching_outline_vertices");
  return {
    status,
    complete: status === "complete",
    reliable: status !== "indeterminate",
    tolerance,
    unit: snapshot?.unit || "mil",
    bounds: boardBounds(snapshot),
    counts: {
      primitives: primitiveCount,
      lines: snapshot?.boardOutline?.lines?.length || 0,
      arcs: snapshot?.boardOutline?.arcs?.length || 0,
      polylines: polylines.length,
      openEndpoints: openEndpoints.length,
      branchPoints: branchPoints.length,
      openPolylines: openPolylines.length,
      unknownPolylines: unknownPolylines.length,
    },
    openEndpoints,
    branchPoints,
    polylineChecks,
    reasons,
  };
}

/** Build a deterministic page-grouped placement plan for PCB components. */
export function planComponentsBySchematicPage(snapshot, schematicComponents, options = {}) {
  const componentGap = Number(options.componentGap ?? 50);
  const groupGap = Number(options.groupGap ?? 200);
  const maxGroupWidth = Number(options.maxGroupWidth ?? 1500);
  const maxLayoutWidth = Number(options.maxLayoutWidth ?? 6000);
  const includeLocked = options.includeLocked === true;
  const pcbByDesignator = new Map((snapshot?.components || []).map(item => [String(item.designator || "").trim().toUpperCase(), item]));
  const groups = new Map();
  const unmatchedSchematic = [];
  for (const component of schematicComponents || []) {
    const designator = String(component.designator || "").trim().toUpperCase();
    const pcb = pcbByDesignator.get(designator);
    if (!pcb) { unmatchedSchematic.push(designator); continue; }
    if (pcb.locked === true && !includeLocked) continue;
    const key = component.pageUuid || component.pageName || "unassigned";
    if (!groups.has(key)) groups.set(key, { pageUuid: component.pageUuid || null, pageName: component.pageName || "Unassigned", components: [] });
    groups.get(key).components.push(pcb);
  }
  const boxes = (snapshot?.components || []).map(bboxOf).filter(Boolean);
  const originX = Number(options.originX ?? (boxes.length ? Math.min(...boxes.map(box => box.left)) : 0));
  const originY = Number(options.originY ?? (boxes.length ? Math.min(...boxes.map(box => box.top)) : 0));
  let layoutX = originX; let layoutY = originY; let layoutRowHeight = 0;
  const changes = []; const plannedGroups = [];
  for (const group of groups.values()) {
    let localX = 0; let localY = 0; let rowHeight = 0; let usedWidth = 0;
    const placements = [];
    for (const component of group.components.sort((a, b) => String(a.designator).localeCompare(String(b.designator), undefined, { numeric: true }))) {
      const box = bboxOf(component) || { left: Number(component.x), right: Number(component.x), top: Number(component.y), bottom: Number(component.y) };
      const width = Math.max(1, box.right - box.left); const height = Math.max(1, box.bottom - box.top);
      if (localX > 0 && localX + width > maxGroupWidth) { localX = 0; localY += rowHeight + componentGap; rowHeight = 0; }
      placements.push({ component, box, localX, localY, width, height });
      localX += width + componentGap; usedWidth = Math.max(usedWidth, localX - componentGap); rowHeight = Math.max(rowHeight, height);
    }
    const groupWidth = Math.max(1, usedWidth); const groupHeight = Math.max(1, localY + rowHeight);
    if (layoutX > originX && layoutX + groupWidth > originX + maxLayoutWidth) { layoutX = originX; layoutY += layoutRowHeight + groupGap; layoutRowHeight = 0; }
    const groupChanges = placements.map(({ component, box, localX: dx, localY: dy }) => ({
      componentId: component.id,
      designator: component.designator,
      x: layoutX + dx + (Number(component.x) - box.left),
      y: layoutY + dy + (Number(component.y) - box.top),
    }));
    changes.push(...groupChanges.map(({ componentId, x, y }) => ({ componentId, x, y })));
    plannedGroups.push({ pageUuid: group.pageUuid, pageName: group.pageName, componentCount: groupChanges.length, bounds: { left: layoutX, top: layoutY, right: layoutX + groupWidth, bottom: layoutY + groupHeight }, components: groupChanges });
    layoutX += groupWidth + groupGap; layoutRowHeight = Math.max(layoutRowHeight, groupHeight);
  }
  const matched = new Set(changes.map(item => item.componentId));
  return {
    unit: snapshot?.unit || "mil",
    options: { originX, originY, componentGap, groupGap, maxGroupWidth, maxLayoutWidth, includeLocked },
    groupCount: plannedGroups.length,
    componentCount: changes.length,
    groups: plannedGroups,
    changes,
    unmatchedSchematic: [...new Set(unmatchedSchematic.filter(Boolean))],
    unmatchedPcb: (snapshot?.components || []).filter(item => !matched.has(item.id)).map(item => ({ id: item.id, designator: item.designator, locked: item.locked === true })),
  };
}

function segmentsTouch(a, b, tolerance) {
  const endpointsA = [{ x: Number(a.startX), y: Number(a.startY) }, { x: Number(a.endX), y: Number(a.endY) }];
  const endpointsB = [{ x: Number(b.startX), y: Number(b.startY) }, { x: Number(b.endX), y: Number(b.endY) }];
  return endpointsA.some((point) => distanceToSegment(point, b) <= tolerance)
    || endpointsB.some((point) => distanceToSegment(point, a) <= tolerance);
}

function trackBounds(track) {
  return {
    left: Math.min(Number(track.startX), Number(track.endX)),
    right: Math.max(Number(track.startX), Number(track.endX)),
    top: Math.min(Number(track.startY), Number(track.endY)),
    bottom: Math.max(Number(track.startY), Number(track.endY)),
  };
}

function groupBy(items, keyOf) {
  const groups = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

function connectedTrackGroups(tracks, tolerance, stats) {
  const connected = [];
  const netLayerGroups = groupBy(tracks, track => JSON.stringify([track.net, Number(track.layer)]));
  stats.netLayerGroupCount = netLayerGroups.size;
  for (const netLayerTracks of netLayerGroups.values()) {
    stats.groupedPairCount += netLayerTracks.length * (netLayerTracks.length - 1) / 2;
    const parents = netLayerTracks.map((_, index) => index);
    const root = (index) => {
      while (parents[index] !== index) { parents[index] = parents[parents[index]]; index = parents[index]; }
      return index;
    };
    const join = (left, right) => { left = root(left); right = root(right); if (left !== right) parents[right] = left; };
    const spatial = netLayerTracks.map((track, index) => ({ track, index, bounds: trackBounds(track) }))
      .sort((left, right) => left.bounds.left - right.bounds.left);
    for (let left = 0; left < spatial.length; left += 1) {
      const a = spatial[left];
      for (let right = left + 1; right < spatial.length; right += 1) {
        const b = spatial[right];
        if (b.bounds.left > a.bounds.right + tolerance) break;
        if (b.bounds.top > a.bounds.bottom + tolerance || b.bounds.bottom < a.bounds.top - tolerance) continue;
        stats.spatialCandidatePairCount += 1;
        if (segmentsTouch(a.track, b.track, tolerance)) join(a.index, b.index);
      }
    }
    const localGroups = new Map();
    netLayerTracks.forEach((track, index) => {
      const key = root(index);
      if (!localGroups.has(key)) localGroups.set(key, []);
      localGroups.get(key).push(track);
    });
    connected.push(...localGroups.values());
  }
  return connected;
}

/**
 * Find straight-track copper islands that do not touch a component pad or via.
 *
 * Nets containing pours, arc tracks, or polyline tracks are skipped because the
 * cached snapshot cannot yet prove their full geometric connectivity. This is
 * intentionally conservative: deletion must prefer leaving a suspect segment
 * behind over removing intentional copper.
 */
export function findDanglingTracks(snapshot, { tolerance = EPSILON, includeLocked = false } = {}) {
  const poursByNet = new Set((snapshot?.pours || []).map((item) => item.net).filter(Boolean));
  const arcsByNet = new Set((snapshot?.trackArcs || []).map((item) => item.net).filter(Boolean));
  const polylinesByNet = new Set((snapshot?.trackPolylines || []).map((item) => item.net).filter(Boolean));
  const skippedNets = new Map();
  for (const net of new Set([...poursByNet, ...arcsByNet, ...polylinesByNet])) {
    const reasons = [];
    if (poursByNet.has(net)) reasons.push("copper_pour");
    if (arcsByNet.has(net)) reasons.push("arc_track");
    if (polylinesByNet.has(net)) reasons.push("polyline_track");
    skippedNets.set(net, reasons);
  }

  const tracks = (snapshot?.tracks || []).filter((track) => track?.id && track?.net && !skippedNets.has(track.net));
  const comparisonStats = {
    trackCount: tracks.length,
    globalPairCount: tracks.length * (tracks.length - 1) / 2,
    netLayerGroupCount: 0,
    groupedPairCount: 0,
    spatialCandidatePairCount: 0,
  };
  const groups = connectedTrackGroups(tracks, tolerance, comparisonStats);
  const padsByNet = groupBy(allPads(snapshot).filter(pad => pad.net), pad => pad.net);
  const viasByNet = groupBy((snapshot?.vias || []).filter(via => via.net), via => via.net);
  const danglingGroups = [];
  for (const group of groups) {
    const net = group[0].net;
    const bounds = group.reduce((box, track) => {
      const item = trackBounds(track);
      return { left: Math.min(box.left, item.left), right: Math.max(box.right, item.right), top: Math.min(box.top, item.top), bottom: Math.max(box.bottom, item.bottom) };
    }, { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity });
    const touches = point => {
      const x = Number(point.x); const y = Number(point.y);
      if (x < bounds.left - tolerance || x > bounds.right + tolerance || y < bounds.top - tolerance || y > bounds.bottom + tolerance) return false;
      return group.some(track => distanceToSegment({ x, y }, track) <= tolerance);
    };
    const touchesPad = (padsByNet.get(net) || []).some(touches);
    const touchesVia = (viasByNet.get(net) || []).some(touches);
    if (touchesPad || touchesVia) continue;
    const lockedTrackIds = group.filter((track) => track.locked === true).map((track) => track.id);
    const deletableTracks = includeLocked ? group : group.filter((track) => track.locked !== true);
    if (!deletableTracks.length) continue;
    danglingGroups.push({
      net,
      layer: group[0].layer,
      trackCount: group.length,
      trackIds: deletableTracks.map((track) => track.id),
      lockedTrackIds,
      totalLength: group.reduce((sum, track) => sum + Math.hypot(Number(track.endX) - Number(track.startX), Number(track.endY) - Number(track.startY)), 0),
      bounds,
    });
  }
  return {
    tolerance,
    includeLocked,
    danglingGroupCount: danglingGroups.length,
    danglingTrackCount: danglingGroups.reduce((sum, group) => sum + group.trackIds.length, 0),
    groups: danglingGroups,
    comparisonStats,
    skippedNets: [...skippedNets].map(([net, reasons]) => ({ net, reasons })),
    caveat: "Only straight-track islands are deleted. Nets containing copper pours, arc tracks, or polyline tracks are skipped because their connectivity cannot be proven from the cached geometry.",
  };
}

function netName(item) {
  return typeof item === "string" ? item : String(item?.name || item?.net || "");
}

export function findUnroutedNets(snapshot, { tolerance = EPSILON } = {}) {
  const names = new Set((snapshot?.nets || []).map(netName).filter(Boolean));
  for (const pad of allPads(snapshot)) if (pad.net) names.add(pad.net);
  const results = [];
  for (const net of names) {
    const pads = allPads(snapshot).filter((pad) => pad.net === net)
      .map((pad) => ({ id: pad.id, componentId: pad.componentId, designator: pad.designator, number: pad.number, x: Number(pad.x), y: Number(pad.y), layer: pad.layer }));
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

export function compareSchematicToPcb(schematicComponents, snapshot, schematicNetNames = []) {
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
  const schematicNets = new Set([...(schematicNetNames || []), ...(schematicComponents || []).flatMap((component) => component.nets || [])].filter(Boolean));
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
      pads: allPads(snapshot).length,
      nets: snapshot?.nets?.length || 0, tracks: (snapshot?.tracks?.length || 0) + (snapshot?.trackArcs?.length || 0) + (snapshot?.trackPolylines?.length || 0),
      vias: snapshot?.vias?.length || 0, pours: snapshot?.pours?.length || 0,
    },
    findings: { componentOverlaps: overlaps, outsideBoard: outside, unrouted },
  };
}
