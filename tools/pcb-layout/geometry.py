"""离线 PCB 布局原型用的纯标准库二维几何工具函数。

旋转约定:角度用度数,坐标系跟 PCB 画布一致(x 向右,y 向下)。
``rotate_around`` 用的是标准旋转矩阵;这在屏幕上到底是"顺时针"还是
"逆时针",取决于消费这些坐标的工具怎么定义 y 轴方向。这里只保证内部
自洽(本模块和 place.py 全都用同一套约定),但**没有**跟真实的
EasyEDA 旋转操作对照验证过。真要在生产环境里信任一个非零的区域旋转
之前,先用 `pcb_transform_components` 真实旋转一个测试器件,确认焊盘
落点跟 `rotated_bbox`/`rotate_around` 算出来的一致。
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Iterable, Sequence

Point = tuple[float, float]


# ---------------------------------------------------------------------------
# 旋转基础函数
# ---------------------------------------------------------------------------

def rotate_around(point: Point, pivot: Point, theta_deg: float) -> Point:
    """把 `point` 绕 `pivot` 旋转 `theta_deg` 度。

    "区域刚体变换"能保持一致,靠的就是这一个基础函数:器件的位置、它
    自己的 `rotation` 增量、它的焊盘、它的 bbox 四个角,全都绕**同一个**
    锚点、用**同一个** theta 旋转——这样才能让整个区域作为一个刚体一起
    动,而不是只有锚点动了、成员被落在原地。
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
    """返回 bbox 的四个角坐标。"""
    return [
        (bbox["minX"], bbox["minY"]),
        (bbox["maxX"], bbox["minY"]),
        (bbox["maxX"], bbox["maxY"]),
        (bbox["minX"], bbox["maxY"]),
    ]


def bbox_from_points(points: Sequence[Point]) -> dict:
    """从一堆点算出能包住它们的轴对齐 bbox。"""
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    return {"minX": min(xs), "minY": min(ys), "maxX": max(xs), "maxY": max(ys)}


def rotated_bbox(bbox: dict, pivot: Point, theta_deg: float) -> dict:
    """算出一个刚体绕 pivot 旋转 theta_deg 之后的新 bbox。

    对**任意**角度都成立(不只是 0/90/180/270):这个项目里 PCB 器件的
    旋转角不像原理图符号那样只能是直角,所以"正交角度直接交换宽高"这
    种捷径对任意角度会悄悄算错。这里改成真的旋转四个角点,再重新求一
    次轴对齐包围盒。
    """
    corners = [rotate_around(corner, pivot, theta_deg) for corner in bbox_corners(bbox)]
    return bbox_from_points(corners)


def bboxes_collide(a: dict, b: dict, clearance: float = 0.0) -> bool:
    """跟 findComponentOverlaps 的间距膨胀重叠判定完全一致(src/pcb-analysis.mjs)。"""
    return (
        a["minX"] < b["maxX"] + clearance
        and a["maxX"] > b["minX"] - clearance
        and a["minY"] < b["maxY"] + clearance
        and a["maxY"] > b["minY"] - clearance
    )


def bbox_circle_collide(bbox: dict, center: Point, radius: float) -> bool:
    """判断 `bbox` 是否和圆心 `center`、半径 `radius` 的圆盘相交
    (用于天线/连接器锚点周围那种圆盘形禁布区)。"""
    closest_x = max(bbox["minX"], min(center[0], bbox["maxX"]))
    closest_y = max(bbox["minY"], min(center[1], bbox["maxY"]))
    return math.hypot(center[0] - closest_x, center[1] - closest_y) <= radius


def bbox_overhang(bbox: dict, board_bounds: dict) -> float:
    """`bbox` 在任意一侧超出 `board_bounds` 的最大 mil 数(完全在板内则为 0)。"""
    return max(
        0.0,
        board_bounds["minX"] - bbox["minX"],
        bbox["maxX"] - board_bounds["maxX"],
        board_bounds["minY"] - bbox["minY"],
        bbox["maxY"] - board_bounds["maxY"],
    )


# ---------------------------------------------------------------------------
# 板框:闭合环提取(外轮廓 + 孔洞)、圆弧离散化
# ---------------------------------------------------------------------------

def _quantize(point: Point, tolerance: float = 0.05) -> tuple[int, int]:
    """把坐标量化成一个可哈希的格子键,用来把"几乎重合"的端点合并成同一个顶点。"""
    return (round(point[0] / tolerance), round(point[1] / tolerance))


def tessellate_arc(start: Point, end: Point, included_angle_deg: float, max_chord_error: float = 2.0) -> list[Point]:
    """把一段圆弧图元(起点/终点/包含角,单位度)转换成折线,保证最大
    弦高差(弦到弧的间隙)不超过 `max_chord_error`。按 review 的要求,
    分段数量是根据圆弧实际半径和张角算出来的,不是固定角度步长:大圆
    弧多分几段,小圆弧几乎不用分。
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
    """板框多边形:外轮廓 + 若干孔洞(不是单一 polygon,因为板框可能有内部开槽)。"""
    outer: list[Point] = field(default_factory=list)
    holes: list[list[Point]] = field(default_factory=list)

    def bounds(self) -> dict:
        return bbox_from_points(self.outer) if self.outer else {"minX": 0, "minY": 0, "maxX": 0, "maxY": 0}


def _segments_from_outline(lines: Iterable[dict], arcs: Iterable[dict], max_chord_error: float = 2.0) -> list[tuple[Point, Point]]:
    """把板框图层的直线 + 圆弧统一拆成一批线段(圆弧先离散化)。"""
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
    """按端点分桶的闭合环追踪算法,思路跟 src/pcb-analysis.mjs(仓库根目录)
    里 checkBoardOutline 的判断闭合逻辑一致:先把端点坐标量化,让不同
    图元里"几乎重合"的坐标合并成同一个顶点,再顺着连通链一路走回起点。
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
            loops.append(loop_points[:-1])  # 去掉重复的闭合终点
        # 走不回起点的开放链(guard 用尽或找不到候选)说明板框没闭合,
        # 这里直接丢弃、不当成多边形处理;如果 `loops` 最后是空的,由
        # 调用方负责把"板框没闭合"这件事报出去。
    return loops


def _signed_area(points: list[Point]) -> float:
    """鞋带公式算多边形的有符号面积(正负号代表绕向,绝对值代表面积)。"""
    total = 0.0
    for i in range(len(points)):
        x1, y1 = points[i]
        x2, y2 = points[(i + 1) % len(points)]
        total += x1 * y2 - x2 * y1
    return total / 2


def build_board_polygon(lines: Iterable[dict], arcs: Iterable[dict], max_chord_error: float = 2.0) -> BoardPolygon:
    """外轮廓 = 面积最大的那个闭合环,其余的闭合环都算孔洞(按 review
    的说法:板框可能有内部开槽/多个闭合环,不能假设只有一个矩形)。"""
    segments = _segments_from_outline(lines, arcs, max_chord_error)
    loops = _trace_closed_loops(segments)
    if not loops:
        return BoardPolygon()
    loops_by_area = sorted(loops, key=lambda loop: abs(_signed_area(loop)), reverse=True)
    return BoardPolygon(outer=loops_by_area[0], holes=loops_by_area[1:])


def _point_in_ring(point: Point, ring: list[Point]) -> bool:
    """射线法判断点是否在一个闭合环内部。"""
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
    """点在外轮廓内、且不在任何一个孔洞里,才算真的在板子内部。"""
    if not polygon.outer:
        return False
    if not _point_in_ring(point, polygon.outer):
        return False
    return not any(_point_in_ring(point, hole) for hole in polygon.holes)


def bbox_sample_points(bbox: dict) -> list[Point]:
    """四个角 + 四条边的中点:计划里说好的"实用近似"包含性检查方式
    (不是完整的多边形裁剪)。"""
    corners = bbox_corners(bbox)
    mid = lambda a, b: ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
    midpoints = [mid(corners[i], corners[(i + 1) % 4]) for i in range(4)]
    return corners + midpoints


def bbox_fully_inside_board(bbox: dict, polygon: BoardPolygon, allowed_overhang_mil: float = 0.0) -> bool:
    """判断 bbox 是否完全落在板框内,允许一定的越界余量(给需要伸出板
    外的连接器用)。"""
    if allowed_overhang_mil > 0:
        overhang = bbox_overhang(bbox, polygon.bounds())
        if overhang <= allowed_overhang_mil:
            return True
        # 按 bbox 外接矩形算的越界量超预算了,但板子如果是异形的,外接
        # 矩形判断可能过于保守,所以还是走一遍精确的采样点判断兜底。
    return all(point_in_board(p, polygon) for p in bbox_sample_points(bbox))


# ---------------------------------------------------------------------------
# 线长估算
# ---------------------------------------------------------------------------

def mst_length(points: Sequence[Point]) -> float:
    """Prim 算法求最小生成树总长,O(n²)——单个网络的焊盘数量不会很多,这个复杂度完全够用。"""
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
