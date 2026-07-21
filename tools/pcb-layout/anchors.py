#!/usr/bin/env python3
"""Stage 0:从 pcb_inspect 快照里提议 PCB 布局锚点候选。

锚点**不是**由这个脚本自动拍板的——它只是按位号前缀惯例提议候选
(U -> ic 芯片、J -> connector 连接器、Y/X -> crystal 晶振、ANT ->
antenna 天线、T -> transformer 变压器,大尺寸的 L 封装标记出来待review)。
AI 或人工必须review anchors.template.json,修正角色、删掉误判、把前缀表
漏掉的补上(比如某个位号不常规的电感或 SIM 卡座),再存成 anchors.json。
"""

from __future__ import annotations

import argparse

import model as m

# 位号是 "L" 且封装尺寸(按 bbox 面积,单位 mil^2)超过这个阈值的,标记
# 为候选电源电感待review,不直接采纳——小尺寸的 L 封装通常是信号级电感,
# 不是布局锚点。
LARGE_L_AREA_THRESHOLD_MIL2 = 400.0 * 400.0


def bbox_area(component: dict) -> float:
    """算器件 bbox 的面积。"""
    bbox = component.get("bbox")
    if not bbox:
        return 0.0
    return abs(bbox["maxX"] - bbox["minX"]) * abs(bbox["maxY"] - bbox["minY"])


def propose_candidates(snapshot: dict) -> dict[str, dict]:
    """扫描快照,按位号前缀表提议锚点候选。"""
    candidates: dict[str, dict] = {}
    for component in snapshot.get("components", []):
        designator = component.get("designator")
        if not designator:
            continue
        if component.get("locked") is True:
            # 已经锁定的器件是结构性障碍物,不是后续阶段要挪动的区域锚点。
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
    parser.add_argument("--snapshot", required=True, help="pcb_inspect 快照 JSON")
    parser.add_argument("--out", required=True, help="anchors.template.json 输出路径")
    args = parser.parse_args()

    snapshot = m.load_snapshot(args.snapshot)
    candidates = propose_candidates(snapshot)
    m.save_json(args.out, candidates)
    print(f"已写入 {len(candidates)} 个锚点候选到 {args.out}")
    print("使用前请先review这份文件:确认角色、删掉误判、补上漏掉的锚点。")


if __name__ == "__main__":
    main()
