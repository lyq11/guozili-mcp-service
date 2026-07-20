#!/usr/bin/env python3
"""下载并整理立创 EDA 专业版扩展 API 文档。

脚本从官方 sitemap 找到全部 reference 页面，缓存原始 HTML，再分别生成适合 AI
检索和适合人类阅读的 Markdown。网络下载刻意使用 curl，因为它在桌面环境中比
Python HTTP 库更稳定地继承系统代理配置。
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import html
import json
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from collections import Counter, defaultdict
from pathlib import Path
from urllib.parse import urljoin, urlparse
from xml.etree import ElementTree

from bs4 import BeautifulSoup, NavigableString, Tag


# 官方文档入口及只允许收录的 API reference 路径前缀。
BASE_URL = "https://prodocs.lceda.cn"
SITEMAP_URL = f"{BASE_URL}/sitemap.xml"
REFERENCE_PREFIX = f"{BASE_URL}/cn/api/reference/"

# URL slug 前缀到中文模块名的映射；用于给大量 API 页面分类。
MODULES = {
    "system": ("系统", ("sys", "esys", "isys", "tsys")),
    "document-tree": ("文档树", ("dmt", "edmt", "idmt", "tdmt")),
    "schematic": ("原理图与符号", ("sch", "esch", "isch", "tsch")),
    "pcb": ("PCB 与封装", ("pcb", "epcb", "ipcb", "tpcb")),
    "panel": ("面板", ("pnl", "epnl", "ipnl", "tpnl")),
    "library": ("综合库", ("lib", "elib", "ilib", "tlib")),
    "root": ("根接口", ("eda",)),
}


def run(args: list[str], cwd: Path | None = None) -> None:
    """运行外部命令，失败时直接抛出异常并终止当前构建。"""
    subprocess.run(args, cwd=cwd, check=True)


def curl_download(url: str, output: Path) -> None:
    """用带重试和超时的 curl 下载单个文件。"""
    output.parent.mkdir(parents=True, exist_ok=True)
    run([
        "curl.exe", "-L", "--fail", "--silent", "--show-error",
        "--retry", "4", "--retry-all-errors", "--connect-timeout", "20",
        "--max-time", "120", "-o", str(output), url,
    ])


def read_sitemap(path: Path) -> list[dict[str, str]]:
    """解析 sitemap，只保留官方 API reference 页面并按 URL 排序。"""
    root = ElementTree.parse(path).getroot()
    ns = {"s": "http://www.sitemaps.org/schemas/sitemap/0.9"}
    records: list[dict[str, str]] = []
    for item in root.findall("s:url", ns):
        loc = item.findtext("s:loc", default="", namespaces=ns)
        if loc.startswith(REFERENCE_PREFIX):
            records.append({
                "url": loc,
                "lastmod": item.findtext("s:lastmod", default="", namespaces=ns),
            })
    records.sort(key=lambda x: x["url"])
    return records


def write_curl_config(records: list[dict[str, str]], cache: Path, config: Path) -> list[dict[str, str]]:
    """为 curl 并行下载生成 URL/输出文件对，同时给页面分配稳定缓存文件名。"""
    indexed: list[dict[str, str]] = []
    lines: list[str] = []
    for index, record in enumerate(records, 1):
        filename = record.get("file", f"{index:04d}.html")
        indexed_record = {**record, "file": filename}
        indexed.append(indexed_record)
        lines.extend([
            f'url = "{record["url"]}"',
            f'output = "{(cache / filename).as_posix()}"',
        ])
    config.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return indexed


def download_pages(records: list[dict[str, str]], cache: Path, jobs: int) -> None:
    """并行下载尚未缓存的页面；已存在文件不会重复请求。"""
    missing = [record for record in records if not (cache / record["file"]).exists()]
    if not missing:
        return
    config = cache.parent / "curl-pages.conf"
    write_curl_config(missing, cache, config)
    run([
        "curl.exe", "--parallel", "--parallel-max", str(jobs),
        "--fail", "--silent", "--show-error", "--retry", "4",
        "--retry-all-errors", "--connect-timeout", "20", "--max-time", "120",
        "--config", str(config),
    ])


def clean_inline(text: str) -> str:
    """压缩行内空白，同时保留换行结构交给 Markdown 规范化阶段处理。"""
    return re.sub(r"[ \t\r\f\v]+", " ", text).strip()


class MarkdownRenderer:
    """针对 VitePress API 页面结构实现的轻量 HTML→Markdown 渲染器。"""

    def __init__(self, base_url: str = "") -> None:
        """保存页面基准 URL，供相对链接转换为绝对链接。"""
        self.base_url = base_url

    def render(self, node: Tag | NavigableString, inline: bool = False) -> str:
        """递归渲染单个 DOM 节点，并过滤脚本、样式、按钮和锚点装饰。"""
        if isinstance(node, NavigableString):
            return str(node)
        if not isinstance(node, Tag):
            return ""
        name = node.name.lower()
        if "header-anchor" in (node.get("class") or []):
            return ""
        if name in {"button", "script", "style", "svg"}:
            return ""
        if name == "br":
            return "\n"
        if name in {"h1", "h2", "h3", "h4", "h5", "h6"}:
            body = clean_inline(self.children(node, True))
            return f"\n{'#' * int(name[1])} {body}\n\n"
        if name == "p":
            body = clean_inline(self.children(node, True))
            return (body + (" " if inline else "\n\n")) if body else ""
        if name == "pre":
            code = node.get_text("", strip=False).strip("\n")
            lang = "typescript"
            parent_classes = " ".join(node.parent.get("class", [])) if isinstance(node.parent, Tag) else ""
            match = re.search(r"language-([\w+-]+)", parent_classes)
            if match:
                lang = match.group(1)
            fence = "```" if "```" not in code else "````"
            return f"\n{fence}{lang}\n{code}\n{fence}\n\n"
        if name == "code":
            if node.find_parent("pre"):
                return node.get_text("", strip=False)
            value = clean_inline(node.get_text(" ", strip=True))
            tick = "``" if "`" in value else "`"
            return f"{tick}{value}{tick}"
        if name in {"strong", "b"}:
            return f"**{clean_inline(self.children(node, True))}**"
        if name in {"em", "i"}:
            return f"*{clean_inline(self.children(node, True))}*"
        if name == "a":
            label = clean_inline(self.children(node, True))
            href = node.get("href", "")
            if not label:
                return ""
            if href and not href.startswith("#"):
                href = urljoin(self.base_url, href)
            return f"[{label}]({href})" if href else label
        if name == "table":
            return self.table(node)
        if name in {"ul", "ol"}:
            return self.list_block(node, ordered=name == "ol")
        if name == "li":
            return clean_inline(self.children(node, True))
        if name == "blockquote":
            value = self.children(node).strip()
            return "\n" + "\n".join(f"> {line}" for line in value.splitlines()) + "\n\n"
        if name == "hr":
            return "\n---\n\n"
        classes = node.get("class") or []
        if "line-numbers-wrapper" in classes or "lang" in classes:
            return ""
        return self.children(node, inline)

    def children(self, node: Tag, inline: bool = False) -> str:
        """按原顺序拼接节点的全部直接子节点。"""
        return "".join(self.render(child, inline) for child in node.children)

    def table(self, node: Tag) -> str:
        """把 HTML 表格转换为 GitHub 风格 Markdown 表格。"""
        rows: list[list[str]] = []
        for tr in node.find_all("tr"):
            cells = [clean_inline(self.children(cell, True)).replace("|", "\\|") for cell in tr.find_all(["th", "td"], recursive=False)]
            if cells:
                rows.append(cells)
        if not rows:
            return ""
        width = max(len(row) for row in rows)
        rows = [row + [""] * (width - len(row)) for row in rows]
        output = ["| " + " | ".join(rows[0]) + " |", "| " + " | ".join(["---"] * width) + " |"]
        output.extend("| " + " | ".join(row) + " |" for row in rows[1:])
        return "\n" + "\n".join(output) + "\n\n"

    def list_block(self, node: Tag, ordered: bool) -> str:
        """渲染有序或无序列表，并保持每个列表项的多行内容可读。"""
        lines = []
        for idx, item in enumerate(node.find_all("li", recursive=False), 1):
            prefix = f"{idx}." if ordered else "-"
            lines.append(f"{prefix} {clean_inline(self.children(item, True))}")
        return "\n" + "\n".join(lines) + "\n\n"


def normalize_markdown(value: str) -> str:
    """清理行尾空格和过量空行，输出稳定、便于版本比较的 Markdown。"""
    value = value.replace("\u200b", "")
    value = re.sub(r"\n[ \t]+\n", "\n\n", value)
    value = re.sub(r"\n{3,}", "\n\n", value)
    value = re.sub(r"[ \t]+\n", "\n", value)
    return value.strip()


def module_for(slug: str) -> tuple[str, str]:
    """根据页面 slug 推断模块键和中文模块名。"""
    normalized = slug.lower()
    # EDA exposes module objects as properties such as EDA.PCB_Document.
    if normalized.startswith("eda."):
        normalized = normalized.split(".", 1)[1]
    token = normalized.split(".", 1)[0].split("_", 1)[0]
    if token == "lc":
        return "root", "根接口"
    for key, (label, prefixes) in MODULES.items():
        if token in prefixes:
            return key, label
    return "other", "其他"


def kind_for(title: str, slug: str) -> str:
    """根据标题与 slug 粗分接口、类型、枚举等 API 条目类别。"""
    lowered = title.lower()
    candidates = [
        ("method", "方法"), ("property", "属性"), ("class", "类"),
        ("interface", "接口"), ("enumeration", "枚举"), ("enum", "枚举"),
        ("type", "类型"), ("function", "函数"), ("variable", "变量"),
        ("constructor", "构造函数"),
    ]
    for needle, label in candidates:
        if needle in lowered:
            return label
    depth = slug.count(".")
    return "成员" if depth >= 2 else "定义"


def parse_page(record: dict[str, str], path: Path) -> dict[str, object]:
    """解析单个缓存 HTML，提取标题、正文、模块、类别和稳定标识。"""
    raw = path.read_text(encoding="utf-8", errors="replace")
    soup = BeautifulSoup(raw, "lxml")
    article = soup.select_one("main .vp-doc > div") or soup.select_one("main .vp-doc") or soup.select_one("main")
    if article is None:
        raise ValueError("main API content not found")
    h1 = article.find("h1")
    title = clean_inline(h1.get_text(" ", strip=True).replace("\u200b", "")) if h1 else "Untitled"
    first_p = article.find("p")
    breadcrumb = []
    if first_p:
        breadcrumb = [clean_inline(a.get_text(" ", strip=True)) for a in first_p.find_all("a")]
        if breadcrumb and breadcrumb[0].lower() == "home":
            first_p.decompose()
            breadcrumb = breadcrumb[1:]
    renderer = MarkdownRenderer(str(record["url"]))
    content = normalize_markdown(renderer.children(article))
    if content.startswith("# "):
        content = content.split("\n", 1)[1].lstrip() if "\n" in content else ""
    filename = urlparse(record["url"]).path.rsplit("/", 1)[-1]
    slug = filename.removeprefix("pro-api.").removesuffix(".html")
    is_index = filename == "pro-api.html"
    if is_index:
        slug = "index"
    module_key, module_label = ("root", "根接口") if is_index else module_for(slug)
    return {
        **record,
        "slug": slug,
        "title": title,
        "module": module_key,
        "module_label": module_label,
        "kind": kind_for(title, slug),
        "breadcrumb": breadcrumb,
        "content": content,
        "sha256": hashlib.sha256(raw.encode("utf-8")).hexdigest(),
        "bytes": len(raw.encode("utf-8")),
    }


def human_anchor(value: str) -> str:
    """生成适合人类版目录跳转的稳定锚点。"""
    # GitHub-style Markdown renderers retain CJK characters in heading anchors.
    return re.sub(r"[^\w\u4e00-\u9fff-]+", "-", value.lower()).strip("-")


def build_ai_doc(entries: list[dict[str, object]], generated: str) -> str:
    """生成信息密度高、字段稳定、适合模型分块检索的 AI 版文档。"""
    counts = Counter(str(item["module_label"]) for item in entries)
    lines = [
        "# 嘉立创 EDA 专业版扩展 API：AI 优化全集",
        "",
        f"> 抓取时间：{generated}；来源：[官方 API 参考](https://prodocs.lceda.cn/cn/api/reference/pro-api.html)；条目总数：{len(entries)}。",
        "> 本文按固定字段组织，每个 `<api>` 块都是一个独立检索单元。正文保留官方签名、参数、返回值、示例和说明。",
        "",
        "## 数据约定",
        "",
        "- `id`：由官方 URL 派生的稳定标识。",
        "- `module`：功能模块。",
        "- `kind`：类、接口、枚举、方法、属性等。",
        "- `source`：官方原始页面。",
        "- `updated`：站点地图中的官方最后更新时间。",
        "- 同名条目应结合 `parent` 和 `source` 判别。",
        "",
        "## 覆盖范围",
        "",
    ]
    lines.extend(f"- {module}: {count}" for module, count in sorted(counts.items()))
    lines.extend(["", "## API 条目", ""])
    for item in entries:
        parent = " > ".join(item["breadcrumb"]) or "-"
        lines.extend([
            "<api>",
            f"id: {item['slug']}",
            f"title: {item['title']}",
            f"module: {item['module_label']}",
            f"kind: {item['kind']}",
            f"parent: {parent}",
            f"source: {item['url']}",
            f"updated: {item['lastmod'] or '-'}",
            "content:",
            str(item["content"]).strip(),
            "</api>",
            "",
        ])
    return "\n".join(lines).rstrip() + "\n"


def demote_headings(value: str, levels: int = 2) -> str:
    """整体降低正文标题层级，避免嵌入汇总文档后破坏目录结构。"""
    """Demote Markdown headings while leaving fenced code blocks untouched."""
    output: list[str] = []
    fence: str | None = None
    for line in value.splitlines():
        fence_match = re.match(r"^(`{3,}|~{3,})", line)
        if fence_match:
            marker = fence_match.group(1)
            if fence is None:
                fence = marker[0]
            elif marker[0] == fence:
                fence = None
            output.append(line)
            continue
        match = re.match(r"^(#{1,6})(\s+.*)$", line)
        if fence is None and match:
            line = "#" * min(6, len(match.group(1)) + levels) + match.group(2)
        output.append(line)
    return "\n".join(output)


def build_human_doc(entries: list[dict[str, object]], generated: str) -> str:
    """按模块组织目录和说明，生成人类浏览友好的 API 文档。"""
    grouped: dict[str, list[dict[str, object]]] = defaultdict(list)
    for item in entries:
        grouped[str(item["module_label"])].append(item)
    module_order = [value[0] for value in MODULES.values()] + ["其他"]
    lines = [
        "# 嘉立创 EDA 专业版扩展 API 完整参考",
        "",
        f"> 整理时间：{generated}  ",
        f"> 官方来源：[扩展 API 参考](https://prodocs.lceda.cn/cn/api/reference/pro-api.html)  ",
        f"> 完整收录：**{len(entries)} 个官方参考页面**",
        "",
        "本文是便于人类浏览的离线合订本。内容按功能模块分组，每个条目都保留原始页面链接；可用编辑器的全文搜索直接查找类名、方法名或参数名。",
        "",
        "## 快速导航",
        "",
    ]
    for module in module_order:
        if grouped.get(module):
            lines.append(f"- [{module}（{len(grouped[module])}）](#{human_anchor(module)})")
    lines.extend([
        "",
        "## 阅读提示",
        "",
        "- 扩展代码通常从全局 `eda` 对象进入具体模块。",
        "- 方法条目优先查看“签名、参数名、返回值”；类或接口条目用于理解可用成员与数据结构。",
        "- 页面描述与类型签名以抓取时的官方文档为准，实际运行能力还受客户端版本和接口稳定性影响。",
        "",
    ])
    for module in module_order:
        items = grouped.get(module, [])
        if not items:
            continue
        lines.extend([f"## {module}", "", f"本模块共 {len(items)} 个参考页面。", ""])
        by_kind = Counter(str(item["kind"]) for item in items)
        lines.append("类型分布：" + "、".join(f"{kind} {count}" for kind, count in sorted(by_kind.items())) + "。")
        lines.append("")
        for item in items:
            source = str(item["url"])
            path = " › ".join(item["breadcrumb"])
            lines.extend([
                f"### {item['title']}",
                "",
                f"**分类：** {item['kind']}  ",
                f"**路径：** {path or item['slug']}  ",
                f"**官方页面：** [{source}]({source})  ",
                f"**官方更新：** {item['lastmod'] or '未标注'}",
                "",
                demote_headings(str(item["content"]).strip()),
                "",
                "---",
                "",
            ])
    return "\n".join(lines).rstrip() + "\n"


def main() -> int:
    """解析命令行参数，完成下载、解析、归档和两种 Markdown 输出。"""
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=Path("docs"))
    parser.add_argument("--cache", type=Path, default=Path(".cache/lceda-api"))
    parser.add_argument("--jobs", type=int, default=12)
    args = parser.parse_args()
    output = args.output.resolve()
    cache = args.cache.resolve()
    output.mkdir(parents=True, exist_ok=True)
    cache.mkdir(parents=True, exist_ok=True)

    sitemap = cache / "sitemap.xml"
    print("Downloading sitemap...", flush=True)
    curl_download(SITEMAP_URL, sitemap)
    base_records = read_sitemap(sitemap)
    if len(base_records) < 2000:
        raise RuntimeError(f"Unexpectedly few API pages in sitemap: {len(base_records)}")
    records = [{**record, "file": f"{index:04d}.html"} for index, record in enumerate(base_records, 1)]
    print(f"Downloading {len(records)} API pages with {args.jobs} workers...", flush=True)
    download_pages(records, cache, args.jobs)

    print("Parsing and validating pages...", flush=True)
    entries: list[dict[str, object]] = []
    errors: list[str] = []
    for index, record in enumerate(records, 1):
        path = cache / record["file"]
        try:
            if not path.exists() or path.stat().st_size < 1000:
                raise ValueError("missing or unexpectedly small file")
            entries.append(parse_page(record, path))
        except Exception as exc:  # report all failures together
            errors.append(f"{record['url']}: {exc}")
        if index % 250 == 0:
            print(f"  parsed {index}/{len(records)}", flush=True)
    if errors:
        raise RuntimeError("Page validation failed:\n" + "\n".join(errors[:50]))

    generated = dt.datetime.now().astimezone().isoformat(timespec="seconds")
    ai_path = output / "LCEDA_PRO_API_AI.md"
    human_path = output / "LCEDA_PRO_API_HUMAN.md"
    manifest_path = output / "LCEDA_PRO_API_MANIFEST.json"
    ai_path.write_text(build_ai_doc(entries, generated), encoding="utf-8", newline="\n")
    human_path.write_text(build_human_doc(entries, generated), encoding="utf-8", newline="\n")

    manifest = {
        "source": f"{REFERENCE_PREFIX}pro-api.html",
        "sitemap": SITEMAP_URL,
        "generated_at": generated,
        "entry_count": len(entries),
        "module_counts": dict(sorted(Counter(str(e["module_label"]) for e in entries).items())),
        "kind_counts": dict(sorted(Counter(str(e["kind"]) for e in entries).items())),
        "entries": [{k: e[k] for k in ("slug", "title", "module_label", "kind", "url", "lastmod", "file", "sha256", "bytes")} for e in entries],
    }
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    archive = output / "LCEDA_PRO_API_RAW_HTML.zip"
    print("Creating raw HTML archive...", flush=True)
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        zf.write(manifest_path, "manifest.json")
        zf.write(sitemap, "sitemap.xml")
        for record in records:
            zf.write(cache / record["file"], f"pages/{record['file']}")

    summary = {
        "entries": len(entries),
        "ai_bytes": ai_path.stat().st_size,
        "human_bytes": human_path.stat().st_size,
        "archive_bytes": archive.stat().st_size,
        "outputs": [str(ai_path), str(human_path), str(manifest_path), str(archive)],
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    # 仅直接运行脚本时执行构建；被其它 Python 模块导入时不会产生文件。
    raise SystemExit(main())
