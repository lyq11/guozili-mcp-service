#!/usr/bin/env python3
"""Stage A: assign every non-anchor component to the U-anchor it belongs to,
extract the board polygon and keepouts, and emit a region-params template for
the AI to fill in with real semantic layout hints.
"""

from __future__ import annotations

import argparse

import geometry as geo
import model as m

# EPCB_PrimitiveRegionRuleType.NO_COMPONENTS, from @jlceda/pro-api-types --
# regions tagged with this rule type are placement keepouts.
NO_COMPONENTS_RULE_TYPE = 2

# Rough default clearance disc (mil) around antenna/connector anchors, for
# projects that don't already model RF/mechanical clearance as a PCB region.
# This is a placeholder meant to be tuned per project, not an engineering
# constant -- pass --anchor-clearance-mil to override.
DEFAULT_ANCHOR_CLEARANCE_MIL = 100.0


def net_score(component_pads: list[m.Pad], anchor_pads: list[m.Pad], net_usage: dict[str, int]) -> float:
    """Inverse-frequency net score: a net shared with only the anchor and
    this component (usage_count=2) contributes 0.5; a net used by 40
    components contributes 0.025. GND is excluded entirely so the most
    common rail on the board doesn't make every component look related to
    every anchor."""
    component_nets = {pad.net for pad in component_pads if pad.net and not m.is_ground_net(pad.net)}
    anchor_nets = {pad.net for pad in anchor_pads if pad.net and not m.is_ground_net(pad.net)}
    shared = component_nets & anchor_nets
    return sum(1.0 / net_usage.get(net, 1) for net in shared)


def build_regions(
    snapshot: dict,
    schematic_components: list[dict],
    anchors: dict[str, dict],
    anchor_clearance_mil: float = DEFAULT_ANCHOR_CLEARANCE_MIL,
) -> tuple[dict, dict]:
    components_by_designator = m.component_by_designator(snapshot)
    components_by_id = m.component_by_id(snapshot)
    pads = m.all_pads(snapshot)
    pads_by_component: dict[str, list[m.Pad]] = {}
    for pad in pads:
        if pad.component_id:
            pads_by_component.setdefault(pad.component_id, []).append(pad)
    net_usage = m.net_usage_table(pads)

    schematic_page_by_designator = {
        c.get("designator"): c.get("pageUuid") for c in schematic_components if c.get("designator")
    }

    anchor_ids: dict[str, str] = {}  # designator -> componentId
    anchor_pages: dict[str, str] = {}
    for designator, info in anchors.items():
        component = components_by_designator.get(designator)
        if not component:
            continue  # anchors.json referenced a designator not present in this snapshot
        anchor_ids[designator] = component["id"]
        page = schematic_page_by_designator.get(designator)
        if page:
            anchor_pages[designator] = page

    members: dict[str, list[str]] = {designator: [] for designator in anchor_ids}
    unassigned: list[str] = []

    anchor_designator_by_page: dict[str, list[str]] = {}
    for designator, page in anchor_pages.items():
        anchor_designator_by_page.setdefault(page, []).append(designator)

    for component in snapshot.get("components", []):
        designator = component.get("designator")
        if not designator or designator in anchor_ids:
            continue
        component_id = component["id"]
        component_pads = pads_by_component.get(component_id, [])

        page = schematic_page_by_designator.get(designator)
        page_anchors = anchor_designator_by_page.get(page, []) if page else []

        chosen: str | None = None
        if len(page_anchors) == 1:
            chosen = page_anchors[0]  # unambiguous page match
        else:
            candidates = page_anchors if page_anchors else list(anchor_ids.keys())
            best_designator, best_score = None, 0.0
            for anchor_designator in candidates:
                anchor_pads = pads_by_component.get(anchor_ids[anchor_designator], [])
                score = net_score(component_pads, anchor_pads, net_usage)
                if score > best_score:
                    best_designator, best_score = anchor_designator, score
            if best_designator is not None:
                chosen = best_designator

        if chosen:
            members[chosen].append(component_id)
        else:
            unassigned.append(component_id)

    board_polygon = m.board_polygon_from_snapshot(snapshot)
    keepouts = []
    for region in snapshot.get("regions", []):
        rule_types = region.get("ruleType") or []
        if NO_COMPONENTS_RULE_TYPE in rule_types:
            keepouts.append({"source": "region", "id": region.get("id"), "polygon": region.get("polygon")})

    for designator, info in anchors.items():
        if info.get("role") in ("antenna", "connector") and designator in anchor_ids:
            component = components_by_id[anchor_ids[designator]]
            keepouts.append({
                "source": "anchor-clearance", "anchorDesignator": designator,
                "center": [component["x"], component["y"]], "radiusMil": anchor_clearance_mil,
            })

    regions_out = []
    for designator in anchor_ids:
        component = components_by_id[anchor_ids[designator]]
        anchor_pads = pads_by_component.get(anchor_ids[designator], [])
        regions_out.append({
            "anchorDesignator": designator,
            "role": anchors[designator].get("role"),
            "anchorComponentId": anchor_ids[designator],
            "locked": m.is_locked(component),
            "anchorPins": [
                {"number": pad.number, "x": pad.x, "y": pad.y, "net": pad.net} for pad in anchor_pads
            ],
            "memberComponentIds": members[designator],
        })

    regions_json = {
        "board": {"polygon": {"outer": board_polygon.outer, "holes": board_polygon.holes}, "bounds": board_polygon.bounds()},
        "keepouts": keepouts,
        "regions": regions_out,
        "unassigned": unassigned,
    }

    region_params_template = {
        designator: {"type": None, "farFrom": [], "edgeConstraint": None} for designator in anchor_ids
    }

    return regions_json, region_params_template


def main() -> None:
    m.ensure_utf8_stdout()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", required=True)
    parser.add_argument("--schematic-components", required=True)
    parser.add_argument("--anchors", required=True)
    parser.add_argument("--out", required=True, help="regions.json output path")
    parser.add_argument("--region-params-template-out", default=None,
                         help="defaults to region-params.template.json next to --out")
    parser.add_argument("--anchor-clearance-mil", type=float, default=DEFAULT_ANCHOR_CLEARANCE_MIL)
    args = parser.parse_args()

    snapshot = m.load_snapshot(args.snapshot)
    schematic_components = m.load_schematic_components(args.schematic_components)
    anchors = m.load_anchors(args.anchors)

    regions_json, region_params_template = build_regions(
        snapshot, schematic_components, anchors, args.anchor_clearance_mil,
    )

    m.save_json(args.out, regions_json)
    template_out = args.region_params_template_out
    if template_out is None:
        from pathlib import Path
        template_out = str(Path(args.out).with_name("region-params.template.json"))
    m.save_json(template_out, region_params_template)

    print(f"{len(regions_json['regions'])} regions, {len(regions_json['unassigned'])} unassigned components")
    if not regions_json["board"]["polygon"]["outer"]:
        print("WARNING: board outline did not close into a polygon -- containment checks will reject everything")
    print(f"Wrote {args.out} and {template_out}")


if __name__ == "__main__":
    main()
