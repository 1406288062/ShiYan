"""Quality-aware PDF extraction, visual fallback and page-safe chunking."""

from __future__ import annotations

import base64
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
import hashlib
import re
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from typing import Any, Callable

import pdfplumber

from config import (
    KNOWLEDGE_CONTEXT_MAX_CHARS,
    PDF_VISION_MAX_PAGES,
    PDF_VISION_MIN_TEXT_CHARS,
    PDF_VISION_RENDER_DPI,
    PDF_VISION_WORKERS,
)


ProgressCallback = Callable[[int, int, str], None]
VisionExtractor = Callable[[str, int, str, list[str]], dict[str, Any]]


@dataclass(frozen=True)
class PageAssessment:
    char_count: int
    image_coverage: float
    table_count: int
    multi_column: bool
    damaged_text: bool
    is_blank: bool
    requires_vision: bool
    reasons: tuple[str, ...]


@dataclass
class PdfPage:
    page_number: int
    text: str
    extraction_method: str = "text"
    quality_flags: tuple[str, ...] = ()
    image_count: int = 0
    table_count: int = 0


@dataclass
class PdfDocument:
    pages: list[PdfPage]
    total_pages: int
    text_pages: int
    vision_pages: int
    blank_pages: int
    warnings: list[str]


def _normalize(text: str) -> str:
    text = text.replace("\u00a0", " ").replace("\r", "")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _image_coverage(page: Any) -> float:
    page_area = max(float(page.width) * float(page.height), 1.0)
    covered = 0.0
    for image in getattr(page, "images", []) or []:
        try:
            width = max(0.0, min(float(image["x1"]), float(page.width)) - max(float(image["x0"]), 0.0))
            top = max(float(image.get("top", 0.0)), 0.0)
            bottom = min(float(image.get("bottom", page.height)), float(page.height))
            covered += width * max(0.0, bottom - top)
        except (KeyError, TypeError, ValueError):
            continue
    return min(1.0, covered / page_area)


def _looks_multi_column(words: list[dict[str, Any]], page_width: float) -> bool:
    if len(words) < 24 or page_width <= 0:
        return False
    lines: dict[int, list[dict[str, Any]]] = {}
    for word in words:
        try:
            line_key = round(float(word["top"]) / 4)
        except (KeyError, TypeError, ValueError):
            continue
        lines.setdefault(line_key, []).append(word)

    split_lines = 0
    useful_lines = 0
    for line_words in lines.values():
        ordered = sorted(line_words, key=lambda item: float(item.get("x0", 0)))
        if len(ordered) < 4:
            continue
        useful_lines += 1
        for left, right in zip(ordered, ordered[1:]):
            try:
                gap = float(right["x0"]) - float(left["x1"])
                left_count = sum(float(item.get("x1", 0)) <= float(left["x1"]) for item in ordered)
                right_count = len(ordered) - left_count
            except (KeyError, TypeError, ValueError):
                continue
            if gap >= page_width * 0.09 and left_count >= 2 and right_count >= 2:
                split_lines += 1
                break
    return split_lines >= 4 and split_lines / max(useful_lines, 1) >= 0.12


def assess_pdf_page(
    text: str,
    *,
    page_width: float,
    page_height: float,
    images: list[dict[str, Any]] | None = None,
    words: list[dict[str, Any]] | None = None,
    table_count: int = 0,
    drawing_count: int = 0,
    extraction_failed: bool = False,
) -> PageAssessment:
    """Classify whether local text extraction is trustworthy enough."""
    normalized = _normalize(text)
    compact = re.sub(r"\s+", "", normalized)
    char_count = len(compact)
    damaged_count = compact.count("\ufffd") + len(re.findall(r"[\ue000-\uf8ff]", compact))
    damaged_text = bool(compact) and damaged_count / len(compact) >= 0.02

    class PageShape:
        width = page_width
        height = page_height

    shape = PageShape()
    shape.images = images or []
    image_coverage = _image_coverage(shape)
    multi_column = _looks_multi_column(words or [], float(page_width))
    is_blank = char_count == 0 and not images and drawing_count == 0 and not extraction_failed

    reasons: list[str] = []
    if extraction_failed:
        reasons.append("local_error")
    if not is_blank and char_count < PDF_VISION_MIN_TEXT_CHARS:
        reasons.append("low_text")
    if image_coverage >= 0.22:
        reasons.append("image_heavy")
    if table_count:
        reasons.append("table")
    if multi_column:
        reasons.append("multi_column")
    if drawing_count and (not compact or drawing_count >= 4):
        reasons.append("vector_graphics")
    if damaged_text:
        reasons.append("damaged_text")
    return PageAssessment(
        char_count=char_count,
        image_coverage=image_coverage,
        table_count=table_count,
        multi_column=multi_column,
        damaged_text=damaged_text,
        is_blank=is_blank,
        requires_vision=bool(reasons),
        reasons=tuple(reasons),
    )


def _render_page_data_url(page: Any) -> str:
    rendered = page.to_image(resolution=PDF_VISION_RENDER_DPI, antialias=True)
    image = rendered.original.copy()
    image.thumbnail((1800, 1800))
    if image.mode != "RGB":
        image = image.convert("RGB")
    buffer = BytesIO()
    image.save(buffer, format="JPEG", quality=86, optimize=True)
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:image/jpeg;base64,{encoded}"


def extract_pdf_document(
    pdf_path: str | Path,
    vision_extractor: VisionExtractor | None = None,
    progress_callback: ProgressCallback | None = None,
) -> PdfDocument:
    """Extract every meaningful page, with bounded parallel vision calls."""
    pages_by_number: dict[int, PdfPage] = {}
    warnings: list[str] = []
    text_pages = 0
    vision_pages = 0
    blank_pages = 0

    with pdfplumber.open(str(pdf_path)) as pdf:
        total_pages = len(pdf.pages)
        inspected: list[tuple[Any, str, PageAssessment, int, int]] = []
        for number, page in enumerate(pdf.pages, start=1):
            extraction_failed = False
            try:
                text = _normalize(page.extract_text() or "")
            except Exception as exc:
                text = ""
                extraction_failed = True
                warnings.append(f"第 {number} 页本地解析异常：{type(exc).__name__}")
            try:
                words = page.extract_words() or []
            except Exception as exc:
                words = []
                warnings.append(f"第 {number} 页版面分析异常：{type(exc).__name__}")
            try:
                table_count = len(page.find_tables())
            except Exception as exc:
                table_count = 0
                warnings.append(f"第 {number} 页表格探测异常：{type(exc).__name__}")
            images = list(getattr(page, "images", []) or [])
            drawing_count = sum(
                len(getattr(page, name, []) or []) for name in ("lines", "rects", "curves")
            )
            assessment = assess_pdf_page(
                text,
                page_width=float(page.width),
                page_height=float(page.height),
                images=images,
                words=words,
                table_count=table_count,
                drawing_count=drawing_count,
                extraction_failed=extraction_failed,
            )
            inspected.append((page, text, assessment, len(images), table_count))
            if progress_callback:
                progress_callback(number, max(total_pages, 1), "inspect")

        visual_count = sum(
            assessment.requires_vision for _, _, assessment, _, _ in inspected
        )
        if visual_count > PDF_VISION_MAX_PAGES:
            raise ValueError(
                f"PDF 有 {visual_count} 页需要视觉解析，超过当前上限 {PDF_VISION_MAX_PAGES} 页"
            )
        if visual_count and vision_extractor is None:
            raise ValueError("PDF 含扫描、表格或复杂排版页面，但视觉解析服务不可用")

        visual_jobs: list[
            tuple[int, Any, str, PageAssessment, int, int]
        ] = []
        for number, (page, local_text, assessment, image_count, table_count) in enumerate(
            inspected, start=1
        ):
            if assessment.is_blank:
                blank_pages += 1
                warnings.append(f"第 {number} 页为空白页")
                continue

            if not assessment.requires_vision:
                text_pages += 1
                pages_by_number[number] = PdfPage(
                    page_number=number,
                    text=local_text,
                    extraction_method="text",
                    quality_flags=assessment.reasons,
                    image_count=image_count,
                    table_count=table_count,
                )
                continue

            visual_jobs.append(
                (number, page, local_text, assessment, image_count, table_count)
            )

        if not visual_jobs:
            if progress_callback:
                progress_callback(1, 1, "extract")
        else:
            if progress_callback:
                progress_callback(0, len(visual_jobs), "extract")
            worker_count = max(1, min(PDF_VISION_WORKERS, len(visual_jobs)))
            executor = ThreadPoolExecutor(
                max_workers=worker_count,
                thread_name_prefix="pdf-vision",
            )
            future_meta: dict[
                Any, tuple[int, str, PageAssessment, int, int]
            ] = {}
            job_iter = iter(visual_jobs)
            vision_completed = 0

            def submit_next() -> bool:
                try:
                    (
                        number,
                        page,
                        local_text,
                        assessment,
                        image_count,
                        table_count,
                    ) = next(job_iter)
                except StopIteration:
                    return False
                data_url = _render_page_data_url(page)
                future = executor.submit(
                    vision_extractor,
                    data_url,
                    number,
                    local_text[:6000],
                    list(assessment.reasons),
                )
                future_meta[future] = (
                    number,
                    local_text,
                    assessment,
                    image_count,
                    table_count,
                )
                return True

            try:
                for _ in range(worker_count):
                    if not submit_next():
                        break

                while future_meta:
                    done_futures, _ = wait(
                        tuple(future_meta),
                        return_when=FIRST_COMPLETED,
                    )
                    for future in done_futures:
                        (
                            number,
                            local_text,
                            assessment,
                            image_count,
                            table_count,
                        ) = future_meta.pop(future)
                        try:
                            visual = future.result()
                        except Exception as exc:
                            for pending in future_meta:
                                pending.cancel()
                            raise ValueError(
                                f"第 {number} 页视觉解析失败：{exc}"
                            ) from exc

                        visual_text = _normalize(str(visual.get("text") or ""))
                        if (
                            visual.get("is_blank") is True
                            and not local_text
                            and not visual_text
                        ):
                            blank_pages += 1
                            warnings.append(f"第 {number} 页经视觉确认为空白页")
                        else:
                            text = local_text
                            method = "text"
                            if not visual_text:
                                if not local_text:
                                    raise ValueError(
                                        f"第 {number} 页存在内容，但视觉模型未返回可索引文本"
                                    )
                                warnings.append(
                                    f"第 {number} 页视觉解析未返回文字，保留本地解析结果"
                                )
                                text_pages += 1
                            else:
                                text = visual_text
                                method = "vision" if not local_text else "text+vision"
                                vision_pages += 1
                            pages_by_number[number] = PdfPage(
                                page_number=number,
                                text=text,
                                extraction_method=method,
                                quality_flags=assessment.reasons,
                                image_count=image_count,
                                table_count=table_count,
                            )

                        vision_completed += 1
                        if progress_callback:
                            progress_callback(
                                vision_completed,
                                len(visual_jobs),
                                "extract",
                            )
                        submit_next()
            finally:
                executor.shutdown(wait=True, cancel_futures=True)

    pages = [pages_by_number[number] for number in sorted(pages_by_number)]
    if not pages:
        raise ValueError("PDF 未提取到可用内容，文件可能为空或损坏")
    return PdfDocument(
        pages=pages,
        total_pages=total_pages,
        text_pages=text_pages,
        vision_pages=vision_pages,
        blank_pages=blank_pages,
        warnings=warnings,
    )


def extract_pdf_pages(
    pdf_path: str | Path,
    vision_extractor: VisionExtractor | None = None,
    progress_callback: ProgressCallback | None = None,
) -> list[PdfPage]:
    """Compatibility wrapper for callers that only need extracted pages."""
    return extract_pdf_document(pdf_path, vision_extractor, progress_callback).pages


def _split_long_text(text: str, chunk_size: int) -> list[str]:
    if len(text) <= chunk_size:
        return [text]
    pieces: list[str] = []
    remaining = text
    while len(remaining) > chunk_size:
        window = remaining[:chunk_size]
        cut = max(
            window.rfind("\n"),
            window.rfind(" "),
            *(match.end() for match in re.finditer(r"[。！？!?；;，,]", window)),
        )
        if cut < chunk_size // 2:
            cut = chunk_size
        pieces.append(remaining[:cut].strip())
        remaining = remaining[cut:].strip()
    if remaining:
        pieces.append(remaining)
    return pieces


def split_pages_into_chunks(
    pages: list[PdfPage], chunk_size: int = 1200, overlap: int = 160
) -> list[dict]:
    """Return chunks with stable page provenance.

    The overlap is applied only inside a page. A hard character split ensures a
    single very long sentence cannot bypass the chunk size limit.
    """
    if chunk_size < 200:
        raise ValueError("chunk_size 不能小于 200")
    overlap = max(0, min(overlap, chunk_size // 3))
    chunks: list[dict] = []

    def append_chunk(page: PdfPage, text: str) -> None:
        clean = text.strip()
        if not clean:
            return
        chunks.append(
            {
                "text": clean,
                "page_start": page.page_number,
                "page_end": page.page_number,
                "heading": next(
                    (line.strip()[:80] for line in clean.splitlines() if line.strip()),
                    clean[:80],
                ),
                "extraction_method": page.extraction_method,
                "quality_flags": list(page.quality_flags),
            }
        )

    for page in pages:
        paragraphs = [p.strip() for p in re.split(r"\n{2,}", page.text) if p.strip()]
        if not paragraphs:
            paragraphs = [page.text]
        current = ""
        for paragraph in paragraphs:
            sentences = [
                sentence.strip()
                for sentence in re.split(r"(?<=[。！？!?；;])|(?<=[.])(?=\s+|$)", paragraph)
                if sentence.strip()
            ]
            if not sentences:
                sentences = [paragraph]
            for sentence in sentences:
                for piece in _split_long_text(sentence, chunk_size):
                    separator = "\n" if "\n" in current or "\n" in piece else " "
                    candidate = f"{current}{separator if current else ''}{piece}".strip()
                    if current and len(candidate) > chunk_size:
                        append_chunk(page, current)
                        tail = current[-overlap:] if overlap else ""
                        room_for_tail = max(0, chunk_size - len(piece) - (1 if tail else 0))
                        tail = tail[-room_for_tail:] if room_for_tail else ""
                        current = f"{tail} {piece}".strip()
                    else:
                        current = candidate
        if current:
            append_chunk(page, current)
    return chunks


def _representative_excerpt(text: str, budget: int) -> str:
    text = text.strip()
    if len(text) <= budget:
        return text
    if budget < 80:
        raise ValueError("知识地图上下文预算不足，无法覆盖全部文档片段")
    marker = "\n…\n"
    available = budget - len(marker)
    head_size = max(1, round(available * 0.62))
    return f"{text[:head_size].rstrip()}{marker}{text[-(available - head_size):].lstrip()}"


def build_knowledge_context(
    chunks: list[dict], max_chars: int = KNOWLEDGE_CONTEXT_MAX_CHARS
) -> str:
    """Build a labelled context that covers every chunk in document order."""
    if not chunks:
        return ""
    page_count = max(
        (chunk.get("page_end") or chunk.get("page_start") or 0 for chunk in chunks),
        default=0,
    )
    labels = [
        f"[片段 {index} | 第 {chunk.get('page_start') or '未知'}-"
        f"{chunk.get('page_end') or chunk.get('page_start') or '未知'} 页]"
        for index, chunk in enumerate(chunks, 1)
    ]
    header = f"[文档共 {page_count} 页、{len(chunks)} 个分块；以下内容按原顺序覆盖全部片段]"
    full_size = len(header) + sum(
        len(label) + len(str(chunk.get("text") or "")) + 4
        for label, chunk in zip(labels, chunks)
    )
    compressed = full_size > max_chars
    if compressed:
        header = (
            f"[文档共 {page_count} 页、{len(chunks)} 个分块；文档超过上下文预算，"
            "以下内容按原顺序覆盖全部片段，每个片段保留原文代表段]"
        )
    overhead = len(header) + sum(len(label) + 4 for label in labels)
    if overhead >= max_chars:
        raise ValueError("PDF 分块数量过多，无法在模型上下文内保留完整来源索引")
    per_chunk_budget = max(80, (max_chars - overhead) // len(chunks))

    blocks = [header]
    for label, chunk in zip(labels, chunks):
        text = str(chunk.get("text") or "")
        excerpt = _representative_excerpt(text, per_chunk_budget) if compressed else text
        blocks.append(f"{label}\n{excerpt}")
    context = "\n\n".join(blocks)
    if len(context) > max_chars:
        # Integer division and separators may leave a very small remainder.
        raise ValueError("知识地图上下文超过安全预算，请减小单个 PDF 的规模")
    return context


def content_hash(chunks: list[dict]) -> str:
    payload = "\n".join(
        f"{chunk.get('page_start') or ''}-{chunk.get('page_end') or ''}:"
        f"{chunk['text']}"
        for chunk in chunks
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()
