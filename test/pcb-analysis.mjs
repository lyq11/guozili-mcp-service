import assert from "node:assert/strict";
import {
  boardBounds, checkBoardOutline, compareSchematicToPcb, findBoardOutline,
  findComponentOverlaps, findDanglingTracks, findOutsideComponents, findUnroutedNets,
  inspectWholeBoard, planComponentsBySchematicPage,
} from "../src/pcb-analysis.mjs";

const pad = (id, net, x, y) => ({ id, number: id, net, x, y, layer: 1 });
const snapshot = {
  unit: "mil",
  layers: [{ id: 1 }, { id: 2 }, { id: 11 }],
  nets: ["GND", "SIG"],
  boardOutline: { lines: [
    { startX: 0, startY: 0, endX: 100, endY: 0 }, { startX: 100, startY: 0, endX: 100, endY: 100 },
    { startX: 100, startY: 100, endX: 0, endY: 100 }, { startX: 0, startY: 100, endX: 0, endY: 0 },
  ], arcs: [] },
  components: [
    { id: "c1", designator: "R1", layer: 1, bbox: { minX: 10, minY: 10, maxX: 30, maxY: 30 }, pads: [pad("p1", "SIG", 10, 20)] },
    { id: "c2", designator: "R2", layer: 1, bbox: { minX: 20, minY: 20, maxX: 40, maxY: 40 }, pads: [pad("p2", "SIG", 90, 20)] },
    { id: "c3", designator: "C1", layer: 1, bbox: { minX: 95, minY: 95, maxX: 110, maxY: 110 }, pads: [] },
  ],
  tracks: [{ id: "t1", net: "SIG", layer: 1, startX: 10, startY: 20, endX: 50, endY: 20, width: 6 }],
  trackArcs: [], vias: [], pours: [],
};

assert.deepEqual(boardBounds(snapshot), { left: 0, right: 100, top: 0, bottom: 100, approximate: false });
assert.deepEqual(boardBounds({ boardOutline: { lines: [], arcs: [], polylines: [{ bbox: { minX: -10, minY: -20, maxX: 90, maxY: 80 } }] } }),
  { left: -10, right: 90, top: -20, bottom: 80, approximate: true });
assert.equal(findBoardOutline(snapshot).primitiveCount, 4);
assert.equal(checkBoardOutline(snapshot).status, "complete");
assert.equal(checkBoardOutline({ boardOutline: { lines: snapshot.boardOutline.lines.slice(0, 3), arcs: [], polylines: [] } }).counts.openEndpoints, 2);
assert.equal(checkBoardOutline({ boardOutline: { lines: [], arcs: [], polylines: [{ id: "p1", polygon: ["M", 0, 0, "L", 10, 0, "Z"] }] } }).status, "complete");
assert.equal(findComponentOverlaps(snapshot).length, 1);
assert.deepEqual(findOutsideComponents(snapshot).components.map((item) => item.designator), ["C1"]);
const unrouted = findUnroutedNets(snapshot);
assert.equal(unrouted.unroutedNetCount, 1);
assert.equal(unrouted.nets[0].net, "SIG");
assert.equal(inspectWholeBoard(snapshot).counts.components, 3);

const danglingSnapshot = {
  ...snapshot,
  components: [{ id: "c1", designator: "R1", pads: [pad("p1", "SIG", 0, 0)] }],
  tracks: [
    { id: "anchored", net: "SIG", layer: 1, startX: 0, startY: 0, endX: 10, endY: 0 },
    { id: "loose-a", net: "SIG", layer: 1, startX: 50, startY: 50, endX: 60, endY: 50 },
    { id: "loose-b", net: "SIG", layer: 1, startX: 60, startY: 50, endX: 70, endY: 50 },
    { id: "locked", net: "LOCK", layer: 1, startX: 80, startY: 80, endX: 90, endY: 80, locked: true },
    { id: "poured", net: "GND", layer: 1, startX: 20, startY: 20, endX: 30, endY: 20 },
  ],
  pours: [{ id: "pour", net: "GND", layer: 1 }],
};
const dangling = findDanglingTracks(danglingSnapshot);
assert.equal(dangling.danglingGroupCount, 1);
assert.deepEqual(dangling.groups[0].trackIds, ["loose-a", "loose-b"]);
assert.deepEqual(dangling.comparisonStats, {
  trackCount: 4, globalPairCount: 6, netLayerGroupCount: 2, groupedPairCount: 3, spatialCandidatePairCount: 1,
});
assert.deepEqual(findDanglingTracks(danglingSnapshot, { includeLocked: true }).groups.flatMap(group => group.trackIds), ["loose-a", "loose-b", "locked"]);

const separatedTracks = Array.from({ length: 500 }, (_, index) => ({
  id: `separate-${index}`, net: `NET-${index}`, layer: 1, startX: index * 20, startY: 0, endX: index * 20 + 10, endY: 0,
}));
const separated = findDanglingTracks({ components: [], tracks: separatedTracks, vias: [], pours: [], trackArcs: [], trackPolylines: [] });
assert.equal(separated.comparisonStats.globalPairCount, 124750);
assert.equal(separated.comparisonStats.groupedPairCount, 0);
assert.equal(separated.comparisonStats.spatialCandidatePairCount, 0);

const consistency = compareSchematicToPcb([
  { designator: "R1", footprint: "0402", manufacturerPart: "ABC" },
  { designator: "R3", footprint: "0402" },
], { ...snapshot, components: [
  { designator: "R1", footprint: { name: "0603" }, manufacturerId: "XYZ" },
  { designator: "R2", footprint: "0402" },
] }, ["SIG", "SCHEMATIC_ONLY"]);
assert.deepEqual(consistency.missingOnPcb, ["R3"]);
assert.deepEqual(consistency.extraOnPcb, ["R2"]);
assert.equal(consistency.mismatches[0].designator, "R1");
assert.deepEqual(consistency.nets.schematicOnly, ["SCHEMATIC_ONLY"]);

const grouping = planComponentsBySchematicPage(snapshot, [
  { designator: "R1", pageUuid: "page-a", pageName: "Power" },
  { designator: "R2", pageUuid: "page-b", pageName: "Signals" },
], { originX: 1000, originY: 2000, maxGroupWidth: 500, maxLayoutWidth: 2000 });
assert.equal(grouping.groupCount, 2);
assert.equal(grouping.componentCount, 2);
assert.deepEqual(grouping.groups.map(group => group.pageName), ["Power", "Signals"]);
assert.deepEqual(grouping.changes.map(change => change.componentId), ["c1", "c2"]);
console.log("pcb-analysis: ok");
