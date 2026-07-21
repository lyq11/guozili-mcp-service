import assert from "node:assert/strict";
import { PcbCache } from "../src/pcb-cache.mjs";

const calls = [];
const catalog = { boards: [
  { schematic: { uuid: "sch-main", name: "DTU [main]" }, pcb: { uuid: "pcb-backup", name: "DTU [backup]" } },
  { schematic: { uuid: "sch-main", name: "DTU [main]" }, pcb: { uuid: "pcb-main", name: "DTU PCB" } },
  { schematic: { uuid: "sch-old", name: "DTU [backup]" }, pcb: { uuid: "pcb-old", name: "Old" } },
] };
const snapshot = { components: [{ pads: [{}, {}] }], standalonePads: [{}], nets: ["GND"], tracks: [], trackArcs: [], vias: [], pours: [] };
const bridge = { call: async (method, params) => {
  calls.push([method, params]);
  if (method === "pcb.listBoards") return catalog;
  if (method === "pcb.inspect") return snapshot;
  throw new Error(`Unexpected ${method}`);
} };
const projectCache = { status: () => ({ scope: { schematicUuid: "sch-main" } }) };
const cache = new PcbCache(bridge, projectCache, { ttlMs: 100_000 });
await cache.initialize();
assert.equal(cache.status().pcbUuid, "pcb-main");
assert.equal(cache.status().padCount, 3);
assert.deepEqual(await cache.getSnapshot(), snapshot);
assert.equal(calls.filter(([method]) => method === "pcb.inspect").length, 1);
console.log("pcb-cache: ok");
