"""One-shot local Qwen embedding worker.

This process owns PyTorch/MPS allocations so macOS can reclaim Metal memory
completely when the embedding request finishes.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path


def emit(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), flush=True)


def resolve_device(torch, configured: str) -> str:
    if configured not in {"auto", "cpu", "mps"}:
        raise ValueError("LOCAL_EMBEDDING_DEVICE 必须是 auto、mps 或 cpu")
    mps_available = bool(
        getattr(getattr(torch.backends, "mps", None), "is_available", lambda: False)()
    )
    if configured == "mps" and not mps_available:
        raise RuntimeError("当前 PyTorch 不支持 Apple MPS")
    return ("mps" if mps_available else "cpu") if configured == "auto" else configured


def last_token_pool(torch, hidden, attention_mask):
    left_padding = bool((attention_mask[:, -1].sum() == attention_mask.shape[0]).item())
    if left_padding:
        return hidden[:, -1]
    sequence_lengths = attention_mask.sum(dim=1) - 1
    batch_indices = torch.arange(hidden.shape[0], device=hidden.device)
    return hidden[batch_indices, sequence_lengths]


def main() -> int:
    started = time.perf_counter()
    try:
        request = json.load(sys.stdin)
        texts = [str(item) for item in request.get("texts") or []]
        if not texts:
            raise ValueError("待向量化文本不能为空")

        model_path = Path(str(request["model_path"]))
        operation = str(request.get("operation") or "document_embedding")
        batch_size = max(1, int(request.get("batch_size") or 4))
        max_length = max(128, int(request.get("max_length") or 8192))
        query_instruction = str(request.get("query_instruction") or "")
        configured_device = str(request.get("device") or "auto").lower()

        import torch
        import torch.nn.functional as F
        from transformers import AutoModel, AutoTokenizer

        device = resolve_device(torch, configured_device)
        dtype = torch.float16 if device == "mps" else torch.float32
        tokenizer = AutoTokenizer.from_pretrained(
            str(model_path), local_files_only=True, padding_side="left"
        )
        model = AutoModel.from_pretrained(
            str(model_path), local_files_only=True, torch_dtype=dtype
        )
        model.to(device)
        model.eval()

        is_query = operation == "question_embedding"
        input_texts = [
            f"Instruct: {query_instruction}\nQuery:{text}" if is_query else text
            for text in texts
        ]
        embeddings: list[list[float]] = []
        for start in range(0, len(input_texts), batch_size):
            batch = input_texts[start : start + batch_size]
            tokenized = tokenizer(
                batch,
                padding=True,
                truncation=True,
                max_length=max_length,
                return_tensors="pt",
            )
            tokenized = {key: value.to(device) for key, value in tokenized.items()}
            with torch.inference_mode():
                outputs = model(**tokenized)
                pooled = last_token_pool(
                    torch, outputs.last_hidden_state, tokenized["attention_mask"]
                )
                normalized = F.normalize(pooled, p=2, dim=1)
            embeddings.extend(normalized.detach().float().cpu().tolist())
            done = min(start + len(batch), len(input_texts))
            emit({"type": "progress", "done": done, "total": len(input_texts)})

        emit(
            {
                "type": "result",
                "embeddings": embeddings,
                "device": device,
                "dimensions": len(embeddings[0]) if embeddings else 0,
                "elapsed_ms": round((time.perf_counter() - started) * 1000),
            }
        )
        return 0
    except Exception as exc:
        emit({"type": "error", "error": f"{type(exc).__name__}: {exc}"})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
