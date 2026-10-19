"""Build a content-first knowledge map from document-level structures.

The language model analyses each PDF independently. This module turns those
results into one deterministic knowledge-base view: documents become evidence,
while semantically equivalent modules and points become shared nodes.
"""

from __future__ import annotations

import hashlib
import re
import unicodedata
from collections import Counter
from difflib import SequenceMatcher
from html import escape
from typing import Any


_HTML_TAG = re.compile(r"<[^>]+>")
_LATIN_WORD = re.compile(r"[a-z0-9]+")
_HAN_RUN = re.compile(r"[\u4e00-\u9fff]+")


def _clean_text(value: Any, limit: int = 180) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()[:limit]


def _plain_text(value: Any, limit: int = 150) -> str:
    text = _HTML_TAG.sub(" ", str(value or ""))
    return _clean_text(text, limit)


def _concept_key(node: dict[str, Any]) -> str:
    raw = _clean_text(node.get("merge_key") or node.get("title"), 120)
    normalized = unicodedata.normalize("NFKC", raw).lower()
    normalized = re.sub(r"第[一二三四五六七八九十百\d]+[章节部分篇]", "", normalized)
    normalized = re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "", normalized)
    return normalized or hashlib.sha1(raw.encode("utf-8")).hexdigest()[:12]


def _concept_tokens(key: str) -> set[str]:
    tokens = set(_LATIN_WORD.findall(key))
    for run in _HAN_RUN.findall(key):
        if len(run) == 1:
            tokens.add(run)
        else:
            tokens.update(run[index : index + 2] for index in range(len(run) - 1))
    return tokens


def _concept_similarity(left: str, right: str) -> float:
    if left == right:
        return 1.0
    if min(len(left), len(right)) <= 3:
        return 0.0
    shorter, longer = sorted((left, right), key=len)
    if shorter in longer and len(shorter) / len(longer) >= 0.68:
        return 0.9
    sequence = SequenceMatcher(None, left, right).ratio()
    left_tokens, right_tokens = _concept_tokens(left), _concept_tokens(right)
    union = left_tokens | right_tokens
    token_score = len(left_tokens & right_tokens) / len(union) if union else 0.0
    return max(sequence, token_score)


def _group_entries(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    groups: list[dict[str, Any]] = []
    for entry in entries:
        key = _concept_key(entry["node"])
        best_group = None
        best_score = 0.0
        for group in groups:
            # Preserve every distinct topic/knowledge point from the same PDF.
            # Semantic fusion is only for the same concept across different
            # documents; merging two entries from one document silently hides
            # original content in the canvas.
            entry_document_id = _document_id(entry["document"])
            if any(
                _document_id(existing["document"]) == entry_document_id
                for existing in group["entries"]
            ):
                continue
            score = max(_concept_similarity(key, alias) for alias in group["aliases"])
            if score > best_score:
                best_group, best_score = group, score
        if best_group is not None and best_score >= 0.84:
            best_group["entries"].append(entry)
            best_group["aliases"].add(key)
        else:
            groups.append({"key": key, "aliases": {key}, "entries": [entry]})
    return groups


def _positive_page(value: Any) -> int | None:
    try:
        page = int(value)
    except (TypeError, ValueError):
        return None
    return page if page > 0 else None


def _node_sources(node: dict[str, Any], document: dict[str, Any]) -> list[dict[str, Any]]:
    document_id = str(document.get("id") or "")
    document_name = _clean_text(document.get("title") or document.get("filename") or "未命名文档")
    raw_sources = node.get("sources") if isinstance(node.get("sources"), list) else []
    sources = []
    for raw in raw_sources:
        if not isinstance(raw, dict):
            continue
        page_start = _positive_page(raw.get("page_start"))
        quote = _clean_text(raw.get("quote"), 240)
        page_end = _positive_page(raw.get("page_end")) or page_start
        if not page_start or not quote:
            continue
        sources.append(
            {
                "document_id": document_id,
                "document_name": document_name,
                "page_start": page_start,
                "page_end": page_end,
                "quote": quote,
            }
        )
    return sources


def _merge_sources(source_lists: list[list[dict[str, Any]]]) -> list[dict[str, Any]]:
    merged: dict[tuple[Any, ...], dict[str, Any]] = {}
    for sources in source_lists:
        for source in sources:
            key = (source.get("document_id"), source.get("page_start"), source.get("page_end"), source.get("quote"))
            current = merged.get(key)
            if current is None or (not current.get("quote") and source.get("quote")):
                merged[key] = source
    return list(merged.values())


def _representative(entries: list[dict[str, Any]]) -> dict[str, Any]:
    return max(
        entries,
        key=lambda entry: (
            len(_plain_text(entry["node"].get("content"), 2000)),
            -entry["order"],
        ),
    )["node"]


def _display_title(entries: list[dict[str, Any]]) -> str:
    titles = [_clean_text(entry["node"].get("title"), 80) for entry in entries]
    titles = [title for title in titles if title]
    if not titles:
        return "未命名主题"
    counts = Counter(titles)
    return max(titles, key=lambda title: (counts[title], -titles.index(title)))


def _stable_id(prefix: str, key: str) -> str:
    digest = hashlib.sha1(key.encode("utf-8")).hexdigest()[:14]
    return f"{prefix}_{digest}"


_RELATION_LABELS = {
    "contains": "包含",
    "sequence": "先后",
    "causes": "因果",
    "depends_on": "依赖",
    "contrasts": "对比",
    "conflicts": "冲突",
    "updates": "更新",
}
_LAYOUT_LABELS = {
    "map": "中心关系图",
    "flow": "流程图",
    "timeline": "时间线",
    "comparison": "对比视图",
}
_EXPLICIT_RELATION_TYPES = set(_RELATION_LABELS) - {"contains"}


def _document_id(document: dict[str, Any], fallback: str = "") -> str:
    return str(document.get("id") or document.get("filename") or fallback or "document")


def _document_name(document: dict[str, Any]) -> str:
    return _clean_text(document.get("title") or document.get("filename") or "未命名文档", 160)


def _comparison_signature(entries: list[dict[str, Any]]) -> str:
    parts = []
    for entry in entries:
        node = entry["node"]
        parts.append(_clean_text(node.get("title"), 100))
        parts.append(_plain_text(node.get("content"), 800))
    value = "|".join(parts)
    value = unicodedata.normalize("NFKC", value).lower()
    return re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "", value)


def _comparison_info(entries: list[dict[str, Any]]) -> dict[str, Any]:
    by_document: dict[str, list[dict[str, Any]]] = {}
    for entry in entries:
        by_document.setdefault(_document_id(entry["document"]), []).append(entry)

    variants = []
    signatures = set()
    for document_id, document_entries in by_document.items():
        representative = _representative(document_entries)
        signatures.add(_comparison_signature(document_entries))
        variants.append(
            {
                "document_id": document_id,
                "document_name": _document_name(document_entries[0]["document"]),
                "title": _display_title(document_entries),
                "summary": _plain_text(representative.get("content"), 180),
                "sources": _merge_sources([entry["sources"] for entry in document_entries]),
            }
        )
    variants.sort(key=lambda item: (item["document_name"], item["document_id"]))
    common = len(variants) > 1
    difference = common and len(signatures) > 1
    return {
        "status": "different" if difference else "common" if common else "single",
        "common": common,
        "difference": difference,
        "variants": variants,
    }


def _fused_content(entries: list[dict[str, Any]], representative: dict[str, Any]) -> str:
    """Keep the representative content first, then append distinct source content.

    The map stays compact because summaries still use the representative node;
    the complete complementary material is available when a node is opened.
    """
    base = str(representative.get("content") or "").strip()
    seen = {_plain_text(base, 800)} if base else set()
    additions = []
    for entry in sorted(entries, key=lambda item: (item["order"], _document_id(item["document"]))):
        content = str(entry["node"].get("content") or "").strip()
        plain = _plain_text(content, 800)
        if not plain or plain in seen:
            continue
        seen.add(plain)
        additions.append(
            f"<li><strong>{escape(_document_name(entry['document']))}</strong>："
            f"{escape(_plain_text(content, 500))}</li>"
        )
    if not additions:
        return base
    supplement = "<h3>其他资料补充</h3><ul>" + "".join(additions[:6]) + "</ul>"
    return base + supplement


def _register_aliases(
    aliases: dict[tuple[str, str], str],
    document: dict[str, Any],
    node: dict[str, Any],
    fused_id: str,
) -> None:
    document_id = _document_id(document)
    raw_values = [node.get("id"), node.get("title"), node.get("merge_key")]
    for raw_value in raw_values:
        value = _clean_text(raw_value, 120)
        if not value:
            continue
        aliases[(document_id, value)] = fused_id
        aliases[(document_id, _concept_key({"title": value}))] = fused_id


def _relation_source(document: dict[str, Any], relation: dict[str, Any]) -> list[dict[str, Any]]:
    return _node_sources(relation, document)


def _merge_relation(
    relations: dict[tuple[str, str, str], dict[str, Any]],
    relation_type: str,
    from_id: str,
    to_id: str,
    sources: list[dict[str, Any]],
    derived: bool = False,
) -> None:
    if not from_id or not to_id or from_id == to_id or not sources:
        return
    key = (relation_type, from_id, to_id)
    current = relations.get(key)
    if current is None:
        current = {
            "id": _stable_id("relation", ":".join(key)),
            "type": relation_type,
            "label": _RELATION_LABELS.get(relation_type, relation_type),
            "from": from_id,
            "to": to_id,
            "sources": [],
            "support_count": 0,
            "derived": derived,
        }
        relations[key] = current
    current["sources"] = _merge_sources([current["sources"], sources])
    current["support_count"] = len(
        {source.get("document_id") for source in current["sources"] if source.get("document_id")}
    )
    current["derived"] = bool(current.get("derived")) and derived


def _raw_children(node: dict[str, Any]) -> list[dict[str, Any]]:
    children = node.get("children")
    if isinstance(children, list):
        return [child for child in children if isinstance(child, dict)]
    points = node.get("level3")
    if isinstance(points, list):
        return [child for child in points if isinstance(child, dict)]
    return []


def _build_point(
    group: dict[str, Any],
    module_key: str,
    aliases: dict[tuple[str, str], str] | None = None,
) -> dict[str, Any]:
    entries = group["entries"]
    representative = _representative(entries)
    node_id = _stable_id("point", f"{module_key}:{group['key']}")
    if aliases is not None:
        for entry in entries:
            _register_aliases(aliases, entry["document"], entry["node"], node_id)

    child_entries: list[dict[str, Any]] = []
    for entry in entries:
        for child_index, child in enumerate(_raw_children(entry["node"])):
            if not _clean_text(child.get("title")):
                continue
            sources = _node_sources(child, entry["document"])
            if not sources:
                continue
            child_entries.append(
                {
                    "node": child,
                    "document": entry["document"],
                    "sources": sources,
                    "order": entry["order"] * 100 + child_index,
                }
            )

    children = [
        _build_point(child_group, f"{module_key}:{group['key']}", aliases)
        for child_group in _group_entries(child_entries)
    ]
    children.sort(key=lambda child: child.get("order", 0))
    for child in children:
        child.pop("order", None)

    direct_sources = [entry["sources"] for entry in entries]
    sources = _merge_sources(direct_sources + [child["sources"] for child in children])
    representative_content = str(representative.get("content") or "").strip()
    content = _fused_content(entries, representative)
    return {
        "id": node_id,
        "title": _display_title(entries),
        "summary": _plain_text(representative_content, 110),
        "content": content,
        "sources": sources,
        "support_count": len({source["document_id"] for source in sources if source.get("document_id")}),
        "comparison": _comparison_info(entries),
        "children": children,
        "order": min(entry["order"] for entry in entries),
        "is_navigation_group": any(bool(entry["node"].get("is_navigation_group")) for entry in entries),
        "navigation_only": any(bool(entry["node"].get("navigation_only")) for entry in entries),
    }

def _build_module(
    group: dict[str, Any],
    aliases: dict[tuple[str, str], str] | None = None,
) -> dict[str, Any]:
    entries = group["entries"]
    representative = _representative(entries)
    module_id = _stable_id("module", group["key"])
    if aliases is not None:
        for entry in entries:
            _register_aliases(aliases, entry["document"], entry["node"], module_id)

    point_entries: list[dict[str, Any]] = []
    for entry in entries:
        for point_index, point in enumerate(_raw_children(entry["node"])):
            if not _clean_text(point.get("title")):
                continue
            sources = _node_sources(point, entry["document"])
            if not sources:
                continue
            point_entries.append(
                {
                    "node": point,
                    "document": entry["document"],
                    "sources": sources,
                    "order": entry["order"] * 100 + point_index,
                }
            )

    points = [
        _build_point(point_group, group["key"], aliases)
        for point_group in _group_entries(point_entries)
    ]
    points.sort(key=lambda point: point["order"])
    for point in points:
        point.pop("order", None)
    direct_sources = [entry["sources"] for entry in entries]
    sources = _merge_sources(direct_sources + [point["sources"] for point in points])
    representative_content = str(representative.get("content") or "").strip()
    content = _fused_content(entries, representative)
    return {
        "id": module_id,
        "title": _display_title(entries),
        "summary": _plain_text(representative_content, 110),
        "content": content,
        "sources": sources,
        "support_count": len({source["document_id"] for source in sources if source.get("document_id")}),
        "comparison": _comparison_info(entries),
        "level3": points,
        "children": points,
        "order": min(entry["order"] for entry in entries),
        "is_navigation_group": any(bool(entry["node"].get("is_navigation_group")) for entry in entries),
        "navigation_only": any(bool(entry["node"].get("navigation_only")) for entry in entries),
    }


def _graph_nodes(modules: list[dict[str, Any]]) -> list[dict[str, Any]]:
    nodes: list[dict[str, Any]] = []

    def visit(node: dict[str, Any]) -> None:
        nodes.append(node)
        for child in _raw_children(node):
            visit(child)

    for module in modules:
        visit(module)
    return nodes


def _first_source_page(node: dict[str, Any]) -> int:
    pages = []
    for source in node.get("sources", []):
        if not isinstance(source, dict):
            continue
        page = _positive_page(source.get("page_start"))
        if page is not None:
            pages.append(page)
    return min(pages, default=10**9)


def _comparison_summary(
    modules: list[dict[str, Any]], relations: list[dict[str, Any]]
) -> dict[str, Any]:
    common = []
    differences = []
    for node in _graph_nodes(modules):
        comparison = node.get("comparison")
        if not isinstance(comparison, dict):
            continue
        variants = comparison.get("variants") if isinstance(comparison.get("variants"), list) else []
        if comparison.get("common"):
            common.append(
                {
                    "node_id": node["id"],
                    "title": node["title"],
                    "document_count": len(variants),
                }
            )
        if comparison.get("difference"):
            differences.append(
                {
                    "node_id": node["id"],
                    "title": node["title"],
                    "variants": variants,
                }
            )
    common.sort(key=lambda item: (-item["document_count"], item["title"]))
    differences.sort(key=lambda item: item["title"])
    return {
        "common": common,
        "differences": differences,
        "contrasts": [relation for relation in relations if relation["type"] == "contrasts"],
        "conflicts": [relation for relation in relations if relation["type"] == "conflicts"],
        "updates": [relation for relation in relations if relation["type"] == "updates"],
    }


def _choose_layout(
    documents: list[dict[str, Any]],
    relations: list[dict[str, Any]],
    comparisons: dict[str, Any],
) -> tuple[str, str]:
    votes = Counter()
    for document in documents:
        generated = document.get("_knowledge")
        recommendation = generated.get("recommended_layout") if isinstance(generated, dict) else None
        if recommendation in _LAYOUT_LABELS:
            votes[recommendation] += 1
    relation_counts = Counter(relation["type"] for relation in relations)
    flow_edges = sum(relation_counts[relation_type] for relation_type in ("sequence", "causes", "depends_on"))

    if comparisons["differences"] or comparisons["contrasts"] or comparisons["conflicts"]:
        return "comparison", "发现多份资料对同一主题有不同表述或明确冲突"
    if relation_counts["updates"] or votes["timeline"] > max(votes["map"], votes["flow"]):
        return "timeline", "发现版本、阶段或更新关系"
    if flow_edges or votes["flow"] > votes["map"]:
        return "flow", "发现步骤、因果或依赖关系"
    if votes["comparison"] > votes["map"]:
        return "comparison", "资料结构以方案或指标对比为主"
    if votes["timeline"]:
        return "timeline", "资料结构包含时间或版本演进"
    return "map", "资料以概念和主题关系为主"


def _build_clusters(
    documents: list[dict[str, Any]],
    topic_entries: list[dict[str, Any]],
    modules: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    records: dict[str, dict[str, Any]] = {}
    for document_index, document in enumerate(documents):
        document_id = _document_id(document, f"document-{document_index + 1}")
        records[document_id] = {
            "id": document_id,
            "name": _document_name(document),
            "features": set(),
            "module_ids": set(),
            "order": document_index,
        }
    for entry in topic_entries:
        document_id = _document_id(entry["document"])
        record = records.get(document_id)
        if record is not None:
            record["features"].add(_concept_key(entry["node"]))
    for module in modules:
        document_ids = {source.get("document_id") for source in module["sources"]}
        for document_id in document_ids:
            record = records.get(document_id)
            if record is not None:
                record["module_ids"].add(module["id"])

    grouped: list[dict[str, Any]] = []
    for record in records.values():
        best = None
        best_score = 0.0
        for cluster in grouped:
            shared = record["features"] & cluster["features"]
            union = record["features"] | cluster["features"]
            score = len(shared) / len(union) if union else 0.0
            if shared and (len(shared) >= 2 or score >= 0.22) and score > best_score:
                best, best_score = cluster, score
        if best is None:
            grouped.append(
                {
                    "records": [record],
                    "features": set(record["features"]),
                    "module_ids": set(record["module_ids"]),
                }
            )
        else:
            best["records"].append(record)
            best["features"].update(record["features"])
            best["module_ids"].update(record["module_ids"])

    module_titles = {module["id"]: module["title"] for module in modules}
    result = []
    for cluster_index, cluster in enumerate(grouped):
        cluster_records = sorted(cluster["records"], key=lambda item: item["order"])
        document_names = [record["name"] for record in cluster_records]
        candidate_titles = [module_titles[module_id] for module_id in cluster["module_ids"] if module_id in module_titles]
        anchor = Counter(candidate_titles).most_common(1)
        if len(cluster_records) == 1:
            cluster_title = document_names[0]
        elif anchor:
            cluster_title = f"围绕「{anchor[0][0]}」的资料"
        else:
            cluster_title = f"资料组 {cluster_index + 1}"
        result.append(
            {
                "id": _stable_id("cluster", "|".join(record["id"] for record in cluster_records)),
                "title": _clean_text(cluster_title, 100),
                "summary": f"{len(cluster_records)} 份资料 · {len(cluster['module_ids'])} 个主题",
                "document_count": len(cluster_records),
                "document_ids": [record["id"] for record in cluster_records],
                "document_names": document_names,
                "module_ids": [module["id"] for module in modules if module["id"] in cluster["module_ids"]],
                "preview": "、".join(document_names[:3]),
            }
        )
    return result


def build_knowledge_graph(kb: dict[str, Any], documents: list[dict[str, Any]]) -> dict[str, Any]:
    """Return a fused, evidence-backed view of the completed documents."""
    topic_entries: list[dict[str, Any]] = []
    root_candidates: list[dict[str, Any]] = []
    aliases: dict[tuple[str, str], str] = {}

    for document_index, document in enumerate(documents):
        document_id = _document_id(document, f"document-{document_index + 1}")
        aliases[(document_id, "root")] = "root"
        generated = document.get("_knowledge")
        structure = generated.get("structure") if isinstance(generated, dict) else None
        root = structure.get("level1") if isinstance(structure, dict) else None
        if isinstance(root, dict):
            root_candidates.append(root)
            topics = root.get("children") if isinstance(root.get("children"), list) else root.get("level2")
            topics = topics if isinstance(topics, list) else []
        else:
            topics = []

        for topic_index, topic in enumerate(topics):
            if not isinstance(topic, dict) or not _clean_text(topic.get("title")):
                continue
            sources = _node_sources(topic, document)
            if not sources:
                continue
            topic_entries.append(
                {
                    "node": topic,
                    "document": document,
                    "sources": sources,
                    "order": document_index * 100 + topic_index,
                }
            )

    topic_groups = _group_entries(topic_entries)
    modules = [_build_module(group, aliases) for group in topic_groups]
    multiple_documents = len(documents) > 1
    if multiple_documents:
        modules.sort(key=lambda module: (-module["support_count"], _first_source_page(module), module["order"]))
    else:
        # The model can return topics in salience order. The canvas should keep
        # a single document in the document's reading order instead.
        modules.sort(key=lambda module: (_first_source_page(module), module["order"]))
    for module in modules:
        module.pop("order", None)

    relation_map: dict[tuple[str, str, str], dict[str, Any]] = {}
    for document_index, document in enumerate(documents):
        document_id = _document_id(document, f"document-{document_index + 1}")
        generated = document.get("_knowledge")
        raw_relations = generated.get("relations") if isinstance(generated, dict) else []
        if not isinstance(raw_relations, list):
            continue
        for raw_relation in raw_relations:
            if not isinstance(raw_relation, dict):
                continue
            relation_type = str(raw_relation.get("type") or "").strip().lower()
            if relation_type not in _EXPLICIT_RELATION_TYPES:
                continue
            from_alias = _clean_text(raw_relation.get("from"), 120)
            to_alias = _clean_text(raw_relation.get("to"), 120)
            from_id = aliases.get((document_id, from_alias)) or aliases.get((document_id, _concept_key({"title": from_alias})))
            to_id = aliases.get((document_id, to_alias)) or aliases.get((document_id, _concept_key({"title": to_alias})))
            _merge_relation(
                relation_map,
                relation_type,
                from_id or "",
                to_id or "",
                _relation_source(document, raw_relation),
            )

    def add_contains(parent_id: str, node: dict[str, Any]) -> None:
        _merge_relation(relation_map, "contains", parent_id, node["id"], node["sources"], derived=True)
        for child in _raw_children(node):
            add_contains(node["id"], child)

    for module in modules:
        add_contains("root", module)
    relations = sorted(
        relation_map.values(),
        key=lambda relation: (relation["derived"], relation["type"], relation["from"], relation["to"]),
    )
    comparisons = _comparison_summary(modules, relations)
    view_mode, view_reason = _choose_layout(documents, relations, comparisons)
    clusters = _build_clusters(documents, topic_entries, modules) if len(documents) >= 6 or (len(documents) > 1 and len(modules) > 12) else []

    root_title = _clean_text(kb.get("name"), 100) or "知识地图"
    root_content = ""
    if len(documents) == 1 and root_candidates:
        root_title = _clean_text(root_candidates[0].get("title"), 100) or root_title
        root_content = str(root_candidates[0].get("content") or "").strip()
    elif kb.get("description"):
        root_content = f"<p>{escape(_clean_text(kb['description'], 300))}</p>"

    return {
        "title": root_title,
        "knowledge_base_id": kb.get("id"),
        "document_count": len(documents),
        "module_count": len(modules),
        "relation_count": len(relations),
        "view_mode": view_mode,
        "view_mode_label": _LAYOUT_LABELS[view_mode],
        "view_reason": view_reason,
        "relation_labels": _RELATION_LABELS,
        "comparisons": comparisons,
        "clusters": clusters,
        "cluster_mode": bool(clusters),
        "relations": relations,
        "structure": {
            "level1": {
                "id": "root",
                "title": root_title,
                "content": root_content,
                "level2": modules,
                "children": modules,
            }
        },
    }
