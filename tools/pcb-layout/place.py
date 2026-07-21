#!/usr/bin/env python3
"""Stage C: rule-based intra-region placement + macro packing, driven by
region-params.json. Emits changes.json (proposed new positions) and
report.json (validation results) -- report.json must be inspected (or run
through apply_gate.py) before changes.json is ever treated as apply-ready.
"""

from __future__ import annotations

import argparse
import math
import sys
from dataclasses import dataclass, field

import geometry as geo
import model as m

DEFAULT_CLEARANCE_MIL = 10.0
DEFAULT_WIRELENGTH_NET_USAGE_THRESHOLD = 15
WIRELENGTH_REGRESSION_BUDGET = 1.05
# Used for any component with a structural pin target that no rule matched
# -- a rule only narrows this (e.g. a tighter maxDistanceMil for a specific
# decoupling cap value), it doesn't gate whether near-pin placement happens.
DEFAULT_NEAR_PIN_MAX_DISTANCE_MIL = 200.0

# Set from --debug in main(). When True: (1) placement decisions are traced
# to stderr, and (2) a component/region that exhausts its retry budget is
# force-placed at the best candidate found instead of being left untouched
# -- this trades correctness for always producing a complete changes.json,
# specifically so the result can be rendered and visually inspected even
# when the heuristic can't fully solve the board. Every forced placement is
# still recorded in report.json (`forcedPlacements`), and the gate does not
# treat --debug output as apply-ready any more leniently than a normal run.
DEBUG = False


def debug_log(*parts: object) -> None:
    if DEBUG:
        print("[debug]", *parts, file=sys.stderr)


@dataclass
class PlacedComponent:
    id: str
    designator: str
    x: float
    y: float
    rotation: float
    bbox: dict
    locked: bool
    moved: bool = False
    # A member that couldn't be intra-region placed within its retry budget
    # stays at its original position, exactly like a locked component --
    # crucially it must NOT be swept up in its region's later rigid-body
    # transform, or it would silently jump from wherever it originally was
    # to a new rotated/translated spot despite never having been placed.
    unplaceable: bool = False
    # True when --debug forced this component into a position that still
    # collides with something -- always cross-checked with the report's
    # final overlap pass, never silently hidden.
    forced: bool = False


@dataclass
class PlacementState:
    components: dict[str, PlacedComponent]
    obstacles: list[dict] = field(default_factory=list)  # bboxes, grows as things get placed
    disc_keepouts: list[tuple[tuple[float, float], float]] = field(default_factory=list)
    board: geo.BoardPolygon = field(default_factory=geo.BoardPolygon)
    clearance: float = DEFAULT_CLEARANCE_MIL

    def collides(self, bbox: dict, allowed_overhang_mil: float = 0.0) -> bool:
        for obstacle in self.obstacles:
            if geo.bboxes_collide(bbox, obstacle, self.clearance):
                return True
        for center, radius in self.disc_keepouts:
            if geo.bbox_circle_collide(bbox, center, radius):
                return True
        if not geo.bbox_fully_inside_board(bbox, self.board, allowed_overhang_mil):
            return True
        return False

    def commit(self, bbox: dict) -> None:
        self.obstacles.append(bbox)


def build_initial_state(snapshot: dict, regions_json: dict) -> PlacementState:
    components: dict[str, PlacedComponent] = {}
    obstacles: list[dict] = []
    for component in snapshot.get("components", []):
        bbox = component.get("bbox") or geo.bbox_from_points([(component["x"], component["y"])])
        locked = m.is_locked(component)
        components[component["id"]] = PlacedComponent(
            id=component["id"], designator=component.get("designator", ""),
            x=float(component["x"]), y=float(component["y"]), rotation=float(component.get("rotation", 0)),
            bbox=bbox, locked=locked,
        )
        if locked:
            obstacles.append(bbox)  # locked components are obstacles from the start, per the plan

    # Every anchor body is also an obstacle from the very first intra-region
    # placement, not just its own region's members avoiding it -- otherwise
    # a neighboring region's shelf-packing could land members on top of an
    # anchor that hasn't had its own region processed yet.
    anchor_ids = {region["anchorComponentId"] for region in regions_json.get("regions", [])}
    for anchor_id in anchor_ids:
        component = components.get(anchor_id)
        if component and not component.locked:
            obstacles.append(component.bbox)

    # Unassigned components (regions.py couldn't attribute them to any
    # anchor) are never moved by this tool, but they still physically occupy
    # their current spot -- other components being placed must avoid them.
    for component_id in regions_json.get("unassigned", []):
        component = components.get(component_id)
        if component and component_id not in anchor_ids:
            obstacles.append(component.bbox)

    board = geo.BoardPolygon(
        outer=[tuple(p) for p in regions_json["board"]["polygon"]["outer"]],
        holes=[[tuple(p) for p in hole] for hole in regions_json["board"]["polygon"]["holes"]],
    )
    disc_keepouts = [
        (tuple(k["center"]), k["radiusMil"])
        for k in regions_json.get("keepouts", []) if k.get("source") == "anchor-clearance"
    ]
    # Polygon-sourced keepouts (EDA NO_COMPONENTS regions) are extracted by
    # regions.py but NOT enforced here -- their `polygon` field is EasyEDA's
    # raw internal polygon-source format, which this offline script has no
    # decoder for (only board-outline lines/arcs are decoded). Flagged as a
    # known v1 gap, not silently ignored.
    return PlacementState(components=components, obstacles=obstacles, disc_keepouts=disc_keepouts, board=board)


# ---------------------------------------------------------------------------
# Decoupling / near-target-pin structural rule matching
# ---------------------------------------------------------------------------

def match_rule(component: dict, rules: list[dict]) -> dict | None:
    designator = component.get("designator", "")
    value = m.component_value(component)
    for rule in rules:
        match = rule.get("match", {})
        prefix = match.get("designatorPrefix")
        if prefix and not designator.upper().startswith(prefix.upper()):
            continue
        rule_value = match.get("value")
        if rule_value is not None and not m.values_match(value, rule_value):
            continue
        return rule
    return None


def find_target_pin(component_pads: list[m.Pad], anchor_pins: list[dict]) -> dict | None:
    """Structural targeting, not string/net guessing: a matched component
    decouples a SPECIFIC anchor pin only if it has exactly one pad on a
    ground-like net and another pad whose net matches one of the anchor's
    actual pin nets. Returns that anchor pin dict, or None if the component
    doesn't have this exact 2-net structure (so it falls back to shelf
    placement instead of being force-fit near an arbitrary pin)."""
    if len(component_pads) != 2:
        return None
    ground_pads = [p for p in component_pads if m.is_ground_net(p.net)]
    other_pads = [p for p in component_pads if not m.is_ground_net(p.net)]
    if len(ground_pads) != 1 or len(other_pads) != 1:
        return None
    target_net = other_pads[0].net
    candidates = [pin for pin in anchor_pins if pin["net"] == target_net]
    if not candidates:
        return None
    return candidates[0]


def infer_side(point: tuple[float, float], anchor_bbox: dict) -> str:
    """Which of the anchor's 4 sides `point` sits closest to, relative to
    the anchor's own center -- whichever axis has the larger offset wins
    (a pin sitting far to the anchor's left, even if only slightly above
    center, reads as "left" not "top")."""
    center_x = (anchor_bbox["minX"] + anchor_bbox["maxX"]) / 2
    center_y = (anchor_bbox["minY"] + anchor_bbox["maxY"]) / 2
    dx, dy = point[0] - center_x, point[1] - center_y
    if abs(dx) >= abs(dy):
        return "right" if dx >= 0 else "left"
    return "bottom" if dy >= 0 else "top"


def find_connected_side(component_pads: list[m.Pad], anchor_pins: list[dict], anchor_bbox: dict) -> str | None:
    """For components that don't qualify for find_target_pin's strict
    2-net decoupling structure (e.g. a component with 3+ pads, or one where
    neither pad is a clean ground/signal pair) but still share SOME net
    with the anchor: place it on whichever side of the anchor its connected
    pin(s) actually sit on, instead of an arbitrary round-robin slot. Only
    components with genuinely zero net overlap with this anchor (tied to
    the region purely by schematic-page grouping) fall through to
    round-robin, since there's no electrical side to prefer for those."""
    matching_pins = [pin for pin in anchor_pins for pad in component_pads if pad.net and pad.net == pin["net"]]
    if not matching_pins:
        return None
    avg_x = sum(pin["x"] for pin in matching_pins) / len(matching_pins)
    avg_y = sum(pin["y"] for pin in matching_pins) / len(matching_pins)
    return infer_side((avg_x, avg_y), anchor_bbox)


# ---------------------------------------------------------------------------
# Intra-region placement
# ---------------------------------------------------------------------------

def place_near_pin(state: PlacementState, component: PlacedComponent, anchor: PlacedComponent, pin: dict, max_distance_mil: float) -> bool:
    """Try placing `component` near `pin`, oriented so its target-net pad
    faces the pin (a loop-shortening heuristic, not a real inductance
    solver -- see plan limitations). Tries increasing radii and several
    angles per radius; returns False (component left unplaced) if nothing
    fits within max_distance_mil."""
    width = component.bbox["maxX"] - component.bbox["minX"]
    height = component.bbox["maxY"] - component.bbox["minY"]
    half_diag = math.hypot(width, height) / 2

    outward_angle = math.degrees(math.atan2(pin["y"] - anchor.y, pin["x"] - anchor.x))
    radii = [half_diag + state.clearance + step for step in range(0, int(max_distance_mil), 20)]
    angles = [outward_angle + delta for delta in (0, 20, -20, 40, -40, 60, -60, 90, -90)]

    first_candidate = None
    for radius in radii:
        for angle in angles:
            rad = math.radians(angle)
            cx = pin["x"] + radius * math.cos(rad)
            cy = pin["y"] + radius * math.sin(rad)
            candidate_bbox = {
                "minX": cx - width / 2, "maxX": cx + width / 2,
                "minY": cy - height / 2, "maxY": cy + height / 2,
            }
            if first_candidate is None:
                first_candidate = (cx, cy, angle, candidate_bbox)
            if state.collides(candidate_bbox):
                continue
            component.x, component.y = cx, cy
            component.rotation = angle % 360  # power-net pad faces the target pin
            component.bbox = candidate_bbox
            component.moved = True
            state.commit(candidate_bbox)
            debug_log(f"{component.designator}: placed near pin {pin.get('number')} at "
                      f"radius={radius:.0f} angle={angle:.0f}")
            return True
    if DEBUG and first_candidate is not None:
        cx, cy, angle, candidate_bbox = first_candidate
        component.x, component.y = cx, cy
        component.rotation = angle % 360
        component.bbox = candidate_bbox
        component.moved = True
        component.forced = True
        state.commit(candidate_bbox)
        debug_log(f"{component.designator}: FORCED near pin {pin.get('number')} "
                  f"(no collision-free slot found within {max_distance_mil}mil)")
        return True
    debug_log(f"{component.designator}: could not place near pin {pin.get('number')} "
              f"within {max_distance_mil}mil, falling back to shelf placement")
    return False


MAX_SHELF_ROW_WRAPS = 12
SIDE_ORDER = ["right", "bottom", "left", "top"]


def make_side_cursors(anchor_bbox: dict, clearance: float, wrap_width: float) -> dict[str, dict]:
    """One packing cursor per side of the anchor, so members actually
    surround it -- right/left sides fill in columns running top-to-bottom
    (stacking further right/left as a column fills), top/bottom sides fill
    in rows running left-to-right (stacking further up/down as a row fills).
    This replaces a single shelf that only ever grew to the anchor's right."""
    return {
        "right": {"axis": "y", "fill_sign": 1, "wrap_sign": 1,
                  "fill_pos": anchor_bbox["minY"], "wrap_base": anchor_bbox["maxX"] + clearance,
                  "wrap_pos": 0.0, "wrap_width": wrap_width},
        "left": {"axis": "y", "fill_sign": 1, "wrap_sign": -1,
                 "fill_pos": anchor_bbox["minY"], "wrap_base": anchor_bbox["minX"] - clearance,
                 "wrap_pos": 0.0, "wrap_width": wrap_width},
        "bottom": {"axis": "x", "fill_sign": 1, "wrap_sign": 1,
                   "fill_pos": anchor_bbox["minX"], "wrap_base": anchor_bbox["maxY"] + clearance,
                   "wrap_pos": 0.0, "wrap_width": wrap_width},
        "top": {"axis": "x", "fill_sign": 1, "wrap_sign": -1,
                "fill_pos": anchor_bbox["minX"], "wrap_base": anchor_bbox["minY"] - clearance,
                "wrap_pos": 0.0, "wrap_width": wrap_width},
    }


def place_around_anchor(state: PlacementState, component: PlacedComponent, cursor: dict, allow_force: bool = True) -> bool:
    """Pack `component` into one side of the anchor (see make_side_cursors),
    filling along the row/column and wrapping outward when a row/column
    fills up. `cursor` is a mutable dict SHARED across every member placed
    on this side (each call picks up where the previous one left off), so
    this function must leave it in a sane state even when it fails: capped
    wraps (not raw iteration count) prevent a bad run of collisions from
    walking the cursor an unbounded distance in a single call, and on
    give-up the cursor is rolled back to where this call started (rather
    than left wherever the failed search wandered to) so the NEXT sibling
    on this side isn't placed relative to a corrupted position.

    `allow_force=False` disables --debug's force-on-exhaustion fallback for
    this call specifically -- used when trying several sides in preference
    order (electrically-preferred side first, e.g. a side pinned against the
    board edge), so an earlier, less-preferred side doesn't eat the forced
    placement before a later side even gets a real, non-colliding try."""
    width = component.bbox["maxX"] - component.bbox["minX"]
    height = component.bbox["maxY"] - component.bbox["minY"]
    fill_size = height if cursor["axis"] == "y" else width
    cross_size = width if cursor["axis"] == "y" else height
    entry_fill_pos, entry_wrap_pos = cursor["fill_pos"], cursor["wrap_pos"]
    fill_pos, wrap_pos = entry_fill_pos, entry_wrap_pos
    first_candidate = None
    wraps = 0
    while wraps <= MAX_SHELF_ROW_WRAPS:
        cross_center = cursor["wrap_base"] + cursor["wrap_sign"] * (wrap_pos + cross_size / 2)
        fill_center = fill_pos + fill_size / 2
        cx, cy = (cross_center, fill_center) if cursor["axis"] == "y" else (fill_center, cross_center)
        candidate_bbox = {"minX": cx - width / 2, "maxX": cx + width / 2, "minY": cy - height / 2, "maxY": cy + height / 2}
        if first_candidate is None:
            first_candidate = (cx, cy, candidate_bbox)
        if not state.collides(candidate_bbox):
            component.x, component.y = cx, cy
            component.bbox = candidate_bbox
            component.moved = True
            state.commit(candidate_bbox)
            cursor["fill_pos"] = fill_pos + fill_size + state.clearance
            cursor["wrap_pos"] = wrap_pos
            debug_log(f"{component.designator}: placed at ({cx:.0f}, {cy:.0f})")
            return True
        fill_pos += fill_size + state.clearance
        if fill_pos - entry_fill_pos > cursor["wrap_width"]:
            fill_pos = entry_fill_pos
            wrap_pos += cross_size + state.clearance
            wraps += 1
    # Give up: roll the shared cursor back to where this call started so a
    # failed search doesn't drag every later sibling's placement along with
    # it, then advance past this component's own footprint as if it had
    # landed at first_candidate (whether or not we actually force-place it).
    cursor["fill_pos"] = entry_fill_pos + fill_size + state.clearance
    cursor["wrap_pos"] = entry_wrap_pos
    if DEBUG and allow_force and first_candidate is not None:
        cx, cy, candidate_bbox = first_candidate
        component.x, component.y = cx, cy
        component.bbox = candidate_bbox
        component.moved = True
        component.forced = True
        state.commit(candidate_bbox)
        debug_log(f"{component.designator}: FORCED placement at ({cx:.0f}, {cy:.0f}) (no free slot found)")
        return True
    debug_log(f"{component.designator}: placement exhausted {MAX_SHELF_ROW_WRAPS} wraps with no free slot")
    return False


# Intra-region placement for each region is done directly in main(), where a
# designator -> value lookup closure (matched_rule_for) is available: any
# component with a structural pin target goes through place_near_pin,
# everything else is round-robined across the anchor's 4 side cursors via
# place_around_anchor, and the resulting per-region bbox is handed to the
# macro placement stage below as one rigid unit.


# ---------------------------------------------------------------------------
# Macro placement
# ---------------------------------------------------------------------------

def apply_region_rigid_transform(state: PlacementState, region: dict, anchor_new_pos: tuple[float, float], theta_deg: float) -> None:
    anchor = state.components[region["anchorComponentId"]]
    pivot = (anchor.x, anchor.y)
    member_ids = [region["anchorComponentId"]] + region["memberComponentIds"]
    for component_id in member_ids:
        component = state.components[component_id]
        if component.locked or component.unplaceable:
            continue
        new_pos = geo.rotate_around((component.x, component.y), pivot, theta_deg)
        offset = (anchor_new_pos[0] - pivot[0], anchor_new_pos[1] - pivot[1])
        component.x, component.y = new_pos[0] + offset[0], new_pos[1] + offset[1]
        component.rotation = (component.rotation + theta_deg) % 360
        component.bbox = geo.rotated_bbox(component.bbox, pivot, theta_deg)
        component.bbox = {
            "minX": component.bbox["minX"] + offset[0], "maxX": component.bbox["maxX"] + offset[0],
            "minY": component.bbox["minY"] + offset[1], "maxY": component.bbox["maxY"] + offset[1],
        }
        component.moved = True


def macro_place_regions(state: PlacementState, regions: list[dict], region_params: dict, local_bboxes: dict[str, dict], report: dict) -> None:
    board_bounds = state.board.bounds()
    edge_regions = [r for r in regions if (region_params.get(r["anchorDesignator"]) or {}).get("edgeConstraint")]
    other_regions = [r for r in regions if r not in edge_regions]

    cursor = {"x": board_bounds["minX"], "y": board_bounds["minY"], "row_height": 0.0}

    def place_region_bbox(region: dict, target_x: float, target_y: float, theta_deg: float, allowed_overhang_mil: float, force: bool = False) -> bool:
        local_bbox = local_bboxes[region["anchorDesignator"]]
        anchor = state.components[region["anchorComponentId"]]
        if anchor.locked:
            return True  # locked anchor's region is never repositioned; already validated in place
        # target_x/target_y is the desired new anchor position; theta_deg is
        # the rotation DELTA to apply to the whole region (0 for non-edge
        # regions, requiredRotation - anchor.rotation for edge-constrained
        # ones -- computed by the caller).
        rotated_local = geo.rotated_bbox(local_bbox, (anchor.x, anchor.y), theta_deg)
        shift_x = target_x - anchor.x
        shift_y = target_y - anchor.y
        candidate_region_bbox = {
            "minX": rotated_local["minX"] + shift_x, "maxX": rotated_local["maxX"] + shift_x,
            "minY": rotated_local["minY"] + shift_y, "maxY": rotated_local["maxY"] + shift_y,
        }
        collides = state.collides(candidate_region_bbox, allowed_overhang_mil)
        if collides and not force:
            return False
        apply_region_rigid_transform(state, region, (target_x, target_y), theta_deg)
        if collides and force:
            anchor.forced = True
            for member_id in region["memberComponentIds"]:
                state.components[member_id].forced = True
            debug_log(f"{region['anchorDesignator']}: FORCED macro placement at "
                      f"({target_x:.0f}, {target_y:.0f}) (still collides with something)")
        state.commit(state.components[region["anchorComponentId"]].bbox)
        for member_id in region["memberComponentIds"]:
            member = state.components[member_id]
            if not member.locked:
                state.commit(member.bbox)
        return True

    for region in edge_regions:
        designator = region["anchorDesignator"]
        constraint = region_params[designator]["edgeConstraint"]
        allowed_edges = constraint.get("allowedEdges", ["left", "right", "top", "bottom"])
        preferred = constraint.get("preferredEdge")
        clearance_mil = constraint.get("edgeClearanceMil", 0.0)
        overhang_mil = constraint.get("allowedOverhangMil", 0.0)
        rotation = constraint.get("requiredRotation")
        local_bbox = local_bboxes[designator]
        width = local_bbox["maxX"] - local_bbox["minX"]
        height = local_bbox["maxY"] - local_bbox["minY"]
        anchor = state.components[region["anchorComponentId"]]
        theta = (rotation - anchor.rotation) if rotation is not None else 0.0

        edge_order = [preferred] + [e for e in allowed_edges if e != preferred] if preferred else allowed_edges
        edge_order = [e for e in edge_order if e] or ["right"]
        placed = False
        first_target = None
        for edge in edge_order:
            if edge == "left":
                target_x, target_y = board_bounds["minX"] + clearance_mil + width / 2, (board_bounds["minY"] + board_bounds["maxY"]) / 2
            elif edge == "right":
                target_x, target_y = board_bounds["maxX"] - clearance_mil - width / 2, (board_bounds["minY"] + board_bounds["maxY"]) / 2
            elif edge == "top":
                target_x, target_y = (board_bounds["minX"] + board_bounds["maxX"]) / 2, board_bounds["minY"] + clearance_mil + height / 2
            else:
                target_x, target_y = (board_bounds["minX"] + board_bounds["maxX"]) / 2, board_bounds["maxY"] - clearance_mil - height / 2
            if first_target is None:
                first_target = target_x, target_y
            if place_region_bbox(region, target_x, target_y, theta, overhang_mil):
                placed = True
                break
        if not placed and DEBUG and first_target is not None:
            placed = place_region_bbox(region, first_target[0], first_target[1], theta, overhang_mil, force=True)
        if not placed:
            report["unsatisfiedConstraints"].append({
                "type": "edge_constraint_failed", "anchorDesignator": designator, "constraint": constraint,
            })

    grouped = sorted(other_regions, key=lambda r: (region_params.get(r["anchorDesignator"]) or {}).get("type") or "")
    for region in grouped:
        designator = region["anchorDesignator"]
        local_bbox = local_bboxes[designator]
        width = local_bbox["maxX"] - local_bbox["minX"]
        height = local_bbox["maxY"] - local_bbox["minY"]
        placed = False
        # Scan forward from the shared cursor: on collision, advance (and
        # row-wrap as needed) and retry, rather than giving up at the first
        # spot -- a single failed attempt must not stall every region behind
        # it in the packing order.
        guard = 400
        first_target = None
        while guard > 0:
            guard -= 1
            if cursor["x"] + width > board_bounds["maxX"]:
                cursor["x"] = board_bounds["minX"]
                cursor["y"] += cursor["row_height"] + state.clearance
                cursor["row_height"] = 0.0
            if cursor["y"] + height > board_bounds["maxY"]:
                break  # out of board space entirely; report and move on
            target_x, target_y = cursor["x"] + width / 2, cursor["y"] + height / 2
            if first_target is None:
                first_target = (target_x, target_y)
            if place_region_bbox(region, target_x, target_y, 0.0, 0.0):
                cursor["x"] += width + state.clearance
                cursor["row_height"] = max(cursor["row_height"], height)
                placed = True
                break
            cursor["x"] += 50.0  # probe the next slot in this row
        if not placed and DEBUG and first_target is not None:
            placed = place_region_bbox(region, first_target[0], first_target[1], 0.0, 0.0, force=True)
            if placed:
                cursor["x"] += width + state.clearance
                cursor["row_height"] = max(cursor["row_height"], height)
        if not placed:
            report["unsatisfiedConstraints"].append({"type": "macro_placement_failed", "anchorDesignator": designator})


def check_far_from(state: PlacementState, regions: list[dict], region_params: dict, report: dict) -> None:
    by_designator = {r["anchorDesignator"]: r for r in regions}
    for designator, params in region_params.items():
        for entry in params.get("farFrom") or []:
            other = entry.get("anchor")
            min_distance = entry.get("minDistanceMil", 0)
            if designator not in by_designator or other not in by_designator:
                continue
            a = state.components[by_designator[designator]["anchorComponentId"]].bbox
            b = state.components[by_designator[other]["anchorComponentId"]].bbox
            gap_x = max(0.0, max(a["minX"] - b["maxX"], b["minX"] - a["maxX"]))
            gap_y = max(0.0, max(a["minY"] - b["maxY"], b["minY"] - a["maxY"]))
            distance = math.hypot(gap_x, gap_y) if gap_x and gap_y else max(gap_x, gap_y)
            if distance < min_distance:
                report["unsatisfiedConstraints"].append({
                    "type": "far_from_violation", "anchor": designator, "other": other,
                    "requiredMinDistanceMil": min_distance, "actualDistanceMil": round(distance, 2),
                })


# ---------------------------------------------------------------------------
# Wirelength estimate
# ---------------------------------------------------------------------------

def estimate_wirelength(pads: list[m.Pad], positions: dict[str, tuple[float, float]], excluded_nets: set[str]) -> float:
    by_net: dict[str, list[tuple[float, float]]] = {}
    for pad in pads:
        if not pad.net or pad.net in excluded_nets:
            continue
        point = positions.get(pad.component_id, (pad.x, pad.y)) if pad.component_id else (pad.x, pad.y)
        # Pads move rigidly with their component; approximate the pad's new
        # position as its component's new position offset by the pad's
        # original offset from the component's original position. Exact
        # recomputation (rotate_around per component delta) is done for the
        # actual changes.json output; this estimate is a proxy metric only.
        by_net.setdefault(pad.net, []).append(point)
    total = 0.0
    for points in by_net.values():
        total += geo.mst_length(points)
    return total


def wirelength_excluded_nets(snapshot: dict, net_usage: dict[str, int], threshold: int) -> set[str]:
    excluded = {net for net in net_usage if m.is_ground_net(net)}
    excluded |= m.pours_by_net(snapshot)
    excluded |= {net for net, count in net_usage.items() if count > threshold}
    return excluded


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    m.ensure_utf8_stdout()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", required=True)
    parser.add_argument("--regions", required=True)
    parser.add_argument("--region-params", required=True)
    parser.add_argument("--rules", default=None, help="defaults to rules.default.json next to this script")
    parser.add_argument("--out", required=True, help="changes.json output path")
    parser.add_argument("--report-out", default=None, help="defaults to report.json next to --out")
    parser.add_argument("--clearance-mil", type=float, default=DEFAULT_CLEARANCE_MIL)
    parser.add_argument("--wirelength-net-usage-threshold", type=int, default=DEFAULT_WIRELENGTH_NET_USAGE_THRESHOLD)
    parser.add_argument("--debug", action="store_true",
                         help="verbose per-placement tracing to stderr, and force a best-effort "
                              "(possibly colliding) position for anything that exhausts its retry "
                              "budget instead of leaving it untouched -- so changes.json always "
                              "comes out complete enough to render and inspect. Every forced "
                              "placement is still recorded in report.json's forcedPlacements list; "
                              "the gate does not treat --debug output as apply-ready.")
    args = parser.parse_args()

    global DEBUG
    DEBUG = args.debug

    snapshot = m.load_snapshot(args.snapshot)
    regions_json = m.load_json(args.regions)
    region_params = m.load_region_params(args.region_params)
    rules_path = args.rules
    if rules_path is None:
        from pathlib import Path
        rules_path = str(Path(__file__).with_name("rules.default.json"))
    rules = m.load_rules(rules_path)

    pads = m.all_pads(snapshot)
    pads_by_component: dict[str, list[m.Pad]] = {}
    for pad in pads:
        if pad.component_id:
            pads_by_component.setdefault(pad.component_id, []).append(pad)
    net_usage = m.net_usage_table(pads)

    components_by_id = m.component_by_id(snapshot)
    original_positions = {cid: (c["x"], c["y"]) for cid, c in components_by_id.items()}

    state = build_initial_state(snapshot, regions_json)

    report: dict = {
        "outsideBoard": [], "overlaps": [], "unsatisfiedConstraints": [], "unassigned": list(regions_json.get("unassigned", [])),
        "forcedPlacements": [], "skippedRegions": [],
        "estimatedWireLengthBefore": 0.0, "estimatedWireLengthAfter": 0.0, "wirelengthRegression": False,
    }

    # Patch match_rule's value lookup: PlacedComponent doesn't carry `value`,
    # so build a designator -> value map once and monkey-match via closures
    # in place_region_members through a small wrapper instead of threading
    # an extra parameter through every helper signature.
    value_by_component_id = {cid: m.component_value(c) for cid, c in components_by_id.items()}

    def matched_rule_for(component_id: str, designator: str) -> dict | None:
        return match_rule({"designator": designator, "value": value_by_component_id.get(component_id)}, rules)

    local_bboxes: dict[str, dict] = {}
    for region in regions_json["regions"]:
        designator = region["anchorDesignator"]
        try:
            anchor = state.components[region["anchorComponentId"]]
            anchor_pins = region["anchorPins"]
            # Members spread across 4 sides (not just one shelf to the
            # right), so wrap_width is sized per side using roughly a
            # quarter of the region's members.
            member_count = max(1, len(region["memberComponentIds"]))
            avg_item_span = 80.0  # rough default footprint span (mil); good enough to size the wrap width
            wrap_width = max(300.0, math.sqrt(member_count / 4) * avg_item_span * 1.5)
            side_cursors = make_side_cursors(anchor.bbox, state.clearance, wrap_width)
            next_side = 0
            member_boxes = [anchor.bbox]
            for member_id in region["memberComponentIds"]:
                member = state.components[member_id]
                if member.locked:
                    member_boxes.append(member.bbox)
                    continue
                # Structural pin targeting is the default strategy for ANY
                # component with a real 2-net (signal + ground) tie to a
                # specific anchor pin -- matching a rule only narrows how
                # close ("maxDistanceMil"), it doesn't gate whether "near its
                # pin" is even attempted.
                member_pads = pads_by_component.get(member_id, [])
                rule = matched_rule_for(member_id, member.designator)
                placed = False
                pin = find_target_pin(member_pads, anchor_pins)
                if pin is not None:
                    max_distance = rule.get("maxDistanceMil", DEFAULT_NEAR_PIN_MAX_DISTANCE_MIL) if rule else DEFAULT_NEAR_PIN_MAX_DISTANCE_MIL
                    placed = place_near_pin(state, member, anchor, pin, max_distance)
                if not placed:
                    # Not a clean 2-net decoupling match (3+ pads, or neither
                    # pad is ground) -- but if it still shares ANY net with
                    # an anchor pin, that connection's side wins over an
                    # arbitrary round-robin slot. Only components with zero
                    # net overlap with this anchor (tied to the region only
                    # by schematic-page grouping) fall back to round-robin.
                    preferred_side = find_connected_side(member_pads, anchor_pins, anchor.bbox)
                    if preferred_side is None:
                        preferred_side = SIDE_ORDER[next_side % len(SIDE_ORDER)]
                        next_side += 1
                    # The preferred side might be pinned against the board
                    # edge (e.g. a connector's outward-facing pins) with no
                    # real room -- try it first, but degrade to the other 3
                    # sides for a genuine (non-forced) slot before resorting
                    # to --debug's force-placement on any one side.
                    side_attempts = [preferred_side] + [s for s in SIDE_ORDER if s != preferred_side]
                    for attempt_index, side in enumerate(side_attempts):
                        is_last_attempt = attempt_index == len(side_attempts) - 1
                        placed = place_around_anchor(state, member, side_cursors[side], allow_force=is_last_attempt)
                        if placed:
                            break
                if not placed:
                    report["unsatisfiedConstraints"].append({
                        "type": "placement_failed", "componentId": member_id, "designator": member.designator,
                        "region": designator,
                    })
                    # It stays at its original position rather than moving --
                    # protect that spot as an obstacle, and mark it so the
                    # region's later rigid-body transform (macro placement)
                    # skips it instead of sweeping it along by mistake. It is
                    # deliberately NOT added to member_boxes: the region's local
                    # bbox represents what actually moves together as one rigid
                    # unit, and this component doesn't.
                    state.commit(member.bbox)
                    member.unplaceable = True
                else:
                    member_boxes.append(member.bbox)
            local_bboxes[designator] = geo.bbox_from_points(
                [p for box in member_boxes for p in geo.bbox_corners(box)]
            )
        except Exception as error:  # noqa: BLE001 -- one bad region must not abort the whole run
            debug_log(f"{designator}: SKIPPED due to an unexpected error: {error!r}")
            report["skippedRegions"].append({"anchorDesignator": designator, "error": repr(error)})
            local_bboxes[designator] = state.components[region["anchorComponentId"]].bbox

    macro_place_regions(state, regions_json["regions"], region_params, local_bboxes, report)
    check_far_from(state, regions_json["regions"], region_params, report)

    excluded_nets = wirelength_excluded_nets(snapshot, net_usage, args.wirelength_net_usage_threshold)
    report["estimatedWireLengthBefore"] = round(estimate_wirelength(pads, original_positions, excluded_nets), 2)
    new_positions = {cid: (c.x, c.y) for cid, c in state.components.items()}
    report["estimatedWireLengthAfter"] = round(estimate_wirelength(pads, new_positions, excluded_nets), 2)
    report["wirelengthRegression"] = report["estimatedWireLengthAfter"] > report["estimatedWireLengthBefore"] * WIRELENGTH_REGRESSION_BUDGET

    for component_id, component in state.components.items():
        if component.locked or not component.moved:
            continue
        if not geo.bbox_fully_inside_board(component.bbox, state.board, 0.0):
            report["outsideBoard"].append(component_id)
    # Only flag a pair as a NEW overlap if at least one side actually moved --
    # two components that were already touching (or whose bboxes already
    # overlapped, e.g. attribute-text-inflated bboxes) before this tool ran
    # are a pre-existing board condition, not something this run introduced,
    # and shouldn't block the gate on a run that never touched either of them.
    items = list(state.components.items())
    for i, (id_a, comp_a) in enumerate(items):
        for id_b, comp_b in items[i + 1:]:
            if not (comp_a.moved or comp_b.moved):
                continue
            if geo.bboxes_collide(comp_a.bbox, comp_b.bbox, 0.0):
                report["overlaps"].append([id_a, id_b])

    for component_id, component in state.components.items():
        if component.forced:
            report["forcedPlacements"].append({
                "componentId": component_id, "designator": component.designator,
                "x": round(component.x, 4), "y": round(component.y, 4),
            })

    changes = [
        {"componentId": cid, "x": round(c.x, 4), "y": round(c.y, 4), "rotation": round(c.rotation, 4)}
        for cid, c in state.components.items() if c.moved and not c.locked
    ]

    m.save_json(args.out, changes)
    report_out = args.report_out
    if report_out is None:
        from pathlib import Path
        report_out = str(Path(args.out).with_name("report.json"))
    m.save_json(report_out, report)

    print(f"{len(changes)} components moved")
    print(f"report: outsideBoard={len(report['outsideBoard'])} overlaps={len(report['overlaps'])} "
          f"unsatisfiedConstraints={len(report['unsatisfiedConstraints'])} unassigned={len(report['unassigned'])} "
          f"forcedPlacements={len(report['forcedPlacements'])} skippedRegions={len(report['skippedRegions'])} "
          f"wirelengthRegression={report['wirelengthRegression']}")
    if DEBUG and report["forcedPlacements"]:
        print(f"--debug forced {len(report['forcedPlacements'])} placements despite unresolved collisions -- "
              f"apply_gate.py will refuse this output, this run is for visualization only.")
    print(f"Wrote {args.out} and {report_out}")


if __name__ == "__main__":
    main()
