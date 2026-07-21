import assert from "node:assert/strict";
import { BOARD_OUTLINE_LAYER, compileBoardOutline } from "../src/board-outline.ts";

assert.equal(BOARD_OUTLINE_LAYER, 11);
const rectangle = compileBoardOutline({ type: "rectangle", x: 10, y: 20, width: 100, height: 50, cornerRadius: 0, lineWidth: 1, locked: false });
assert.equal(rectangle.length, 4);
assert.ok(rectangle.every((item) => item.type === "line"));

const rounded = compileBoardOutline({ type: "rectangle", x: 0, y: 0, width: 100, height: 50, cornerRadius: 5, lineWidth: 1, locked: false });
assert.equal(rounded.filter((item) => item.type === "line").length, 4);
assert.equal(rounded.filter((item) => item.type === "arc").length, 4);
assert.ok(rounded.filter((item) => item.type === "arc").every((item) => Math.abs(item.angle) === 90));

const repair = compileBoardOutline({ type: "polygon", points: [{ x: 0, y: 0 }, { x: 25, y: 0 }, { x: 25, y: 10 }], closed: false, cornerRadius: 0, lineWidth: 1, locked: false });
assert.equal(repair.length, 2);
assert.throws(() => compileBoardOutline({ type: "polygon", points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], closed: false, cornerRadius: 1, lineWidth: 1, locked: false }), /cannot use cornerRadius/);
assert.throws(() => compileBoardOutline({ type: "rectangle", x: 0, y: 0, width: 10, height: 5, cornerRadius: 3, lineWidth: 1, locked: false }), /cannot exceed/);

console.log("board outline geometry: ok");
