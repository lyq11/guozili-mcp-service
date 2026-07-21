#!/usr/bin/env python3
"""The real gate: reads report.json and only emits validated-changes.json
when it's clean. `changes.json` on its own is never apply-ready -- only
`validated-changes.json` should ever be read when constructing the real
`pcb_transform_components` call, regardless of who or what produced
`changes.json`.

On failure, any stale validated-changes.json from a previous run is deleted
so a failed re-run can't leave a misleadingly-fresh-looking old result lying
around.
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
    """Returns a list of human-readable failure reasons; empty means clean."""
    failures = []
    for key in REQUIRED_EMPTY_LISTS:
        count = len(report.get(key) or [])
        if count:
            failures.append(f"{key}: {count} entr{'y' if count == 1 else 'ies'}")
    if report.get("wirelengthRegression"):
        failures.append(
            f"wirelengthRegression: estimated wirelength {report.get('estimatedWireLengthAfter')} "
            f"exceeds budget over {report.get('estimatedWireLengthBefore')}"
        )
    return failures


def main() -> None:
    m.ensure_utf8_stdout()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", required=True, help="the snapshot changes.json was computed from")
    parser.add_argument("--changes", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--out", required=True, help="validated-changes.json output path")
    parser.add_argument("--force", action="store_true", help="emit validated-changes.json despite failures (loudly)")
    args = parser.parse_args()

    snapshot_bytes = Path(args.snapshot).read_bytes()
    snapshot = m.load_snapshot(args.snapshot)
    changes = m.load_json(args.changes)
    report = m.load_json(args.report)

    failures = evaluate(report)

    if failures and not args.force:
        if Path(args.out).exists():
            Path(args.out).unlink()
        print("REFUSED: report.json is not clean, validated-changes.json was NOT written (and any stale copy was removed):")
        for reason in failures:
            print(f"  - {reason}")
        sys.exit(1)

    if failures and args.force:
        print("--force: overriding a non-clean report. The following checks failed:")
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
    print(f"Wrote {args.out} ({len(changes)} component changes).")
    print("Reminder: re-fetch a fresh snapshot and confirm every componentId here still exists "
          "and is unlocked before calling pcb_transform_components -- this file's snapshot hash "
          "is for audit only, it does not replace that live check.")


if __name__ == "__main__":
    main()
