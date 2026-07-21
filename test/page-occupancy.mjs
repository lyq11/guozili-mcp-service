import assert from "node:assert/strict";
import { OCCUPANCY, PageOccupancyCache, PageOccupancyGrid } from "../src/page-occupancy.mjs";

const page = {
  page: { uuid: "page-1", name: "Main" },
  components: [
    { id: "e1", type: "sheet", x: 0, y: 0, bbox: { minX: 0, minY: 0, maxX: 1635, maxY: 1160 }, pins: [] },
    { id: "U1", type: "part", x: 150, y: 150, bbox: { minX: 100, minY: 100, maxX: 200, maxY: 200 }, pins: [] },
    { id: "P1", type: "netport", x: 320, y: 120, bbox: { minX: 290, minY: 110, maxX: 350, maxY: 130 }, pins: [] },
    { id: "P2", type: "netport", net: "A_VERY_LONG_PORT_NAME", x: 900, y: 400, rotation: 0, bbox: { minX: 0, minY: 0, maxX: 920, maxY: 420 }, pins: [] },
    { id: "BAD", type: "part", x: 700, y: 700, bbox: { minX: 0, minY: 0, maxX: 900, maxY: 900 }, pins: [{ x: 680, y: 700 }, { x: 720, y: 700 }] },
  ],
  wires: [{ id: "W1", line: [400, 100, 500, 100, 500, 200] }],
};

const grid = new PageOccupancyGrid(page);
assert.equal(grid.columns, 327);
assert.equal(grid.rows, 232);
assert.deepEqual(grid.worldToCell(25, 35), { column: 5, row: 7 });
assert.deepEqual(grid.cellToWorld(5, 7), { x: 27.5, y: 37.5 });
assert.equal(grid.isBoundsFree({ left: 120, top: 120, right: 180, bottom: 180 }), false);
assert.ok(grid.countBounds({ left: 300, top: 110, right: 340, bottom: 130 }, OCCUPANCY.PORT) > 0);
assert.ok(grid.countBounds({ left: 820, top: 390, right: 850, bottom: 410 }, OCCUPANCY.PORT) > 0, "fallback netport bounds must include the visible label rectangle");
assert.ok(grid.countBounds({ left: 450, top: 95, right: 460, bottom: 105 }, OCCUPANCY.WIRE) > 0);
assert.equal(grid.isBoundsFree({ left: 600, top: 400, right: 650, bottom: 450 }), true);
assert.equal(grid.isBoundsFree({ left: 40, top: 40, right: 60, bottom: 60 }), true, "an implausible origin-spanning BBox must be ignored");
assert.equal(grid.isBoundsFree({ left: 690, top: 690, right: 710, bottom: 710 }), false);
assert.equal(grid.isBoundsFree({ left: 5, top: 400, right: 15, bottom: 450 }), false, "sheet border margin must be reserved");
assert.equal(grid.isBoundsFree({ left: 1100, top: 80, right: 1200, bottom: 130 }), false, "title block must be reserved at visually bottom/right low-Y coordinates");
assert.ok(grid.countBounds({ left: 450, top: 90, right: 460, bottom: 95 }, OCCUPANCY.WIRE) > 0, "wire corridor must include clearance");

const free = grid.findFreeRectangles({ width: 80, height: 50, count: 2, clearance: 10, preferredX: 150, preferredY: 150 });
assert.equal(free.length, 2);
for (const item of free) {
  assert.equal(grid.isBoundsFree(item.keepOutBounds), true);
}
assert.equal(rectanglesOverlap(free[0].keepOutBounds, free[1].keepOutBounds), false);

const description = grid.describe({ includeRows: true });
assert.equal(description.totalCells, 327 * 232);
assert.ok(description.occupiedCells > 0);
assert.ok(description.geometryOccupiedRatio < description.placementBlockedRatio);
assert.equal(description.occupiedRatio, description.placementBlockedRatio);
assert.ok(description.placementBlockedRatio > 0.1, "placement occupancy must include border, title block and clearances");
assert.ok(description.placementBlockedRatio < 0.3, "placement keepouts must not consume the useful canvas");
assert.ok(Math.abs(description.placementPolicy.titleBlockBounds.left - 915.6) < 1e-9);
assert.ok(Math.abs(description.placementPolicy.titleBlockBounds.bottom - 162.4) < 1e-9);
assert.ok(description.rowRuns.length > 0);

const cache = new PageOccupancyCache();
assert.equal(cache.get("page-1", page), cache.get("page-1", page));
cache.invalidate("page-1");
assert.notEqual(cache.get("page-1", page), grid);

const expanded = new PageOccupancyGrid({
  page: { uuid: "outside" },
  components: [{ id: "U2", type: "part", x: -20, y: -10, pins: [] }],
  wires: [],
});
assert.ok(expanded.bounds.left < 0);
assert.ok(expanded.bounds.top < 0);

const empty = new PageOccupancyGrid({ page: { uuid: "empty", showTitleBlock: false }, components: [], wires: [] }, {
  canvas: { left: 0, top: 0, right: 1000, bottom: 800 },
  exactCanvas: true,
  borderMargin: 0,
});
const centered = empty.findFreeRectangles({ width: 100, height: 80, clearance: 10 });
assert.deepEqual({ x: centered[0].x, y: centered[0].y }, { x: 500, y: 400 });

console.log("Page occupancy grid tests passed");

function rectanglesOverlap(left, right) {
  return !(left.right < right.left || left.left > right.right || left.bottom < right.top || left.top > right.bottom);
}
