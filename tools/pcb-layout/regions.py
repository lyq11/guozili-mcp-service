#!/usr/bin/env python3
"""Stage A:把每个非锚点器件归属到它所属的 U 锚点,提取板框多边形和禁布区,
并生成一份 region-params 模板,交给 AI 填入真正有语义的布局提示。
"""

from __future__ import annotations

import argparse

import geometry as geo
import model as m

# EPCB_PrimitiveRegionRuleType.NO_COMPONENTS,来自 @jlceda/pro-api-types --
# 带这个规则类型的 region 是禁止放置器件的禁布区。
NO_COMPONENTS_RULE_TYPE = 2

# 天线/连接器锚点周围的默认间距圆盘半径(mil)的粗略默认值,给那些还没
# 有把 RF/机械间距建模成 PCB region 的项目用。这是个占位默认值,是需要
# 按项目调的,不是工程常量——想覆盖就传 --anchor-clearance-mil。
DEFAULT_ANCHOR_CLEARANCE_MIL = 100.0


def net_score(component_pads: list[m.Pad], anchor_pads: list[m.Pad], net_usage: dict[str, int]) -> float:
    """逆频率网络评分:只被锚点和这个器件共享的网络(使用数=2)贡献
    0.5;被 40 个器件共享的网络贡献 0.025。GND 整个排除在外,不然板上
    最常见的那根地线会让每个器件看起来都跟每个锚点相关。"""
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
    """构建区域归属结果:board polygon、禁布区、每个锚点的成员列表、未分配列表。"""
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

    anchor_ids: dict[str, str] = {}  # 位号 -> 器件 id
    anchor_pages: dict[str, str] = {}
    for designator, info in anchors.items():
        component = components_by_designator.get(designator)
        if not component:
            continue  # anchors.json 里提到的位号,在这份快照里找不到
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
            chosen = page_anchors[0]  # 原理图页匹配到唯一一个锚点,没有歧义
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
    parser.add_argument("--out", required=True, help="regions.json 输出路径")
    parser.add_argument("--region-params-template-out", default=None,
                         help="默认是 --out 同目录下的 region-params.template.json")
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

    print(f"{len(regions_json['regions'])} 个区域,{len(regions_json['unassigned'])} 个未分配器件")
    if not regions_json["board"]["polygon"]["outer"]:
        print("警告:板框没有闭合成多边形——所有的包含性检查都会被拒绝")
    print(f"已写入 {args.out} 和 {template_out}")


if __name__ == "__main__":
    main()
