#!/usr/bin/env python3
"""Render a snapshot + changes.json (+ optional report.json) as an SVG floor
plan: board outline, every component as a labeled rectangle at its FINAL
position (changes.json position if it moved, original position otherwise),
color-coded by region so you can see what this run actually did before
deciding what to change.
"""

from __future__ import annotations

import argparse

import geometry as geo
import model as m

VIEWBOX_WIDTH = 680.0
MARGIN = 40.0

# Cycled across regions so adjacent anchors are visually distinguishable --
# a floor plan needs more categorical separation than a typical flowchart,
# where the 2-3 color guidance assumes far fewer simultaneous categories.
REGION_RAMPS = ["c-blue", "c-teal", "c-purple", "c-coral", "c-pink", "c-amber", "c-green"]
LOCKED_RAMP = "c-gray"
UNASSIGNED_RAMP = "c-gray"
PROBLEM_RAMP = "c-red"


def build_final_state(snapshot: dict, changes: list[dict]) -> dict[str, dict]:
    """componentId -> {x, y, rotation, bbox} at its FINAL position, recomputing
    the bbox with the same rotate-corners-around-original-position approach
    place.py itself uses (changes.json only carries x/y/rotation, not bbox)."""
    final: dict[str, dict] = {}
    changes_by_id = {c["componentId"]: c for c in changes}
    for component in snapshot.get("components", []):
        cid = component["id"]
        bbox = component.get("bbox") or geo.bbox_from_points([(component["x"], component["y"])])
        original_pos = (component["x"], component["y"])
        original_rotation = float(component.get("rotation", 0))
        change = changes_by_id.get(cid)
        if change is None:
            final[cid] = {"x": original_pos[0], "y": original_pos[1], "rotation": original_rotation, "bbox": bbox}
            continue
        theta = change["rotation"] - original_rotation
        rotated = geo.rotated_bbox(bbox, original_pos, theta)
        shift = (change["x"] - original_pos[0], change["y"] - original_pos[1])
        new_bbox = {
            "minX": rotated["minX"] + shift[0], "maxX": rotated["maxX"] + shift[0],
            "minY": rotated["minY"] + shift[1], "maxY": rotated["maxY"] + shift[1],
        }
        final[cid] = {"x": change["x"], "y": change["y"], "rotation": change["rotation"], "bbox": new_bbox}
    return final


def esc(text: str) -> str:
    return (text or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


LEGEND_HEIGHT = 34.0


def render(snapshot: dict, regions_json: dict, changes: list[dict], report: dict | None) -> str:
    final_state = build_final_state(snapshot, changes)
    board_bounds = regions_json["board"]["bounds"]
    board_w = board_bounds["maxX"] - board_bounds["minX"]
    board_h = board_bounds["maxY"] - board_bounds["minY"]
    scale = (VIEWBOX_WIDTH - 2 * MARGIN) / board_w if board_w else 1.0
    height = board_h * scale + 2 * MARGIN + LEGEND_HEIGHT

    def sx(x: float) -> float:
        return MARGIN + (x - board_bounds["minX"]) * scale

    def sy(y: float) -> float:
        return MARGIN + (y - board_bounds["minY"]) * scale

    ramp_by_designator: dict[str, str] = {}
    for index, region in enumerate(regions_json["regions"]):
        ramp_by_designator[region["anchorDesignator"]] = REGION_RAMPS[index % len(REGION_RAMPS)]
    member_ramp: dict[str, str] = {}
    for region in regions_json["regions"]:
        ramp = ramp_by_designator[region["anchorDesignator"]]
        for member_id in region["memberComponentIds"]:
            member_ramp[member_id] = ramp
    unassigned_ids = set(regions_json.get("unassigned", []))
    anchor_ids = {region["anchorComponentId"] for region in regions_json["regions"]}
    anchor_designator_by_id = {region["anchorComponentId"]: region["anchorDesignator"] for region in regions_json["regions"]}

    problem_ids: set[str] = set()
    if report:
        for pair in report.get("overlaps", []):
            problem_ids.update(pair)
        problem_ids.update(report.get("outsideBoard", []))
        problem_ids.update(f["componentId"] for f in report.get("forcedPlacements", []) if f.get("componentId"))

    parts: list[str] = []
    parts.append(
        f'<svg width="100%" viewBox="0 0 {VIEWBOX_WIDTH:.0f} {height:.0f}" role="img">'
        f'<title>PCB floor plan</title>'
        f'<desc>Board outline with every component at its proposed position, color-coded by region.</desc>'
    )

    # Board outline (outer ring, holes cut out via evenodd fill rule).
    outer = regions_json["board"]["polygon"]["outer"]
    holes = regions_json["board"]["polygon"]["holes"]
    if outer:
        path = "M " + " L ".join(f"{sx(p[0]):.1f} {sy(p[1]):.1f}" for p in outer) + " Z"
        for hole in holes:
            path += " M " + " L ".join(f"{sx(p[0]):.1f} {sy(p[1]):.1f}" for p in hole) + " Z"
        parts.append(f'<path d="{path}" fill-rule="evenodd" class="c-gray" fill-opacity="0.15" stroke-width="1.5"/>')

    # Keepout discs (anchor-clearance keepouts only -- polygon-sourced EDA
    # keepouts aren't decoded, see plan limitations).
    for keepout in regions_json.get("keepouts", []):
        if keepout.get("source") == "anchor-clearance":
            cx, cy = keepout["center"]
            r = keepout["radiusMil"] * scale
            parts.append(f'<circle cx="{sx(cx):.1f}" cy="{sy(cy):.1f}" r="{r:.1f}" fill="none" stroke="#D85A30" '
                         f'stroke-width="1" stroke-dasharray="4 3" opacity="0.6"/>')

    def draw_component(cid: str, component: dict, ramp: str, label_extra: str = "") -> None:
        state = final_state.get(cid)
        if not state:
            return
        bbox = state["bbox"]
        x, y = sx(bbox["minX"]), sy(bbox["minY"])
        w = (bbox["maxX"] - bbox["minX"]) * scale
        h = (bbox["maxY"] - bbox["minY"]) * scale
        designator = esc(component.get("designator", ""))
        is_problem = cid in problem_ids
        stroke = "#E24B4A" if is_problem else None
        stroke_attr = f' stroke="{stroke}" stroke-width="2"' if stroke else ""
        parts.append(f'<g class="{ramp}"><rect x="{x:.1f}" y="{y:.1f}" width="{max(w,1):.1f}" height="{max(h,1):.1f}" '
                     f'rx="1"{stroke_attr}/></g>')
        if w >= 14 and h >= 8:
            font_size = min(9, max(5, h * 0.5))
            parts.append(f'<text x="{x + w/2:.1f}" y="{y + h/2 + font_size*0.35:.1f}" class="t" '
                         f'font-size="{font_size:.1f}" text-anchor="middle">{designator}{label_extra}</text>')

    components_by_id = {c["id"]: c for c in snapshot.get("components", [])}
    for cid, component in components_by_id.items():
        if cid in unassigned_ids:
            draw_component(cid, component, UNASSIGNED_RAMP)
    for cid, component in components_by_id.items():
        if cid in anchor_ids or cid in unassigned_ids:
            continue
        if m.is_locked(component):
            draw_component(cid, component, LOCKED_RAMP)
            continue
        ramp = member_ramp.get(cid, "c-gray")
        draw_component(cid, component, ramp)
    for cid in anchor_ids:
        component = components_by_id.get(cid)
        if component:
            ramp = ramp_by_designator[anchor_designator_by_id[cid]]
            draw_component(cid, component, ramp, label_extra="*")

    legend_y = board_h * scale + MARGIN + 16
    legend_items = [("c-blue", "Anchor / region (*)"), ("c-gray", "Locked / unassigned"), (None, "Overlap, out of board, or forced")]
    lx = MARGIN
    for ramp, label in legend_items:
        if ramp:
            parts.append(f'<g class="{ramp}"><rect x="{lx:.1f}" y="{legend_y:.1f}" width="10" height="10" rx="1"/></g>')
        else:
            parts.append(f'<rect x="{lx:.1f}" y="{legend_y:.1f}" width="10" height="10" rx="1" fill="none" '
                         f'stroke="#E24B4A" stroke-width="2"/>')
        parts.append(f'<text x="{lx+14:.1f}" y="{legend_y+8:.1f}" class="ts" font-size="9">{label}</text>')
        lx += 14 + len(label) * 5.2 + 18

    parts.append("</svg>")
    return "".join(parts)


def main() -> None:
    m.ensure_utf8_stdout()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", required=True)
    parser.add_argument("--regions", required=True)
    parser.add_argument("--changes", required=True)
    parser.add_argument("--report", default=None)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    snapshot = m.load_snapshot(args.snapshot)
    regions_json = m.load_json(args.regions)
    changes = m.load_json(args.changes)
    report = m.load_json(args.report) if args.report else None

    svg = render(snapshot, regions_json, changes, report)
    with open(args.out, "w", encoding="utf-8") as handle:
        handle.write(svg)
    print(f"Wrote {args.out}")


if __name__ == "__main__":
    main()
