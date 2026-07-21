import assert from "node:assert/strict";
import { ProjectCache } from "../src/project-cache.mjs";

const calls = [];
const bridge = {
  async call(method, params = {}) {
    calls.push({ method, params });
    if (method === "system.health") return { project: { uuid: "project-1" }, schematic: { uuid: "schematic-1" } };
    if (method === "schematic.listPages") return { pages: [{ uuid: "page-1" }, { uuid: "page-2" }] };
    if (method === "schematic.inspectPage") return {
      page: { uuid: params.pageUuid, name: params.pageUuid }, components: [{
        id: `part-${params.pageUuid}`, type: "part", designator: params.pageUuid === "page-1" ? "R1" : "R2",
        name: "resistor", deviceUuid: "device-r", libraryUuid: "library-r",
        attributes: [
          { key: "Value", value: params.pageUuid === "page-1" ? "1nF" : "1000pF" },
          { key: "Tolerance", value: "±5%" }, { key: "Supplier Footprint", value: "0402" },
          { key: "Voltage Rated", value: params.pageUuid === "page-1" ? "25V" : "50V" },
          { key: "Manufacturer Part", value: params.pageUuid === "page-1" ? "CAP-A" : "CAP-B" },
        ],
      }], wires: [{ id: `wire-${params.pageUuid}`, net: params.pageUuid === "page-1" ? "GND" : "VCC" }],
    };
    throw new Error(`Unexpected call: ${method}`);
  },
};

const cache = new ProjectCache(bridge, { ttlMs: 60_000 });
await cache.initialize();
assert.equal(cache.status().pageCount, 2);
assert.equal(cache.status().componentCount, 2);
assert.equal(cache.status().netCount, 2);
assert.deepEqual((await cache.getNets()).sort(), ["GND", "VCC"]);
assert.equal(cache.status().failedPageCount, 0);
const inspectCount = calls.filter((call) => call.method === "schematic.inspectPage").length;
assert.equal(inspectCount, 2, "initialization should inspect every page once");

await cache.getPage("page-1");
assert.equal(calls.filter((call) => call.method === "schematic.inspectPage").length, inspectCount, "warm read should hit cache");

const withoutWires = await cache.getPage("page-1", { includeWires: false });
assert.deepEqual(withoutWires.wires, []);
assert.equal((await cache.getPage("page-1")).wires.length, 1, "wire filtering must not mutate cache");

await cache.refreshPages(["page-1"]);
assert.equal(calls.filter((call) => call.method === "schematic.inspectPage").length, inspectCount + 1);

const inventory = await cache.getComponentInventory({ groupBy: "equivalentSpec", includeSingletons: false });
assert.equal(inventory.componentCount, 2);
assert.equal(inventory.duplicateGroupCount, 1);
assert.equal(inventory.groups[0].components.length, 2);
assert.deepEqual(inventory.groups[0].variants.voltageRatings, ["25V", "50V"]);

cache.clear();
assert.equal(cache.status().initialized, false);

const flakyBridge = {
  async call(method, params = {}) {
    if (method === "system.health") return { project: { uuid: "p" }, schematic: { uuid: "s" } };
    if (method === "schematic.listPages") return { pages: [{ uuid: "good" }, { uuid: "bad" }] };
    if (method === "schematic.inspectPage" && params.pageUuid === "bad") throw new Error("pin read failed");
    if (method === "schematic.inspectPage") return { page: { uuid: "good" }, components: [], wires: [] };
    throw new Error(`Unexpected call: ${method}`);
  },
};
const partial = new ProjectCache(flakyBridge, { ttlMs: 60_000 });
await partial.initialize();
assert.equal(partial.status().pageCount, 1);
assert.equal(partial.status().failedPageCount, 1);
assert.equal((await partial.getPage("good")).page.uuid, "good");

const scopedBridge = {
  async call(method, params = {}) {
    if (method === "system.health") return { project: { uuid: "p" }, schematic: { uuid: "active" } };
    if (method === "schematic.listPages") return { schematics: [
      { uuid: "active", name: "design [backup]", pages: [{ uuid: "active-page" }] },
      { uuid: "backup", name: "production [main]", pages: [{ uuid: "backup-page" }] },
    ], pages: [
      { uuid: "active-page", schematicUuid: "active" },
      { uuid: "backup-page", schematicUuid: "backup" },
    ] };
    if (method === "schematic.inspectPage") return { page: { uuid: params.pageUuid }, components: [], wires: [] };
    throw new Error(`Unexpected call: ${method}`);
  },
};
const scoped = new ProjectCache(scopedBridge, { ttlMs: 60_000 });
await scoped.initialize();
assert.equal(scoped.status().pageCount, 1, "only the active schematic should be cached");
assert.equal(scoped.status().scope.schematicUuid, "backup", "the [main] tag should override the active schematic");
assert.ok(await scoped.getPage("backup-page"));

const noFocusCalls = [];
const noFocusBridge = {
  async call(method, params = {}) {
    if (method === "system.health") return { project: { uuid: "p" }, schematic: null, page: null };
    if (method === "schematic.listPages") return { schematics: [
      { uuid: "main", name: "production [main]", pages: [{ uuid: "main-page" }] },
      { uuid: "backup-1", name: "production [backup]", pages: [{ uuid: "backup-page-1" }] },
      { uuid: "backup-2", name: "production [backup]", pages: [{ uuid: "backup-page-2" }] },
    ], pages: [
      { uuid: "main-page", schematicUuid: "main" },
      { uuid: "backup-page-1", schematicUuid: "backup-1" },
      { uuid: "backup-page-2", schematicUuid: "backup-2" },
    ] };
    if (method === "schematic.inspectPage") {
      noFocusCalls.push(params.pageUuid);
      return { page: { uuid: params.pageUuid }, components: [], wires: [] };
    }
    throw new Error(`Unexpected call: ${method}`);
  },
};
const noFocus = new ProjectCache(noFocusBridge, { ttlMs: 60_000 });
await noFocus.initialize();
assert.deepEqual(noFocusCalls, ["main-page"], "startup without a focused schematic must still cache only [main]");
assert.equal(noFocus.status().pageCount, 1);
assert.equal(noFocus.status().scope.schematicUuid, "main");
console.log("Project cache tests passed");
