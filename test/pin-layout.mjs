import assert from "node:assert/strict";
import {
  annotatePagePinLayouts,
  boundsOverlap,
  estimateModuleBounds,
  inferPinLayout,
  planPortForPin,
} from "../src/pin-layout.mjs";

const twoSided = inferPinLayout({
  x: 400,
  y: 300,
  pins: [
    { number: "3", x: 360, y: 320 },
    { number: "4", x: 440, y: 280 },
    { number: "1", x: 360, y: 280 },
    { number: "6", x: 440, y: 320 },
    { number: "2", x: 360, y: 300 },
    { number: "5", x: 440, y: 300 },
  ],
});

assert.equal(twoSided.kind, "two-sided");
assert.deepEqual(twoSided.occupiedSides, ["left", "right"]);
assert.deepEqual(twoSided.sides.left.map((pin) => pin.number), ["1", "2", "3"]);
assert.deepEqual(twoSided.sides.right.map((pin) => pin.number), ["4", "5", "6"]);
assert.deepEqual(twoSided.sides.left.map((pin) => pin.order), [1, 2, 3]);

const fourSided = inferPinLayout({
  x: 100,
  y: 100,
  pins: [
    { number: "L", x: 60, y: 100 },
    { number: "R", x: 140, y: 100 },
    { number: "T", x: 100, y: 60 },
    { number: "B", x: 100, y: 140 },
  ],
});

assert.equal(fourSided.kind, "four-sided");
assert.deepEqual(fourSided.occupiedSides, ["left", "right", "top", "bottom"]);
assert.deepEqual(fourSided.pins.map((pin) => pin.side), ["left", "right", "top", "bottom"]);

const rotated = inferPinLayout({
  x: 0,
  y: 0,
  rotation: 90,
  pins: [
    { number: "1", x: 0, y: -30 },
    { number: "2", x: 0, y: 30 },
  ],
});

assert.deepEqual(rotated.occupiedSides, ["top", "bottom"]);
assert.equal(rotated.kind, "two-sided");
assert.deepEqual(inferPinLayout({ x: 0, y: 0, pins: [] }).occupiedSides, []);
assert.throws(() => inferPinLayout({ x: 0, y: 0, pins: [{ x: "0", y: 1 }] }), TypeError);

const leftPort = planPortForPin({
  id: "U1", x: 100, y: 100, pins: [{ number: "1", x: 60, y: 90 }],
}, "1", { offset: 30 });
assert.deepEqual(leftPort.port, { x: 30, y: 90, rotation: 0 });
assert.deepEqual(leftPort.line, [60, 90, 30, 90]);
assert.equal(leftPort.side, "left");
assert.equal(leftPort.routing.strategy, "direct");
assert.equal(leftPort.routing.clear, true);

const bottomPort = planPortForPin({
  id: "U2", x: 100, y: 100, pins: [{ number: "5", x: 110, y: 140 }],
}, "5", { offset: 20 });
assert.deepEqual(bottomPort.port, { x: 110, y: 160, rotation: 90 });
assert.deepEqual(bottomPort.line, [110, 140, 110, 160]);
assert.throws(() => planPortForPin({ id: "U1", x: 0, y: 0, pins: [] }, "1"), /not found/);
assert.throws(() => planPortForPin({ id: "U1", x: 0, y: 0, pins: [] }, "1", { offset: 0 }), TypeError);

const obstacleAwareComponent = {
  id: "U4", x: 100, y: 100, pins: [{ number: "1", x: 60, y: 100 }],
};
const componentDetour = planPortForPin(obstacleAwareComponent, "1", {
  offset: 40,
  obstacles: {
    components: [obstacleAwareComponent, { id: "U5", type: "part", x: 30, y: 100, pins: [] }],
    wires: [],
  },
});
assert.equal(componentDetour.routing.strategy, "detour");
assert.equal(componentDetour.routing.blockingComponents, 0);
assert.equal(componentDetour.routing.wireCrossings, 0);
assert.deepEqual(componentDetour.line, [60, 100, 50, 100, 50, 60, 20, 60]);

const rectangularPort = planPortForPin({
  ...obstacleAwareComponent,
  bbox: { minX: 60, minY: 80, maxX: 120, maxY: 120 },
}, "1", {
  offset: 40,
  net: "LONG_NET_NAME",
  direction: "OUT",
  obstacles: {
    components: [{
      ...obstacleAwareComponent,
      bbox: { minX: 60, minY: 80, maxX: 120, maxY: 120 },
    }],
    wires: [],
  },
});
assert.equal(rectangularPort.routing.strategy, "extended-direct");
assert.ok(rectangularPort.portBounds.right < 50, "the complete port rectangle must clear the source component");

const wireDetour = planPortForPin(obstacleAwareComponent, "1", {
  offset: 40,
  obstacles: {
    components: [obstacleAwareComponent],
    wires: [{ id: "W1", line: [40, 80, 40, 120] }],
  },
});
assert.equal(wireDetour.routing.strategy, "detour");
assert.equal(wireDetour.routing.wireCrossings, 0);
assert.deepEqual(wireDetour.port, { x: 20, y: 60, rotation: 0 });

assert.throws(() => planPortForPin(obstacleAwareComponent, "1", {
  offset: 40,
  obstacles: {
    components: [
      obstacleAwareComponent,
      { id: "BLOCK", x: 0, y: 100, pins: [{ x: -200, y: -100 }, { x: 80, y: 300 }] },
    ],
    wires: [],
  },
}), /No clear outward port route/);

const annotated = annotatePagePinLayouts({
  page: { uuid: "page-1" },
  components: [
    { id: "U3", type: "part", x: 0, y: 0, pins: [{ number: "1", x: -20, y: 0 }] },
    { id: "P1", type: "netport", x: 20, y: 20, pins: [{ number: "1", x: 20, y: 20 }] },
  ],
  wires: [],
});
assert.deepEqual(annotated.components[0].pinLayout, { kind: "single-sided", occupiedSides: ["left"] });
assert.equal(annotated.components[0].pins[0].side, "left");
assert.equal(annotated.components[1].pinLayout, undefined);

const moduleBounds = estimateModuleBounds([
  { x: 100, y: 100, pins: [{ x: 80, y: 90 }, { x: 120, y: 110 }] },
  { x: 200, y: 160, pins: [{ x: 180, y: 160 }, { x: 220, y: 160 }] },
], { padding: 15 });

assert.deepEqual(moduleBounds.contentBounds, {
  left: 80, top: 90, right: 220, bottom: 160,
  width: 140, height: 70, centerX: 150, centerY: 125,
});
assert.deepEqual(moduleBounds.keepOutBounds, {
  left: 65, top: 75, right: 235, bottom: 175,
  width: 170, height: 100, centerX: 150, centerY: 125,
});
assert.equal(moduleBounds.componentCount, 2);
assert.equal(moduleBounds.pinCount, 4);
assert.equal(moduleBounds.approximate, true);
assert.equal(boundsOverlap(moduleBounds.keepOutBounds, { left: 230, top: 170, right: 260, bottom: 190 }), true);
assert.equal(boundsOverlap(moduleBounds.keepOutBounds, { left: 240, top: 180, right: 260, bottom: 190 }), false);
assert.equal(estimateModuleBounds([]), null);
assert.throws(() => estimateModuleBounds([], { padding: -1 }), TypeError);

console.log("Pin layout inference tests passed");
