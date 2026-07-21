"""Loaders and shared data model for the offline PCB placement prototype.

Works directly against the current (untrimmed) `pcb_inspect` snapshot shape —
handles both `otherProperty.Value` (today's shape) and a possible future
top-level `value` field, so this doesn't need to change if the MCP server's
serialization gets trimmed later.
"""

from __future__ import annotations

import io
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

import geometry as geo


def ensure_utf8_stdout() -> None:
    """Call from a script's `if __name__ == "__main__":` guard only -- never
    at module import time, or importing this module for tests/reuse mutates
    the importing process's global stdout as a side effect."""
    if hasattr(sys.stdout, "buffer"):
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

GROUND_NET_NAMES = {"gnd", "agnd", "dgnd", "pgnd"}

# Designator prefix -> default anchor role, used by anchors.py to propose
# candidates. Not exhaustive and not authoritative — the AI/human is expected
# to edit the resulting anchors.template.json, per the plan.
DEFAULT_ANCHOR_PREFIXES: dict[str, str] = {
    "U": "ic",
    "J": "connector",
    "P": "connector",
    "Y": "crystal",
    "X": "crystal",
    "ANT": "antenna",
    "T": "transformer",
}

_SI_PREFIXES = {
    "p": 1e-12, "n": 1e-9, "u": 1e-6, "µ": 1e-6, "m": 1e-3,
    "": 1.0, "k": 1e3, "meg": 1e6, "M": 1e6, "g": 1e9,
}
_VALUE_PATTERN = re.compile(
    r"^\s*([0-9]*\.?[0-9]+)\s*([pnuµm]|meg|k|M|g)?\s*([fFhH]|(?:ohm)|Ω)?\s*$",
)


def designator_prefix(designator: str) -> str:
    match = re.match(r"^([A-Za-z]+)", designator or "")
    return match.group(1).upper() if match else ""


def normalize_value(raw: Optional[str]) -> Optional[float]:
    """Parse an engineering value string ("100nF", "0.1uF", "0.1µF", ...) into
    a normalized float in base units (F/H/Ohm), so callers can compare
    numerically instead of by string equality. Returns None if unparseable.

    EIA shorthand codes (e.g. "104" meaning 100nF) are NOT resolved here —
    explicitly deferred per the plan; a bare numeric string with no unit
    returns None rather than guessing.
    """
    if not raw:
        return None
    text = raw.strip()
    match = _VALUE_PATTERN.match(text)
    if not match:
        return None
    mantissa_text, prefix, unit = match.groups()
    if unit is None:
        return None  # e.g. a bare "104" EIA code — deliberately not resolved
    prefix = prefix or ""
    multiplier = _SI_PREFIXES.get(prefix)
    if multiplier is None:
        return None
    try:
        mantissa = float(mantissa_text)
    except ValueError:
        return None
    return mantissa * multiplier


def values_match(a: Optional[str], b: Optional[str], relative_tolerance: float = 1e-6) -> bool:
    norm_a, norm_b = normalize_value(a), normalize_value(b)
    if norm_a is None or norm_b is None:
        return (a or "").strip().lower() == (b or "").strip().lower()
    if norm_a == 0 and norm_b == 0:
        return True
    return abs(norm_a - norm_b) <= relative_tolerance * max(abs(norm_a), abs(norm_b))


def component_value(component: dict) -> Optional[str]:
    """value = component.get("value") or component.get("otherProperty", {}).get("Value")."""
    return component.get("value") or (component.get("otherProperty") or {}).get("Value")


def is_locked(component: dict) -> bool:
    return component.get("locked") is True


@dataclass
class Pad:
    id: str
    component_id: Optional[str]
    number: str
    net: str
    layer: Any
    x: float
    y: float
    rotation: float = 0.0
    locked: bool = False


def all_pads(snapshot: dict) -> list[Pad]:
    """Mirrors allPads() in src/pcb-analysis.mjs: merges components[].pads and
    top-level standalonePads into one list, each tagged with its owning
    component id (None for standalone pads)."""
    pads: list[Pad] = []
    for component in snapshot.get("components", []):
        component_id = component.get("id")
        locked = is_locked(component)
        for pad in component.get("pads", []):
            pads.append(Pad(
                id=pad["id"], component_id=component_id, number=pad.get("number", ""),
                net=pad.get("net", "") or "", layer=pad.get("layer"),
                x=float(pad["x"]), y=float(pad["y"]), rotation=float(pad.get("rotation", 0)),
                locked=locked,
            ))
    for pad in snapshot.get("standalonePads", []):
        pads.append(Pad(
            id=pad["id"], component_id=None, number=pad.get("number", ""),
            net=pad.get("net", "") or "", layer=pad.get("layer"),
            x=float(pad["x"]), y=float(pad["y"]), rotation=float(pad.get("rotation", 0)),
            locked=pad.get("locked") is True,
        ))
    return pads


def net_usage_table(pads: list[Pad]) -> dict[str, int]:
    """net name -> number of distinct component ids with a pad on that net.
    Standalone pads (component_id is None) each count as their own user."""
    users: dict[str, set] = {}
    anon_counter = 0
    for pad in pads:
        if not pad.net:
            continue
        key = pad.component_id
        if key is None:
            anon_counter += 1
            key = f"__standalone_{anon_counter}"
        users.setdefault(pad.net, set()).add(key)
    return {net: len(members) for net, members in users.items()}


def is_ground_net(net: str) -> bool:
    return (net or "").strip().lower() in GROUND_NET_NAMES


def board_polygon_from_snapshot(snapshot: dict, max_chord_error: float = 2.0) -> geo.BoardPolygon:
    outline = snapshot.get("boardOutline") or {}
    return geo.build_board_polygon(outline.get("lines", []), outline.get("arcs", []), max_chord_error)


def pours_by_net(snapshot: dict) -> set[str]:
    return {pour.get("net") for pour in snapshot.get("pours", []) if pour.get("net")}


# ---------------------------------------------------------------------------
# File I/O helpers
# ---------------------------------------------------------------------------

def load_json(path: str | Path) -> Any:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def save_json(path: str | Path, data: Any) -> None:
    Path(path).write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def load_snapshot(path: str | Path) -> dict:
    return load_json(path)


def load_schematic_components(path: str | Path) -> list[dict]:
    """Same shape projectCache.getComponents() already returns: a flat list
    with `designator`, `pageUuid`, `pageName` among other fields."""
    data = load_json(path)
    return data if isinstance(data, list) else data.get("components", [])


def load_anchors(path: str | Path) -> dict[str, dict]:
    return load_json(path)


def load_region_params(path: str | Path) -> dict[str, dict]:
    return load_json(path)


def load_rules(path: str | Path) -> list[dict]:
    return load_json(path)


def component_by_id(snapshot: dict) -> dict[str, dict]:
    return {component["id"]: component for component in snapshot.get("components", [])}


def component_by_designator(snapshot: dict) -> dict[str, dict]:
    return {component.get("designator"): component for component in snapshot.get("components", []) if component.get("designator")}
