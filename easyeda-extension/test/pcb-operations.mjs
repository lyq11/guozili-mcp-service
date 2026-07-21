import assert from "node:assert/strict";

// create_pour's validate() is the one operation that still touches eda.* directly
// (it calls eda.pcb_MathPolygon.createPolygon to prove the polygon source decodes).
// Every other operation's validate() only reads the fake ctx below, which is the
// testability win this registry unlocks: no live EasyEDA connection required.
globalThis.eda = {
  pcb_MathPolygon: { createPolygon: (polygon) => (Array.isArray(polygon) && polygon.length >= 4 ? {} : null) },
};

const { PCB_OPERATIONS } = await import("../src/pcb-operations.ts");

const ctx = {
  board: { schematic: { uuid: "sch-main" } },
  componentIds: new Set(["c1"]),
  netNames: new Set(["GND", "VCC"]),
  layerIds: new Set([1, 2, 11, 21]),
  copperLayerIds: new Set([1, 2, 21]),
  copperLineIds: new Set(["line1"]),
  copperTrackIds: new Set(["line1", "arc1"]),
  viaById: new Map([["via1", { getState_HoleDiameter: () => 10, getState_Diameter: () => 20 }]]),
  pourIds: new Set(["pour1"]),
};

function findingsFor(type, operation) {
  const findings = [];
  PCB_OPERATIONS[type].validate(operation, 0, ctx, findings);
  return findings;
}

function assertValid(type, operation) {
  assert.deepEqual(findingsFor(type, operation), [], `${type} unexpectedly rejected a valid operation`);
}

function assertInvalid(type, operation, expectedSubstring) {
  const findings = findingsFor(type, operation);
  assert.ok(findings.length > 0, `${type} unexpectedly accepted an invalid operation`);
  assert.ok(
    findings.some((finding) => String(finding.message).includes(expectedSubstring)),
    `${type} findings ${JSON.stringify(findings)} did not mention "${expectedSubstring}"`,
  );
}

// transform_components
assertValid("transform_components", { changes: [{ componentId: "c1", x: 10 }] });
assertInvalid("transform_components", { changes: [{ componentId: "missing" }] }, "PCB component not found");

// create_board_outline
assertValid("create_board_outline", { outline: { type: "rectangle", x: 0, y: 0, width: 100, height: 50, cornerRadius: 0, lineWidth: 1, locked: false } });
assertInvalid("create_board_outline", { outline: { type: "rectangle", x: 0, y: 0, width: -5, height: 50, cornerRadius: 0, lineWidth: 1 } }, "positive");

// create_track
assertValid("create_track", { net: "GND", layer: 21, startX: 0, startY: 0, endX: 10, endY: 0, width: 1 });
assertInvalid("create_track", { net: "UNKNOWN", layer: 21, startX: 0, startY: 0, endX: 10, endY: 0, width: 1 }, "PCB net not found");

// create_via
assertValid("create_via", { net: "GND", x: 0, y: 0, holeDiameter: 10, diameter: 20 });
assertInvalid("create_via", { net: "GND", x: 0, y: 0, holeDiameter: 20, diameter: 10 }, "greater than its positive hole diameter");

// modify_tracks
assertValid("modify_tracks", { changes: [{ trackId: "line1", width: 5 }] });
assertInvalid("modify_tracks", { changes: [{ trackId: "missing", width: 5 }] }, "Copper track, arc, or polyline not found");

// modify_vias
assertValid("modify_vias", { changes: [{ viaId: "via1", diameter: 25 }] });
assertInvalid("modify_vias", { changes: [{ viaId: "via1", diameter: 5 }] }, "greater than its positive hole diameter");

// set_stackup
assertValid("set_stackup", { copperLayerCount: 4 });
assertInvalid("set_stackup", { copperLayerCount: 3 }, "even number from 2 through 32");
assertInvalid("set_stackup", {}, "contains no changes");

// create_pad
const validPad = {
  net: "GND", layer: 1, padNumber: "1", x: 0, y: 0, rotation: 0,
  holeOffsetX: 0, holeOffsetY: 0, holeRotation: 0,
  shape: { type: "RECT", width: 10, height: 10, roundRadius: 0 }, hole: { type: "NONE" },
  padType: 0, metallized: false, locked: false,
};
assertValid("create_pad", validPad);
assertInvalid("create_pad", { ...validPad, layer: 12 }, "Multi-layer pads require a hole");

// create_pour (exercises the eda.pcb_MathPolygon stub above)
assertValid("create_pour", { net: "GND", layer: 21, polygon: [0, 0, 10, 0, 10, 10, 0, 10], width: 1 });
assertInvalid("create_pour", { net: "GND", layer: 21, polygon: "bad", width: 1 }, "Invalid EasyEDA polygon source");

// delete_tracks
assertValid("delete_tracks", { trackIds: ["line1"] });
assertInvalid("delete_tracks", { trackIds: ["missing"] }, "Straight copper track not found");

// rebuild_pours
assertValid("rebuild_pours", { pourIds: ["pour1"] });
assertInvalid("rebuild_pours", { pourIds: ["missing"] }, "Pour not found");
assertValid("rebuild_pours", {}); // pourIds omitted rebuilds every pour; preserves original (quirky) skip-when-not-an-array behavior

// import_schematic_changes
assertValid("import_schematic_changes", {});
assertValid("import_schematic_changes", { schematicUuid: "sch-main" });
assertInvalid("import_schematic_changes", { schematicUuid: "sch-other" }, "Only the associated [main] schematic");

console.log("pcb-operations validate(): ok");
