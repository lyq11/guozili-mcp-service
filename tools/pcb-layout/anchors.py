#!/usr/bin/env python3
"""Stage 0: propose PCB layout anchor candidates from a pcb_inspect snapshot.

Anchors are NOT auto-decided by this script — it only proposes candidates by
designator-prefix convention (U -> ic, J -> connector, Y/X -> crystal, ANT ->
antenna, T -> transformer, large L footprints flagged for review). The AI or
a human must review anchors.template.json, correct roles, delete false
positives, and add anything the prefix table missed (e.g. an inductor or a
SIM socket with a non-obvious designator) before saving it as anchors.json.
"""

from __future__ import annotations

import argparse

import model as m

# Footprints larger than this (by bbox area, mil^2) with an "L" designator
# are flagged as candidate power inductors for review, not auto-accepted --
# small L footprints are usually signal-level and not layout anchors.
LARGE_L_AREA_THRESHOLD_MIL2 = 400.0 * 400.0


def bbox_area(component: dict) -> float:
    bbox = component.get("bbox")
    if not bbox:
        return 0.0
    return abs(bbox["maxX"] - bbox["minX"]) * abs(bbox["maxY"] - bbox["minY"])


def propose_candidates(snapshot: dict) -> dict[str, dict]:
    candidates: dict[str, dict] = {}
    for component in snapshot.get("components", []):
        designator = component.get("designator")
        if not designator:
            continue
        if component.get("locked") is True:
            # Already-locked components are structural obstacles, not
            # region anchors that later stages would try to reposition.
            continue
        prefix = m.designator_prefix(designator)
        role = m.DEFAULT_ANCHOR_PREFIXES.get(prefix)
        if role:
            candidates[designator] = {"anchor": True, "role": role, "confidence": "prefix-match"}
        elif prefix == "L" and bbox_area(component) >= LARGE_L_AREA_THRESHOLD_MIL2:
            candidates[designator] = {"anchor": True, "role": "power", "confidence": "large-footprint-review"}
    return candidates


def main() -> None:
    m.ensure_utf8_stdout()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", required=True, help="pcb_inspect snapshot JSON")
    parser.add_argument("--out", required=True, help="output anchors.template.json path")
    args = parser.parse_args()

    snapshot = m.load_snapshot(args.snapshot)
    candidates = propose_candidates(snapshot)
    m.save_json(args.out, candidates)
    print(f"Wrote {len(candidates)} anchor candidates to {args.out}")
    print("Review this file before use: confirm roles, delete false positives, add anything missed.")


if __name__ == "__main__":
    main()
