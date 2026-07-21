import assert from "node:assert/strict";
import { planComponentArrangement } from "../src/pcb-layout.mjs";
import { planNetTrackPolicy } from "../src/pcb-policy.mjs";

const policy = planNetTrackPolicy({ unit: "mil", nets: ["VCC", "GND", "SIG"], tracks: [{ id: "l1", net: "VCC", width: 8, layer: 1, locked: false }], trackArcs: [{ id: "a1", net: "GND", width: 10, layer: 1, locked: false }], trackPolylines: [{ id: "p1", net: "VCC_3V3", width: 6, layer: 1, locked: true }] }, { netNames: ["VCC*", "GND"], matchMode: "glob", width: 20 });
assert.equal(policy.matchedTrackCount, 3);
assert.equal(policy.changeCount, 2);
assert.deepEqual(policy.changes.map(item => item.trackId), ["l1", "a1"]);

const snapshot = { unit: "mil", components: [
  { id: "c1", designator: "U1", x: 5, y: 5, bbox: { minX: 0, minY: 0, maxX: 10, maxY: 10 } },
  { id: "c2", designator: "R1", x: 30, y: 20, bbox: { minX: 25, minY: 15, maxX: 35, maxY: 25 } },
  { id: "c3", designator: "R2", x: 55, y: 35, bbox: { minX: 50, minY: 30, maxX: 60, maxY: 40 } },
] };
const arranged = planComponentArrangement(snapshot, ["c1", "c2", "c3"], [{ type: "align", mode: "top" }, { type: "distribute", axis: "horizontal" }, { type: "snap_to_grid", gridX: 5, gridY: 5, originX: 0, originY: 0 }]);
assert.equal(arranged.changeCount, 2);
assert.ok(arranged.components.every(item => item.bbox.top === 0));
assert.ok(arranged.components.every(item => item.after.x % 5 === 0 && item.after.y % 5 === 0));

console.log("pcb policy/layout: ok");
