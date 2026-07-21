import assert from "node:assert/strict";
import { standalonePadIds } from "../src/pad-classification.ts";

const result = standalonePadIds(
  ["component-a", "component-b", "standalone-a", "standalone-b"],
  [["component-a"], ["component-b"]],
);

assert.deepEqual([...result], ["standalone-a", "standalone-b"]);
console.log("pad classification: ok");
