import assert from "node:assert/strict";
import { boardBounds, compareSchematicToPcb, findComponentOverlaps, findOutsideComponents, findUnroutedNets, inspectWholeBoard } from "../src/pcb-analysis.mjs";

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
assert.equal(findComponentOverlaps(snapshot).length, 1);
assert.deepEqual(findOutsideComponents(snapshot).components.map((item) => item.designator), ["C1"]);
const unrouted = findUnroutedNets(snapshot);
assert.equal(unrouted.unroutedNetCount, 1);
assert.equal(unrouted.nets[0].net, "SIG");
assert.equal(inspectWholeBoard(snapshot).counts.components, 3);

const consistency = compareSchematicToPcb([
  { designator: "R1", footprint: "0402", manufacturerPart: "ABC" },
  { designator: "R3", footprint: "0402" },
], { ...snapshot, components: [
  { designator: "R1", footprint: { name: "0603" }, manufacturerId: "XYZ" },
  { designator: "R2", footprint: "0402" },
] });
assert.deepEqual(consistency.missingOnPcb, ["R3"]);
assert.deepEqual(consistency.extraOnPcb, ["R2"]);
assert.equal(consistency.mismatches[0].designator, "R1");
console.log("pcb-analysis: ok");
