#!/usr/bin/env python3
"""真正的门禁:读 report.json,只有干净的时候才生成 validated-changes.json。
`changes.json` 本身永远不算"可以应用"——不管 changes.json 是谁产生的、
怎么产生的,构造真正的 `pcb_transform_components` 调用时都只应该读
`validated-changes.json`。

校验失败时,会把上一次运行留下的、已经过期的 validated-changes.json
删掉,这样一次失败的重跑不会留下一个看起来还很新鲜、实际上已经过期的
旧结果在那儿。
"""

from __future__ import annotations

import argparse
import hashlib
import sys
from datetime import datetime, timezone
from pathlib import Path

import model as m

REQUIRED_EMPTY_LISTS = ["outsideBoard", "overlaps", "unsatisfiedConstraints", "unassigned", "forcedPlacements"]


def evaluate(report: dict) -> list[str]:
    """返回一份人类可读的失败原因列表;空列表就是干净的。"""
    failures = []
    for key in REQUIRED_EMPTY_LISTS:
        count = len(report.get(key) or [])
        if count:
            failures.append(f"{key}: {count} 条")
    if report.get("wirelengthRegression"):
        failures.append(
            f"wirelengthRegression: 预估线长 {report.get('estimatedWireLengthAfter')} "
            f"超出了预算(原本是 {report.get('estimatedWireLengthBefore')})"
        )
    return failures


def main() -> None:
    m.ensure_utf8_stdout()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", required=True, help="changes.json 是根据哪份快照算出来的")
    parser.add_argument("--changes", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--out", required=True, help="validated-changes.json 输出路径")
    parser.add_argument("--force", action="store_true", help="不管有没有校验失败,都强行生成 validated-changes.json(会大声提醒你)")
    args = parser.parse_args()

    snapshot_bytes = Path(args.snapshot).read_bytes()
    snapshot = m.load_snapshot(args.snapshot)
    changes = m.load_json(args.changes)
    report = m.load_json(args.report)

    failures = evaluate(report)

    if failures and not args.force:
        if Path(args.out).exists():
            Path(args.out).unlink()
        print("拒绝:report.json 不干净,没有生成 validated-changes.json(过期的旧文件也已经删掉了):")
        for reason in failures:
            print(f"  - {reason}")
        sys.exit(1)

    if failures and args.force:
        print("--force:强行覆盖一份不干净的结果。以下检查没通过:")
        for reason in failures:
            print(f"  - {reason}")

    validated = {
        "pcbUuid": (snapshot.get("board") or {}).get("pcb", {}).get("uuid"),
        "sourceSnapshotHash": "sha256:" + hashlib.sha256(snapshot_bytes).hexdigest(),
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "componentCount": len(snapshot.get("components", [])),
        "changes": changes,
    }
    m.save_json(args.out, validated)
    print(f"已写入 {args.out}(共 {len(changes)} 个器件的变更)。")
    print("提醒:调用 pcb_transform_components 之前,先重新拉一次实时快照,确认这里每个"
          "componentId 都还存在、没有被锁定——这份文件里的快照哈希只是留档用的,不能替代"
          "这个实时核对。")


if __name__ == "__main__":
    main()
