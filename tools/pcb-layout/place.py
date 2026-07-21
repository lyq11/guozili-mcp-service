#!/usr/bin/env python3
"""Stage C:基于规则的区域内布局 + 宏观打包,由 region-params.json 驱动。
输出 changes.json(建议的新坐标)和 report.json(校验结果)——changes.json
在被当成"可以应用"之前,必须先看一遍 report.json(或者跑一遍 apply_gate.py)。
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
# 给任何有结构化引脚目标、但没有规则命中的器件用——规则只是收窄这个默认值
# (比如给某个具体的去耦电容值设更紧的 maxDistanceMil),不是决定要不要
# 走近引脚放置。
DEFAULT_NEAR_PIN_MAX_DISTANCE_MIL = 200.0

# 由 main() 里的 --debug 设置。为 True 时:(1) 布局决策会 trace 到
# stderr;(2) 一个器件/区域如果用完了重试预算,会强行塞到目前找到的最好
# 候选位置,而不是原地不动——这是用"正确性"换"changes.json 总是完整的,
# 方便渲染查看",哪怕启发式算法解不出一块干净的板子也一样。每个强行放置
# 的都会记进 report.json 的 `forcedPlacements`,门禁不会因为是 --debug
# 产生的结果就放宽标准。
DEBUG = False


def debug_log(*parts: object) -> None:
    """只在 --debug 打开时,把诊断信息打到 stderr。"""
    if DEBUG:
        print("[debug]", *parts, file=sys.stderr)


@dataclass
class PlacedComponent:
    """布局过程中一个器件的可变状态。"""
    id: str
    designator: str
    x: float
    y: float
    rotation: float
    bbox: dict
    locked: bool
    moved: bool = False
    # 一个在重试预算内没能完成区域内布局的成员,会留在原地,跟锁定器件
    # 一样——但关键是它绝不能被后续区域的刚体变换一起搬走,不然它会从
    # 原来的位置莫名其妙跳到一个旋转/平移之后的新位置,尽管它从来没被
    # 真正放置过。
    unplaceable: bool = False
    # --debug 把这个器件强行塞到一个仍然冲突的位置时为 True——一定会
    # 跟 report 最后那一遍重叠检查交叉核对,不会被悄悄藏起来。
    forced: bool = False


@dataclass
class PlacementState:
    """整个布局过程的全局状态:所有器件、障碍物列表、禁布区、板框。"""
    components: dict[str, PlacedComponent]
    obstacles: list[dict] = field(default_factory=list)  # bbox 列表,随着器件被放置不断增长
    disc_keepouts: list[tuple[tuple[float, float], float]] = field(default_factory=list)
    board: geo.BoardPolygon = field(default_factory=geo.BoardPolygon)
    clearance: float = DEFAULT_CLEARANCE_MIL

    def collides(self, bbox: dict, allowed_overhang_mil: float = 0.0) -> bool:
        """判断给定 bbox 是否跟障碍物、禁布区冲突,或者没有完全落在板框内。"""
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
        """把一个 bbox 登记成障碍物,后面的放置都要避开它。"""
        self.obstacles.append(bbox)


def build_initial_state(snapshot: dict, regions_json: dict) -> PlacementState:
    """从快照和 Stage A 的结果初始化布局状态。"""
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
            obstacles.append(bbox)  # 按计划,锁定器件从一开始就是障碍物

    # 每个锚点本体,从区域内布局最开始就是障碍物,不只是"自己区域的成员
    # 要避开它"——不然邻居区域的绕边打包可能会把成员堆到一个还没轮到处理
    # 的锚点身上。
    anchor_ids = {region["anchorComponentId"] for region in regions_json.get("regions", [])}
    for anchor_id in anchor_ids:
        component = components.get(anchor_id)
        if component and not component.locked:
            obstacles.append(component.bbox)

    # 未分配的器件(regions.py 没法把它们归到任何锚点)不会被这个工具挪动,
    # 但它们仍然实实在在占着原来的位置——别的器件放置的时候必须避开它们。
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
    # EDA 原生 region(NO_COMPONENTS 类型)来源的禁布区,regions.py 会提
    # 取出来,但这里**没有**真正拿来做碰撞检测——它们的 `polygon` 字段是
    # EasyEDA 内部的原始多边形格式,这个离线脚本没有解码器(只解码了板框
    # 图层的直线/圆弧)。这是已知的 v1 缺口,不是被悄悄忽略掉的。
    return PlacementState(components=components, obstacles=obstacles, disc_keepouts=disc_keepouts, board=board)


# ---------------------------------------------------------------------------
# 去耦 / 近目标引脚的结构化规则匹配
# ---------------------------------------------------------------------------

def match_rule(component: dict, rules: list[dict]) -> dict | None:
    """按位号前缀 + 数值匹配规则表,返回第一个命中的规则。"""
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
    """结构化判定,不是靠字符串/网络名瞎猜:一个匹配到规则的器件,只有在
    "恰好一个焊盘接地、另一个焊盘的网络正好是锚点某个引脚的网络"这种
    结构下,才算是给那个**具体**引脚去耦。返回那个锚点引脚,如果器件
    不满足这个 2 网络的结构就返回 None(于是退回 shelf 打包,而不是硬凑
    到一个不相关的引脚旁边)。"""
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
    """判断 `point` 相对锚点自身中心,更靠近锚点的哪一边——哪个轴向的
    偏移量更大就用哪个轴判(一个明显偏在锚点左边、只是稍微偏上一点点的
    引脚,应该判成"left",不是"top")。"""
    center_x = (anchor_bbox["minX"] + anchor_bbox["maxX"]) / 2
    center_y = (anchor_bbox["minY"] + anchor_bbox["maxY"]) / 2
    dx, dy = point[0] - center_x, point[1] - center_y
    if abs(dx) >= abs(dy):
        return "right" if dx >= 0 else "left"
    return "bottom" if dy >= 0 else "top"


def find_connected_side(component_pads: list[m.Pad], anchor_pins: list[dict], anchor_bbox: dict) -> str | None:
    """给那些够不上 find_target_pin 严格"2 网络去耦结构"的器件用(比如
    3 个以上焊盘,或者两个焊盘都不是干净的接地/信号对),但只要它跟锚点
    还共享某个网络:就摆在它连的那(几)个引脚实际所在的那一侧,而不是
    随便轮询分配。只有跟这个锚点真的一个网络都不共享的器件(纯粹靠原理
    图页分组分进这个区域的)才会走轮询,因为那种情况没有"电气上该在哪
    一侧"这回事。"""
    matching_pins = [pin for pin in anchor_pins for pad in component_pads if pad.net and pad.net == pin["net"]]
    if not matching_pins:
        return None
    avg_x = sum(pin["x"] for pin in matching_pins) / len(matching_pins)
    avg_y = sum(pin["y"] for pin in matching_pins) / len(matching_pins)
    return infer_side((avg_x, avg_y), anchor_bbox)


# ---------------------------------------------------------------------------
# 区域内布局
# ---------------------------------------------------------------------------

def place_near_pin(state: PlacementState, component: PlacedComponent, anchor: PlacedComponent, pin: dict, max_distance_mil: float) -> bool:
    """尝试把 `component` 放到 `pin` 附近,朝向调整成让它接目标网络的那个
    焊盘正对着这个引脚(这是个"缩短回路"的启发式做法,不是真正的电感
    求解器——见计划里的限制说明)。按半径递增、每个半径多个角度去试;
    如果在 max_distance_mil 范围内怎么都放不下,返回 False(器件保持
    未放置状态)。"""
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
            component.rotation = angle % 360  # 让接电源网络的焊盘正对目标引脚
            component.bbox = candidate_bbox
            component.moved = True
            state.commit(candidate_bbox)
            debug_log(f"{component.designator}: 贴到引脚 {pin.get('number')} 附近,"
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
        debug_log(f"{component.designator}: 强行放到引脚 {pin.get('number')} 附近"
                  f"(在 {max_distance_mil}mil 范围内找不到不冲突的位置)")
        return True
    debug_log(f"{component.designator}: 在 {max_distance_mil}mil 范围内放不到引脚 {pin.get('number')} 附近,"
              f"退回 shelf 打包")
    return False


MAX_SHELF_ROW_WRAPS = 12
SIDE_ORDER = ["right", "bottom", "left", "top"]


def make_side_cursors(anchor_bbox: dict, clearance: float, wrap_width: float) -> dict[str, dict]:
    """给锚点的每一侧各配一个打包游标,让成员真正围着锚点摆——右/左两侧
    按列从上往下填(一列填满了往右/左再开一列),上/下两侧按行从左往右填
    (一行填满了往上/下再开一行)。这样就不再是只会往锚点右边长的单条
    shelf 了。"""
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
    """把 `component` 打包进锚点的某一侧(见 make_side_cursors),沿着行/列
    方向填充,填满了就往外换行/换列。`cursor` 是这一侧所有成员共用的可变
    状态(每次调用都接着上一次的位置继续),所以就算这次调用失败了,也
    必须让它保持在一个正常的状态:限制换行/换列次数(而不是限制原始
    迭代次数),防止一连串的冲突把游标带到离谱的地方;放弃的时候把游标
    回滚到这次调用开始前的状态(而不是留在失败搜索走到的地方),这样
    这一侧的下一个成员就不会摆在一个被搞坏的位置上面。

    `allow_force=False` 会关掉这次调用里 --debug 的"用尽预算就强行放置"
    这个兜底——用在按优先级依次尝试好几侧的场景(电气上更合适的那一侧
    先试,比如某一侧正好贴着板边),这样前面几个不太合适的侧就不会在
    后面的侧还没真正试过(没冲突的)位置之前,就把强行放置的名额占掉。"""
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
            debug_log(f"{component.designator}: 放到 ({cx:.0f}, {cy:.0f})")
            return True
        fill_pos += fill_size + state.clearance
        if fill_pos - entry_fill_pos > cursor["wrap_width"]:
            fill_pos = entry_fill_pos
            wrap_pos += cross_size + state.clearance
            wraps += 1
    # 放弃:把共用游标回滚到这次调用开始前的状态,不让一次失败的搜索
    # 拖累后面所有兄弟成员的位置,然后把游标推进这个器件自己的尺寸那么
    # 多(就当它已经落在 first_candidate 那样,不管到底有没有真的强行
    # 放置它)。
    cursor["fill_pos"] = entry_fill_pos + fill_size + state.clearance
    cursor["wrap_pos"] = entry_wrap_pos
    if DEBUG and allow_force and first_candidate is not None:
        cx, cy, candidate_bbox = first_candidate
        component.x, component.y = cx, cy
        component.bbox = candidate_bbox
        component.moved = True
        component.forced = True
        state.commit(candidate_bbox)
        debug_log(f"{component.designator}: 强行放到 ({cx:.0f}, {cy:.0f})(找不到空位)")
        return True
    debug_log(f"{component.designator}: 换了 {MAX_SHELF_ROW_WRAPS} 轮还是没有空位")
    return False


# 每个区域的区域内布局是在 main() 里直接完成的,那里能拿到一个
# 位号 -> 数值 的查表闭包(matched_rule_for):任何有结构化引脚目标的
# 器件走 place_near_pin,其余的靠 place_around_anchor 轮询/按侧摆到锚点
# 四周,每个区域算出来的 bbox 交给下面的宏观打包阶段当成一个刚体来摆。


# ---------------------------------------------------------------------------
# 宏观打包
# ---------------------------------------------------------------------------

def apply_region_rigid_transform(state: PlacementState, region: dict, anchor_new_pos: tuple[float, float], theta_deg: float) -> None:
    """把整个区域(锚点 + 全部成员)当成一个刚体,旋转 theta_deg、平移到
    锚点的新位置。"""
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
    """把每个区域整体摆到板子上的最终位置:有 edgeConstraint 的先摆,剩下
    的按 type 分组做行排列打包。"""
    board_bounds = state.board.bounds()
    edge_regions = [r for r in regions if (region_params.get(r["anchorDesignator"]) or {}).get("edgeConstraint")]
    other_regions = [r for r in regions if r not in edge_regions]

    cursor = {"x": board_bounds["minX"], "y": board_bounds["minY"], "row_height": 0.0}

    def place_region_bbox(region: dict, target_x: float, target_y: float, theta_deg: float, allowed_overhang_mil: float, force: bool = False) -> bool:
        local_bbox = local_bboxes[region["anchorDesignator"]]
        anchor = state.components[region["anchorComponentId"]]
        if anchor.locked:
            return True  # 锚点锁定的区域永远不重新摆位置;已经在别处校验过了
        # target_x/target_y 是锚点想要摆到的新位置;theta_deg 是要施加给
        # 整个区域的旋转增量(非边缘区域是 0,边缘约束区域是
        # requiredRotation - anchor.rotation,调用方算好传进来)。
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
            debug_log(f"{region['anchorDesignator']}: 强行宏观放置到 "
                      f"({target_x:.0f}, {target_y:.0f})(仍然有冲突)")
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
        # 从共用游标往前扫:碰到冲突就往前挪(必要时换行)再试,而不是
        # 卡在第一个位置——单个区域失败一次,不能把排在它后面的所有区域
        # 都一起卡住。
        guard = 400
        first_target = None
        while guard > 0:
            guard -= 1
            if cursor["x"] + width > board_bounds["maxX"]:
                cursor["x"] = board_bounds["minX"]
                cursor["y"] += cursor["row_height"] + state.clearance
                cursor["row_height"] = 0.0
            if cursor["y"] + height > board_bounds["maxY"]:
                break  # 板子空间完全用完了;记下来跳过
            target_x, target_y = cursor["x"] + width / 2, cursor["y"] + height / 2
            if first_target is None:
                first_target = (target_x, target_y)
            if place_region_bbox(region, target_x, target_y, 0.0, 0.0):
                cursor["x"] += width + state.clearance
                cursor["row_height"] = max(cursor["row_height"], height)
                placed = True
                break
            cursor["x"] += 50.0  # 探测这一行的下一个位置
        if not placed and DEBUG and first_target is not None:
            placed = place_region_bbox(region, first_target[0], first_target[1], 0.0, 0.0, force=True)
            if placed:
                cursor["x"] += width + state.clearance
                cursor["row_height"] = max(cursor["row_height"], height)
        if not placed:
            report["unsatisfiedConstraints"].append({"type": "macro_placement_failed", "anchorDesignator": designator})


def check_far_from(state: PlacementState, regions: list[dict], region_params: dict, report: dict) -> None:
    """检查 farFrom 约束:两个区域锚点之间的边到边距离,是否满足要求的最小距离。"""
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
# 线长估算
# ---------------------------------------------------------------------------

def estimate_wirelength(pads: list[m.Pad], positions: dict[str, tuple[float, float]], excluded_nets: set[str]) -> float:
    """按网络分组,用每个网络焊盘位置的最小生成树长度之和,估算总线长。"""
    by_net: dict[str, list[tuple[float, float]]] = {}
    for pad in pads:
        if not pad.net or pad.net in excluded_nets:
            continue
        point = positions.get(pad.component_id, (pad.x, pad.y)) if pad.component_id else (pad.x, pad.y)
        # 焊盘是跟着自己的器件刚性移动的;这里用"器件的新位置 + 焊盘相对
        # 器件原始位置的偏移"来近似焊盘的新位置。真正精确的重新计算
        # (按每个器件的旋转增量做 rotate_around)是在生成 changes.json
        # 的时候做的;这里只是一个估算用的代理指标。
        by_net.setdefault(pad.net, []).append(point)
    total = 0.0
    for points in by_net.values():
        total += geo.mst_length(points)
    return total


def wirelength_excluded_nets(snapshot: dict, net_usage: dict[str, int], threshold: int) -> set[str]:
    """算线长时要排除的网络:接地网络、已经有铺铜的网络、使用数超过阈值的全局网络。"""
    excluded = {net for net in net_usage if m.is_ground_net(net)}
    excluded |= m.pours_by_net(snapshot)
    excluded |= {net for net, count in net_usage.items() if count > threshold}
    return excluded


# ---------------------------------------------------------------------------
# 主函数
# ---------------------------------------------------------------------------

def main() -> None:
    m.ensure_utf8_stdout()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", required=True)
    parser.add_argument("--regions", required=True)
    parser.add_argument("--region-params", required=True)
    parser.add_argument("--rules", default=None, help="默认是这个脚本同目录下的 rules.default.json")
    parser.add_argument("--out", required=True, help="changes.json 输出路径")
    parser.add_argument("--report-out", default=None, help="默认是 --out 同目录下的 report.json")
    parser.add_argument("--clearance-mil", type=float, default=DEFAULT_CLEARANCE_MIL)
    parser.add_argument("--wirelength-net-usage-threshold", type=int, default=DEFAULT_WIRELENGTH_NET_USAGE_THRESHOLD)
    parser.add_argument("--debug", action="store_true",
                         help="把每一步布局决策详细 trace 到 stderr,并且对任何用尽重试预算的"
                              "东西,强行给一个尽力而为(可能还有冲突)的位置,而不是保持原地"
                              "不动——这样 changes.json 总能完整到可以渲染查看。每一个强行放置"
                              "的都还是会记进 report.json 的 forcedPlacements 列表;门禁不会把"
                              "--debug 的结果当成可以直接应用。")
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

    # 给 match_rule 的数值查找打个补丁:PlacedComponent 本身不带 `value`
    # 字段,所以这里一次性建好一张 位号 -> 数值 的表,通过一个小闭包在
    # 下面按需查,而不是把这个额外参数一路穿透传给每个辅助函数。
    value_by_component_id = {cid: m.component_value(c) for cid, c in components_by_id.items()}

    def matched_rule_for(component_id: str, designator: str) -> dict | None:
        return match_rule({"designator": designator, "value": value_by_component_id.get(component_id)}, rules)

    local_bboxes: dict[str, dict] = {}
    for region in regions_json["regions"]:
        designator = region["anchorDesignator"]
        try:
            anchor = state.components[region["anchorComponentId"]]
            anchor_pins = region["anchorPins"]
            # 成员分散到 4 个侧边摆(不再是全部堆到锚点右边一条 shelf),
            # 所以 wrap_width 按每侧大概分到这个区域四分之一的成员数来定尺寸。
            member_count = max(1, len(region["memberComponentIds"]))
            avg_item_span = 80.0  # 粗略的默认器件尺寸(mil),够用来估 wrap_width 了
            wrap_width = max(300.0, math.sqrt(member_count / 4) * avg_item_span * 1.5)
            side_cursors = make_side_cursors(anchor.bbox, state.clearance, wrap_width)
            next_side = 0
            member_boxes = [anchor.bbox]
            for member_id in region["memberComponentIds"]:
                member = state.components[member_id]
                if member.locked:
                    member_boxes.append(member.bbox)
                    continue
                # 结构化引脚定位是默认策略,只要器件跟某个具体锚点引脚有
                # 真实的 2 网络(信号+地)连接关系,不管有没有规则命中都会
                # 走这条路——规则只是收窄"贴多近"(maxDistanceMil),不
                # 决定"要不要贴引脚"。
                member_pads = pads_by_component.get(member_id, [])
                rule = matched_rule_for(member_id, member.designator)
                placed = False
                pin = find_target_pin(member_pads, anchor_pins)
                if pin is not None:
                    max_distance = rule.get("maxDistanceMil", DEFAULT_NEAR_PIN_MAX_DISTANCE_MIL) if rule else DEFAULT_NEAR_PIN_MAX_DISTANCE_MIL
                    placed = place_near_pin(state, member, anchor, pin, max_distance)
                if not placed:
                    # 不满足严格的 2 网络去耦结构(3 个以上焊盘,或者两个
                    # 焊盘都不是地)——但只要它跟锚点还共享某个网络,那个
                    # 连接所在的那一侧就该赢过随便轮询分配的位置。只有
                    # 跟这个锚点零网络重叠的器件(纯靠原理图页分组分进来
                    # 的)才会走轮询。
                    preferred_side = find_connected_side(member_pads, anchor_pins, anchor.bbox)
                    if preferred_side is None:
                        preferred_side = SIDE_ORDER[next_side % len(SIDE_ORDER)]
                        next_side += 1
                    # 电气上"该去的那一侧"可能刚好贴着板边没有真实空间
                    # (比如连接器朝外的引脚)——先试它,但如果没有真的
                    # (非强行)空位,就依次降级尝试另外三侧,最后才轮到
                    # --debug 在某一侧强行放置。
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
                    # 它留在原来的位置,不移动——把这个位置登记成障碍物,
                    # 并标记一下,这样区域后续的刚体变换(宏观打包)阶段
                    # 会跳过它,不会误把它一起搬走。这里故意**不**把它加进
                    # member_boxes:区域的局部 bbox 代表的是真正会一起
                    # 刚性移动的那部分,这个器件不算在内。
                    state.commit(member.bbox)
                    member.unplaceable = True
                else:
                    member_boxes.append(member.bbox)
            local_bboxes[designator] = geo.bbox_from_points(
                [p for box in member_boxes for p in geo.bbox_corners(box)]
            )
        except Exception as error:  # noqa: BLE001 -- 一个区域出错不能拖垮整个运行
            debug_log(f"{designator}: 因为意外错误被跳过:{error!r}")
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
    # 只有当两者中至少有一个真的移动过,才把这一对判成"新出现的重叠"——
    # 两个从来没被这次运行动过的器件,它们的 bbox 本来就可能有重叠(比如
    # 属性文字撑大了 bbox),那是这次运行之前就有的既有情况,不是这次
    # 运行造成的,不该因为这个去卡这次没碰过它们俩的运行结果。
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

    print(f"{len(changes)} 个器件被移动")
    print(f"report:outsideBoard={len(report['outsideBoard'])} overlaps={len(report['overlaps'])} "
          f"unsatisfiedConstraints={len(report['unsatisfiedConstraints'])} unassigned={len(report['unassigned'])} "
          f"forcedPlacements={len(report['forcedPlacements'])} skippedRegions={len(report['skippedRegions'])} "
          f"wirelengthRegression={report['wirelengthRegression']}")
    if DEBUG and report["forcedPlacements"]:
        print(f"--debug 强行放置了 {len(report['forcedPlacements'])} 个还有未解决冲突的器件 —— "
              f"apply_gate.py 会拒绝这份结果,这次运行只是给你看布局用的。")
    print(f"已写入 {args.out} 和 {report_out}")


if __name__ == "__main__":
    main()
