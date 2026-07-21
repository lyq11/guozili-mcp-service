"""离线 PCB 布局原型的加载器和共享数据模型。

直接兼容当前(未精简过的)`pcb_inspect` 快照格式——同时支持
`otherProperty.Value`(现在的形状)和以后可能出现的顶层 `value` 字段,
所以以后 MCP 服务端把序列化精简了也不用改这里。
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
    """只应该在脚本的 `if __name__ == "__main__":` 里调用——绝不能在
    模块导入时调用,不然别人只是 import 这个模块(比如跑测试)也会
    把进程的全局 stdout/stderr 改掉,产生副作用。stderr 也一起包一下,
    因为 place.py 的 --debug 中文诊断信息是打到 stderr 的,Windows
    控制台默认编码(GBK)不包一下会直接乱码。"""
    if hasattr(sys.stdout, "buffer"):
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "buffer"):
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

GROUND_NET_NAMES = {"gnd", "agnd", "dgnd", "pgnd"}

# 位号前缀 -> 默认锚点角色,给 anchors.py 用来提议候选锚点。
# 这不是穷举也不是权威判断——按计划,AI/人工应该review并编辑生成的
# anchors.template.json。
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
    """从位号里提取字母前缀,比如 "U12" -> "U"、"C4" -> "C"。"""
    match = re.match(r"^([A-Za-z]+)", designator or "")
    return match.group(1).upper() if match else ""


def normalize_value(raw: Optional[str]) -> Optional[float]:
    """把工程计数法的数值字符串("100nF"、"0.1uF"、"0.1µF" 等)解析成
    基本单位(F/H/Ω)下的归一化浮点数,这样调用方可以直接比大小,而不是
    比字符串是否完全相等。解析不出来就返回 None。

    EIA 简写代码(比如 "104" 表示 100nF)这里**不做**解析——按计划明确
    推迟到以后;裸数字字符串(没带单位)直接返回 None,不去猜。
    """
    if not raw:
        return None
    text = raw.strip()
    match = _VALUE_PATTERN.match(text)
    if not match:
        return None
    mantissa_text, prefix, unit = match.groups()
    if unit is None:
        return None  # 比如裸的 "104" 这种 EIA 代码——故意不解析
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
    """比较两个数值字符串是否表示同一个值(先按工程单位归一化再比较,归一化失败则退回字符串比较)。"""
    norm_a, norm_b = normalize_value(a), normalize_value(b)
    if norm_a is None or norm_b is None:
        return (a or "").strip().lower() == (b or "").strip().lower()
    if norm_a == 0 and norm_b == 0:
        return True
    return abs(norm_a - norm_b) <= relative_tolerance * max(abs(norm_a), abs(norm_b))


def component_value(component: dict) -> Optional[str]:
    """value = component.get("value") or component.get("otherProperty", {}).get("Value")。"""
    return component.get("value") or (component.get("otherProperty") or {}).get("Value")


def is_locked(component: dict) -> bool:
    """判断器件是否被锁定。"""
    return component.get("locked") is True


@dataclass
class Pad:
    """精简后的焊盘数据结构。"""
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
    """跟 src/pcb-analysis.mjs 里的 allPads() 逻辑一致:把 components[].pads
    和顶层的 standalonePads 合并成一个列表,每个焊盘都标上它所属的器件 id
    (独立焊盘则是 None)。"""
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
    """网络名 -> 挂在这个网络上的不同器件数量。独立焊盘(component_id
    是 None)各自算一个独立的使用者。"""
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
    """判断是否是接地类网络(GND/AGND/DGND/PGND,大小写不敏感)。"""
    return (net or "").strip().lower() in GROUND_NET_NAMES


def board_polygon_from_snapshot(snapshot: dict, max_chord_error: float = 2.0) -> geo.BoardPolygon:
    """从快照里的板框图元(直线+圆弧)构建板框多边形。"""
    outline = snapshot.get("boardOutline") or {}
    return geo.build_board_polygon(outline.get("lines", []), outline.get("arcs", []), max_chord_error)


def pours_by_net(snapshot: dict) -> set[str]:
    """已经有铺铜的网络名集合。"""
    return {pour.get("net") for pour in snapshot.get("pours", []) if pour.get("net")}


# ---------------------------------------------------------------------------
# 文件读写辅助函数
# ---------------------------------------------------------------------------

def load_json(path: str | Path) -> Any:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def save_json(path: str | Path, data: Any) -> None:
    Path(path).write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def load_snapshot(path: str | Path) -> dict:
    return load_json(path)


def load_schematic_components(path: str | Path) -> list[dict]:
    """跟 projectCache.getComponents() 已经返回的格式一样:一个扁平列表,
    每项带 `designator`、`pageUuid`、`pageName` 等字段。"""
    data = load_json(path)
    return data if isinstance(data, list) else data.get("components", [])


def load_anchors(path: str | Path) -> dict[str, dict]:
    return load_json(path)


def load_region_params(path: str | Path) -> dict[str, dict]:
    return load_json(path)


def load_rules(path: str | Path) -> list[dict]:
    return load_json(path)


def component_by_id(snapshot: dict) -> dict[str, dict]:
    """按 id 索引器件。"""
    return {component["id"]: component for component in snapshot.get("components", [])}


def component_by_designator(snapshot: dict) -> dict[str, dict]:
    """按位号索引器件。"""
    return {component.get("designator"): component for component in snapshot.get("components", []) if component.get("designator")}
