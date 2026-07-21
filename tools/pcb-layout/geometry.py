"""Stdlib-only 2D geometry helpers for the offline PCB placement prototype.

Rotation convention: angles are in degrees, matching the PCB canvas coordinate
system (x right, y down). ``rotate_around`` uses the standard rotation matrix;
whether that reads as "clockwise" or "counter-clockwise" on screen depends on
the y-axis direction of the consuming tool. This is internally consistent
(everything in this module and in place.py uses the same convention), but it
has NOT been cross-checked against a real EasyEDA rotate operation. Before
trusting a non-zero region rotation in production, rotate one test component
via `pcb_transform_components` and confirm the resulting pad positions match
what `rotated_bbox`/`rotate_around` predict.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Iterable, Sequence

Point = tuple[float, float]


# ---------------------------------------------------------------------------
# Rotation primitives
# ---------------------------------------------------------------------------

def rotate_around(point: Point, pivot: Point, theta_deg: float) -> Point:
    """Rotate `point` by `theta_deg` around `pivot`.

    This single primitive is what makes the "region rigid-body transform"
    consistent: rotating a component's position, its own `rotation` delta,
    its pads, and its bbox corners around the SAME pivot by the SAME theta
    is what keeps a region moving together as one rigid body instead of only
    the anchor moving while members are left behind.
    """
    if theta_deg == 0:
        return point
    theta = math.radians(theta_deg)
    cos_t, sin_t = math.cos(theta), math.sin(theta)
    dx, dy = point[0] - pivot[0], point[1] - pivot[1]
    return (
        pivot[0] + dx * cos_t - dy * sin_t,
        pivot[1] + dx * sin_t + dy * cos_t,
    )


def bbox_corners(bbox: dict) -> list[Point]:
    return [
        (bbox["minX"], bbox["minY"]),
        (bbox["maxX"], bbox["minY"]),
        (bbox["maxX"], bbox["maxY"]),
        (bbox["minX"], bbox["maxY"]),
    ]


def bbox_from_points(points: Sequence[Point]) -> dict:
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    return {"minX": min(xs), "minY": min(ys), "maxX": max(xs), "maxY": max(ys)}


def rotated_bbox(bbox: dict, pivot: Point, theta_deg: float) -> dict:
    """Bbox of a rigid body after rotating it by theta_deg around pivot.

    Correct for ANY angle (not just 0/90/180/270): PCB component rotation in
    this project is not restricted to right angles the way schematic symbol
    rotation is, so a "swap width/height for orthogonal angles" shortcut
    would silently be wrong for arbitrary rotations. This instead rotates
    the actual corners and re-derives the axis-aligned bounding box.
    """
    corners = [rotate_around(corner, pivot, theta_deg) for corner in bbox_corners(bbox)]
    return bbox_from_points(corners)


def bboxes_collide(a: dict, b: dict, clearance: float = 0.0) -> bool:
    """Mirrors findComponentOverlaps's clearance-inflated overlap test (src/pcb-analysis.mjs)."""
    return (
        a["minX"] < b["maxX"] + clearance
        and a["maxX"] > b["minX"] - clearance
        and a["minY"] < b["maxY"] + clearance
        and a["maxY"] > b["minY"] - clearance
    )


def bbox_circle_collide(bbox: dict, center: Point, radius: float) -> bool:
    """True if `bbox` overlaps the disc at `center` with `radius` (used for
    the disc-based anchor-clearance keepouts around antenna/connector
    anchors)."""
    closest_x = max(bbox["minX"], min(center[0], bbox["maxX"]))
    closest_y = max(bbox["minY"], min(center[1], bbox["maxY"]))
    return math.hypot(center[0] - closest_x, center[1] - closest_y) <= radius


def bbox_overhang(bbox: dict, board_bounds: dict) -> float:
    """Max mil that `bbox` extends past `board_bounds` on any side (0 if fully inside)."""
    return max(
        0.0,
        board_bounds["minX"] - bbox["minX"],
        bbox["maxX"] - board_bounds["maxX"],
        board_bounds["minY"] - bbox["minY"],
        bbox["maxY"] - board_bounds["maxY"],
    )


# ---------------------------------------------------------------------------
# Board outline: closed-loop extraction (outer + holes), arc tessellation
# ---------------------------------------------------------------------------

def _quantize(point: Point, tolerance: float = 0.05) -> tuple[int, int]:
    return (round(point[0] / tolerance), round(point[1] / tolerance))


def tessellate_arc(start: Point, end: Point, included_angle_deg: float, max_chord_error: float = 2.0) -> list[Point]:
    """Convert an arc primitive (start/end/included-angle, degrees) into a
    polyline whose max sagitta (chord-to-arc gap) stays under
    `max_chord_error`. Segment count scales with the arc's actual radius and
    sweep instead of a fixed angular step, per the review: large arcs get
    more segments, tiny arcs get almost none.
    """
    if abs(included_angle_deg) < 1e-9:
        return [start, end]
    theta = math.radians(included_angle_deg)
    dx, dy = end[0] - start[0], end[1] - start[1]
    chord = math.hypot(dx, dy)
    if chord < 1e-9:
        return [start, end]
    radius = chord / (2 * math.sin(abs(theta) / 2))
    mx, my = (start[0] + end[0]) / 2, (start[1] + end[1]) / 2
    ux, uy = -dy / chord, dx / chord
    h = radius * math.cos(theta / 2)
    sign = 1.0 if theta > 0 else -1.0
    cx, cy = mx + sign * h * ux, my + sign * h * uy
    start_angle = math.atan2(start[1] - cy, start[0] - cx)
    eps = min(max_chord_error, radius * 0.99)
    max_seg_angle = 2 * math.acos(max(-1.0, min(1.0, 1 - eps / radius)))
    steps = max(1, math.ceil(abs(theta) / max_seg_angle))
    points = []
    for i in range(steps + 1):
        t = start_angle + theta * (i / steps)
        points.append((cx + radius * math.cos(t), cy + radius * math.sin(t)))
    return points


@dataclass
class BoardPolygon:
    outer: list[Point] = field(default_factory=list)
    holes: list[list[Point]] = field(default_factory=list)

    def bounds(self) -> dict:
        return bbox_from_points(self.outer) if self.outer else {"minX": 0, "minY": 0, "maxX": 0, "maxY": 0}


def _segments_from_outline(lines: Iterable[dict], arcs: Iterable[dict], max_chord_error: float = 2.0) -> list[tuple[Point, Point]]:
    segments: list[tuple[Point, Point]] = []
    for line in lines:
        segments.append(((line["startX"], line["startY"]), (line["endX"], line["endY"])))
    for arc in arcs:
        poly = tessellate_arc(
            (arc["startX"], arc["startY"]), (arc["endX"], arc["endY"]), arc.get("angle", 0), max_chord_error,
        )
        for i in range(len(poly) - 1):
            segments.append((poly[i], poly[i + 1]))
    return segments


def _trace_closed_loops(segments: list[tuple[Point, Point]], tolerance: float = 0.05) -> list[list[Point]]:
    """Endpoint-bucketing closed-loop trace, mirroring checkBoardOutline's
    approach in src/pcb-analysis.mjs (repo root): quantize endpoints so
    near-duplicate coordinates from different primitives merge into one
    vertex, then walk each connected chain back to its start.
    """
    adjacency: dict[tuple[int, int], list[int]] = {}
    endpoints: list[tuple[Point, Point]] = []
    for index, (start, end) in enumerate(segments):
        endpoints.append((start, end))
        for point in (start, end):
            adjacency.setdefault(_quantize(point, tolerance), []).append(index)

    used = [False] * len(segments)
    loops: list[list[Point]] = []
    for index in range(len(segments)):
        if used[index]:
            continue
        loop_points = [endpoints[index][0], endpoints[index][1]]
        used[index] = True
        current_key = _quantize(endpoints[index][1], tolerance)
        start_key = _quantize(endpoints[index][0], tolerance)
        guard = len(segments) + 1
        while current_key != start_key and guard > 0:
            guard -= 1
            candidates = [i for i in adjacency.get(current_key, []) if not used[i]]
            if not candidates:
                break
            next_index = candidates[0]
            used[next_index] = True
            s, e = endpoints[next_index]
            next_point = e if _quantize(s, tolerance) == current_key else s
            loop_points.append(next_point)
            current_key = _quantize(next_point, tolerance)
        if current_key == start_key and len(loop_points) >= 3:
            loops.append(loop_points[:-1])  # drop duplicate closing point
        # Open chains (guard exhausted or no candidates) are incomplete board
        # outlines; they're dropped rather than treated as a polygon; caller
        # is responsible for surfacing that the outline didn't close if
        # `loops` ends up empty.
    return loops


def _signed_area(points: list[Point]) -> float:
    total = 0.0
    for i in range(len(points)):
        x1, y1 = points[i]
        x2, y2 = points[(i + 1) % len(points)]
        total += x1 * y2 - x2 * y1
    return total / 2


def build_board_polygon(lines: Iterable[dict], arcs: Iterable[dict], max_chord_error: float = 2.0) -> BoardPolygon:
    """outer = largest-area closed loop, everything else = holes (per review:
    board outlines can have internal slots/multiple loops, not just one
    rectangle)."""
    segments = _segments_from_outline(lines, arcs, max_chord_error)
    loops = _trace_closed_loops(segments)
    if not loops:
        return BoardPolygon()
    loops_by_area = sorted(loops, key=lambda loop: abs(_signed_area(loop)), reverse=True)
    return BoardPolygon(outer=loops_by_area[0], holes=loops_by_area[1:])


def _point_in_ring(point: Point, ring: list[Point]) -> bool:
    x, y = point
    inside = False
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % n]
        if (y1 > y) != (y2 > y):
            x_intersect = x1 + (y - y1) * (x2 - x1) / (y2 - y1)
            if x < x_intersect:
                inside = not inside
    return inside


def point_in_board(point: Point, polygon: BoardPolygon) -> bool:
    if not polygon.outer:
        return False
    if not _point_in_ring(point, polygon.outer):
        return False
    return not any(_point_in_ring(point, hole) for hole in polygon.holes)


def bbox_sample_points(bbox: dict) -> list[Point]:
    """4 corners + 4 edge midpoints: the practical containment-check
    approximation called out in the plan (not full polygon clipping)."""
    corners = bbox_corners(bbox)
    mid = lambda a, b: ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
    midpoints = [mid(corners[i], corners[(i + 1) % 4]) for i in range(4)]
    return corners + midpoints


def bbox_fully_inside_board(bbox: dict, polygon: BoardPolygon, allowed_overhang_mil: float = 0.0) -> bool:
    if allowed_overhang_mil > 0:
        overhang = bbox_overhang(bbox, polygon.bounds())
        if overhang <= allowed_overhang_mil:
            return True
        # Overhang budget exceeded on the bbox-bounds check; fall through to
        # the precise sample-point test in case the bbox bounds check was
        # overly conservative for a non-rectangular board.
    return all(point_in_board(p, polygon) for p in bbox_sample_points(bbox))


# ---------------------------------------------------------------------------
# Wirelength estimate
# ---------------------------------------------------------------------------

def mst_length(points: Sequence[Point]) -> float:
    """Prim's algorithm, O(n^2) — plenty fast at per-net pad counts this small."""
    if len(points) < 2:
        return 0.0
    remaining = list(range(1, len(points)))
    in_tree = [0]
    total = 0.0
    dist = lambda a, b: math.hypot(points[a][0] - points[b][0], points[a][1] - points[b][1])
    while remaining:
        best = None
        best_length = None
        for i in in_tree:
            for j in remaining:
                d = dist(i, j)
                if best_length is None or d < best_length:
                    best_length = d
                    best = j
        total += best_length
        in_tree.append(best)
        remaining.remove(best)
    return total
