"""Chroma vector index with local Qwen embeddings and a manual Doubao fallback."""

from __future__ import annotations

import gc
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Callable

import chromadb
import requests

from config import (
    CHROMA_DIR,
    DOUBAO_EM_API_KEY,
    DOUBAO_EM_BASE_URL,
    DOUBAO_EM_MODEL,
    EMBEDDING_PROVIDER,
    LOCAL_EMBEDDING_BATCH_SIZE,
    LOCAL_EMBEDDING_DEVICE,
    LOCAL_EMBEDDING_MAX_LENGTH,
    LOCAL_EMBEDDING_MODEL,
    LOCAL_EMBEDDING_QUERY_INSTRUCTION,
)
from services.model_response_logger import log_model_response


class EmbeddingError(RuntimeError):
    """A user-safe error raised when the embedding service fails."""


class DoubaoEmbeddingError(EmbeddingError):
    """A user-safe error raised when Doubao cannot create an embedding."""


class LocalEmbeddingError(EmbeddingError):
    """A user-safe error raised when local Qwen3 cannot create an embedding."""


class VectorService:
    # The multimodal endpoint accepts one text item per request.
    BATCH_SIZE = 1
    SUPPORTED_PROVIDERS = {"doubao", "qwen"}

    def __init__(self) -> None:
        CHROMA_DIR.mkdir(parents=True, exist_ok=True)
        self.client = chromadb.PersistentClient(path=str(CHROMA_DIR))
        self.provider = EMBEDDING_PROVIDER
        if self.provider not in self.SUPPORTED_PROVIDERS:
            raise EmbeddingError(
                f"EMBEDDING_PROVIDER 必须是 doubao 或 qwen，当前值为：{self.provider or '空'}。"
            )
        self.api_key = DOUBAO_EM_API_KEY
        self.api_url = f"{DOUBAO_EM_BASE_URL.rstrip('/')}/embeddings/multimodal"
        self.local_model = None
        self.local_tokenizer = None
        self.local_device = None
        self.local_torch = None
        self.local_functional = None

    @staticmethod
    def _provider_model(provider: str) -> str:
        if provider == "qwen":
            return os.getenv("SHIYAN_QWEN_MODEL_ID", str(LOCAL_EMBEDDING_MODEL))
        return DOUBAO_EM_MODEL

    @staticmethod
    def _collection_name(
        knowledge_base_id: str,
        model: str | None = None,
        provider: str = EMBEDDING_PROVIDER,
    ) -> str:
        # Model changes must not make an existing collection fail due to
        # incompatible vector dimensions. A new model gets a new index.
        selected_model = model or VectorService._provider_model(provider)
        seed = f"{knowledge_base_id}:{provider}:{selected_model}"
        return f"kb_{hashlib.sha256(seed.encode()).hexdigest()[:32]}"

    def get_collection(
        self,
        knowledge_base_id: str,
        create: bool = True,
        provider: str | None = None,
    ):
        selected_provider = provider or self.provider
        name = self._collection_name(knowledge_base_id, provider=selected_provider)
        if create:
            return self.client.get_or_create_collection(
                name=name,
                metadata={
                    "knowledge_base_id": knowledge_base_id,
                    "embedding_provider": selected_provider,
                    "embedding_model": self._provider_model(selected_provider),
                },
            )
        try:
            return self.client.get_collection(name=name)
        except Exception:
            return None

    def _all_provider_names(self) -> tuple[str, ...]:
        # Keep both indexes removable when the user switches providers later.
        return tuple(sorted(self.SUPPORTED_PROVIDERS))

    def _collections_for_knowledge_base(self, knowledge_base_id: str) -> list[Any]:
        """Find current and historical provider indexes belonging to one KB."""
        known_names = {
            self._collection_name(knowledge_base_id, provider=provider)
            for provider in self._all_provider_names()
        }
        collections: dict[str, Any] = {}
        for listed in self.client.list_collections():
            name = listed if isinstance(listed, str) else getattr(listed, "name", "")
            if not name:
                continue
            collection = listed
            if isinstance(listed, str):
                try:
                    collection = self.client.get_collection(name=name)
                except Exception:
                    continue
            metadata = getattr(collection, "metadata", {}) or {}
            if name not in known_names and metadata.get("knowledge_base_id") != knowledge_base_id:
                continue
            collections[name] = collection

        # Older Chroma versions may omit an empty provider collection from
        # list_collections, so retain both explicit provider-name fallbacks.
        for provider in self._all_provider_names():
            name = self._collection_name(knowledge_base_id, provider=provider)
            if name in collections:
                continue
            collection = self.get_collection(knowledge_base_id, create=False, provider=provider)
            if collection is not None:
                collections[name] = collection
        return list(collections.values())

    def _call_doubao_embeddings(
        self, texts: list[str], operation: str = "document_embedding"
    ) -> list[list[float]]:
        if not self.api_key:
            raise DoubaoEmbeddingError("未配置 DOUBAO_EM_API_KEY，无法调用豆包 Embedding API。")

        payload = {
            "model": DOUBAO_EM_MODEL,
            "input": [{"type": "text", "text": text} for text in texts],
            "encoding_format": "float",
        }
        response = None
        started_at = time.perf_counter()
        try:
            response = requests.post(
                self.api_url,
                json=payload,
                headers={"Content-Type": "application/json", "Authorization": f"Bearer {self.api_key}"},
                timeout=60,
            )
            log_model_response(
                provider="doubao_embedding",
                operation=operation,
                model=DOUBAO_EM_MODEL,
                status_code=response.status_code,
                elapsed_ms=round((time.perf_counter() - started_at) * 1000),
                metadata={
                    "input_count": len(texts),
                    "response_bytes": len(response.content),
                },
            )
            response.raise_for_status()
        except requests.HTTPError as exc:
            status = getattr(response, "status_code", 0)
            if status in {401, 403}:
                message = "豆包 Embedding API Key 无效或没有调用权限。"
            elif status == 429:
                message = "豆包 Embedding 请求过于频繁或账户余额不足。"
            elif status == 400:
                message = "豆包 Embedding 请求参数或模型配置错误。"
            else:
                message = f"豆包 Embedding API 请求失败（HTTP {status}）。"
            raise DoubaoEmbeddingError(message) from exc
        except requests.RequestException as exc:
            if response is None:
                log_model_response(
                    provider="doubao_embedding",
                    operation=operation,
                    model=DOUBAO_EM_MODEL,
                    status_code=None,
                    elapsed_ms=round((time.perf_counter() - started_at) * 1000),
                    error=f"{type(exc).__name__}: {exc}",
                    metadata={"input_count": len(texts)},
                )
            raise DoubaoEmbeddingError("豆包 Embedding API 网络请求失败，请检查网络连接。") from exc

        try:
            result = response.json()
        except ValueError as exc:
            raise DoubaoEmbeddingError("豆包 Embedding API 返回了无法解析的内容。") from exc

        data = result.get("data") if isinstance(result, dict) else None
        # Doubao may return a single embedding object for one input instead
        # of the list-shaped response used by some embedding endpoints.
        if isinstance(data, dict):
            data = [data]
        if not isinstance(data, list) or len(data) != len(texts):
            raise DoubaoEmbeddingError("豆包 Embedding API 返回的向量数量不正确。")

        embeddings: list[list[float] | None] = [None] * len(texts)
        for fallback_index, item in enumerate(data):
            if not isinstance(item, dict):
                raise DoubaoEmbeddingError("豆包 Embedding API 返回格式错误。")
            index = item.get("index", fallback_index)
            if not isinstance(index, int) or not 0 <= index < len(texts) or embeddings[index] is not None:
                raise DoubaoEmbeddingError("豆包 Embedding API 返回的向量索引错误。")
            embedding = item.get("embedding")
            if isinstance(embedding, list) and embedding and isinstance(embedding[0], list):
                if len(embedding) != 1:
                    raise DoubaoEmbeddingError("豆包 Embedding API 返回了多个向量。")
                embedding = embedding[0]
            if not isinstance(embedding, list) or not embedding:
                raise DoubaoEmbeddingError("豆包 Embedding API 返回了空向量。")
            try:
                embeddings[index] = [float(value) for value in embedding]
            except (TypeError, ValueError) as exc:
                raise DoubaoEmbeddingError("豆包 Embedding API 返回了非法向量。") from exc

        if any(embedding is None for embedding in embeddings):
            raise DoubaoEmbeddingError("豆包 Embedding API 返回的向量不完整。")
        dimensions = len(embeddings[0] or [])
        if not dimensions or any(len(embedding or []) != dimensions for embedding in embeddings):
            raise DoubaoEmbeddingError("豆包 Embedding API 返回的向量维度不一致。")
        return [embedding for embedding in embeddings if embedding is not None]

    @staticmethod
    def _last_token_pool(last_hidden_states, attention_mask):
        torch = __import__("torch")
        left_padding = bool((attention_mask[:, -1].sum() == attention_mask.shape[0]).item())
        if left_padding:
            return last_hidden_states[:, -1]
        sequence_lengths = attention_mask.sum(dim=1) - 1
        batch_size = last_hidden_states.shape[0]
        batch_indices = torch.arange(batch_size, device=last_hidden_states.device)
        return last_hidden_states[batch_indices, sequence_lengths]

    def _resolve_local_device(self, torch) -> str:
        configured = LOCAL_EMBEDDING_DEVICE
        if configured not in {"auto", "cpu", "mps"}:
            raise LocalEmbeddingError(
                "LOCAL_EMBEDDING_DEVICE 必须是 auto、mps 或 cpu。"
            )
        mps_available = bool(
            getattr(getattr(torch.backends, "mps", None), "is_available", lambda: False)()
        )
        if configured == "mps" and not mps_available:
            raise LocalEmbeddingError("当前 PyTorch 不支持 Apple MPS，不能使用 LOCAL_EMBEDDING_DEVICE=mps。")
        if configured == "auto":
            return "mps" if mps_available else "cpu"
        return configured

    def _ensure_local_model(self) -> None:
        if getattr(self, "local_model", None) is not None:
            return

        model_path = LOCAL_EMBEDDING_MODEL.expanduser()
        if not model_path.is_dir():
            raise LocalEmbeddingError(f"本地 Embedding 模型目录不存在：{model_path}")
        if not (model_path / "model.safetensors").is_file():
            raise LocalEmbeddingError(
                f"本地 Qwen 模型权重尚未下载完成：{model_path / 'model.safetensors'}"
            )

        try:
            import torch
            import torch.nn.functional as F
            from transformers import AutoModel, AutoTokenizer
        except ImportError as exc:
            raise LocalEmbeddingError(
                "本地 Qwen Embedding 需要安装 torch 和 transformers。"
            ) from exc

        device = self._resolve_local_device(torch)
        dtype = torch.float16 if device == "mps" else torch.float32
        try:
            tokenizer = AutoTokenizer.from_pretrained(
                str(model_path), local_files_only=True, padding_side="left"
            )
            model = AutoModel.from_pretrained(
                str(model_path), local_files_only=True, torch_dtype=dtype
            )
            model.to(device)
            model.eval()
        except Exception as exc:
            raise LocalEmbeddingError(f"加载本地 Qwen Embedding 模型失败：{exc}") from exc

        self.local_tokenizer = tokenizer
        self.local_model = model
        self.local_device = device
        self.local_torch = torch
        self.local_functional = F

    def _release_local_model(self) -> None:
        """Release Qwen weights and device allocations after every call."""
        torch = getattr(self, "local_torch", None)
        device = getattr(self, "local_device", None)
        model = getattr(self, "local_model", None)
        try:
            if device == "mps" and model is not None:
                model.to("cpu")
        except Exception:
            # References are still cleared below, so a failed device transfer
            # cannot keep the model attached to the service instance.
            pass
        self.local_model = None
        self.local_tokenizer = None
        self.local_functional = None
        self.local_device = None
        self.local_torch = None
        gc.collect()
        if device == "mps" and torch is not None:
            try:
                torch.mps.empty_cache()
            except Exception:
                pass

    def _get_local_embeddings(
        self,
        texts: list[str],
        operation: str,
        progress_callback: Callable[[int, int], None] | None = None,
    ) -> list[list[float]]:
        """Run Qwen embeddings in a one-shot child process.

        PyTorch/MPS never loads into the FastAPI worker, so Metal allocations are
        returned to macOS when the child exits.
        """
        endpoint = os.getenv("SHIYAN_QWEN_EMBEDDING_URL", "")
        if endpoint:
            try:
                from services.qwen_http import embed_qwen
                return embed_qwen(texts, operation, LOCAL_EMBEDDING_QUERY_INSTRUCTION, endpoint, progress_callback)
            except Exception as error:
                raise LocalEmbeddingError("云端向量服务暂时不可用，请稍后重试。") from error
        worker_path = Path(__file__).with_name("embedding_worker.py")
        payload = {
            "texts": texts,
            "operation": operation,
            "model_path": str(LOCAL_EMBEDDING_MODEL),
            "device": LOCAL_EMBEDDING_DEVICE,
            "batch_size": LOCAL_EMBEDDING_BATCH_SIZE,
            "max_length": LOCAL_EMBEDDING_MAX_LENGTH,
            "query_instruction": LOCAL_EMBEDDING_QUERY_INSTRUCTION,
        }
        env = dict(os.environ)
        env.update(
            {
                "PYTHONUNBUFFERED": "1",
                "TRANSFORMERS_VERBOSITY": "error",
                "TOKENIZERS_PARALLELISM": "false",
            }
        )
        started_at = time.perf_counter()
        if progress_callback:
            progress_callback(0, len(texts))
        final_result: dict[str, Any] | None = None
        error_message = ""
        with tempfile.TemporaryFile(mode="w+t", encoding="utf-8") as stderr_file:
            process = subprocess.Popen(
                [sys.executable, str(worker_path)],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=stderr_file,
                text=True,
                bufsize=1,
                env=env,
            )
            try:
                assert process.stdin is not None
                assert process.stdout is not None
                process.stdin.write(json.dumps(payload, ensure_ascii=False))
                process.stdin.close()

                for raw_line in process.stdout:
                    line = raw_line.strip()
                    if not line:
                        continue
                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if event.get("type") == "progress":
                        if progress_callback:
                            progress_callback(
                                int(event.get("done") or 0),
                                int(event.get("total") or len(texts)),
                            )
                    elif event.get("type") == "result":
                        final_result = event
                    elif event.get("type") == "error":
                        error_message = str(event.get("error") or "本地 Embedding 子进程失败")

                return_code = process.wait()
                if return_code != 0 or final_result is None:
                    stderr_file.seek(0)
                    stderr_text = stderr_file.read().strip()
                    detail = error_message or stderr_text or f"子进程退出码 {return_code}"
                    raise LocalEmbeddingError(f"本地 Qwen Embedding 运行失败：{detail}")

                embeddings = final_result.get("embeddings")
                if not isinstance(embeddings, list) or len(embeddings) != len(texts):
                    raise LocalEmbeddingError("本地 Qwen Embedding 返回的向量数量不正确。")

                dimensions = int(final_result.get("dimensions") or 0)
                device = str(final_result.get("device") or LOCAL_EMBEDDING_DEVICE)
                log_model_response(
                    provider="qwen_local_embedding",
                    operation=operation,
                    model="Qwen3-Embedding-0.6B",
                    status_code=200,
                    elapsed_ms=int(
                        final_result.get("elapsed_ms")
                        or round((time.perf_counter() - started_at) * 1000)
                    ),
                    metadata={
                        "input_count": len(texts),
                        "dimensions": dimensions,
                        "device": device,
                        "isolated_process": True,
                    },
                )
                return embeddings
            except EmbeddingError:
                raise
            except Exception as exc:
                log_model_response(
                    provider="qwen_local_embedding",
                    operation=operation,
                    model="Qwen3-Embedding-0.6B",
                    status_code=None,
                    elapsed_ms=round((time.perf_counter() - started_at) * 1000),
                    error=f"{type(exc).__name__}: {exc}",
                    metadata={"input_count": len(texts), "isolated_process": True},
                )
                raise LocalEmbeddingError(f"本地 Qwen Embedding 运行失败：{exc}") from exc
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()
                if process.stdout is not None:
                    process.stdout.close()
                if process.stdin is not None and not process.stdin.closed:
                    process.stdin.close()

    def _get_doubao_embeddings(
        self,
        texts: list[str],
        operation: str,
        progress_callback: Callable[[int, int], None] | None = None,
    ) -> list[list[float]]:
        embeddings: list[list[float]] = []
        for start in range(0, len(texts), self.BATCH_SIZE):
            batch = texts[start : start + self.BATCH_SIZE]
            embeddings.extend(self._call_doubao_embeddings(batch, operation=operation))
            if progress_callback:
                progress_callback(min(start + len(batch), len(texts)), len(texts))
        return embeddings

    def get_embeddings(
        self,
        texts: list[str],
        operation: str = "document_embedding",
        progress_callback: Callable[[int, int], None] | None = None,
    ) -> list[list[float]]:
        normalized = [str(text).strip() for text in texts]
        if not normalized or any(not text for text in normalized):
            raise EmbeddingError("待向量化文本不能为空。")
        if self.provider == "qwen":
            return self._get_local_embeddings(
                normalized, operation=operation, progress_callback=progress_callback
            )
        return self._get_doubao_embeddings(
            normalized, operation=operation, progress_callback=progress_callback
        )

    def get_embedding(self, text: str, operation: str = "question_embedding") -> list[float]:
        return self.get_embeddings([text], operation=operation)[0]

    def add_chunks(
        self,
        knowledge_base_id: str,
        chunks: list[dict],
        progress_callback: Callable[[int, int], None] | None = None,
    ) -> None:
        if not chunks:
            return
        collection = self.get_collection(knowledge_base_id)
        embeddings = self.get_embeddings(
            [chunk["text"] for chunk in chunks],
            operation="document_embedding",
            progress_callback=progress_callback,
        )
        collection.upsert(
            ids=[chunk["id"] for chunk in chunks],
            documents=[chunk["text"] for chunk in chunks],
            embeddings=embeddings,
            metadatas=[
                {
                    "knowledge_base_id": knowledge_base_id,
                    "document_id": chunk["document_id"],
                    "page_start": int(chunk.get("page_start") or 0),
                    "page_end": int(chunk.get("page_end") or 0),
                    "title": chunk.get("title", ""),
                }
                for chunk in chunks
            ],
        )

    def query(self, knowledge_base_id: str, query_text: str, n_results: int = 8) -> list[dict[str, Any]]:
        collection = self.get_collection(knowledge_base_id, create=False)
        if not collection or collection.count() == 0:
            return []
        count = collection.count()
        result = collection.query(
            query_embeddings=[self.get_embedding(query_text, operation="question_embedding")],
            n_results=min(n_results, count),
            include=["documents", "metadatas", "distances"],
        )
        raw_documents = result.get("documents")
        raw_metadatas = result.get("metadatas")
        raw_distances = result.get("distances")
        raw_ids = result.get("ids")
        documents = raw_documents[0] if isinstance(raw_documents, list) and raw_documents and isinstance(raw_documents[0], list) else []
        metadatas = raw_metadatas[0] if isinstance(raw_metadatas, list) and raw_metadatas and isinstance(raw_metadatas[0], list) else []
        distances = raw_distances[0] if isinstance(raw_distances, list) and raw_distances and isinstance(raw_distances[0], list) else []
        ids = raw_ids[0] if isinstance(raw_ids, list) and raw_ids and isinstance(raw_ids[0], list) else []
        output = []
        for index, document in enumerate(documents):
            metadata = metadatas[index] if index < len(metadatas) else {}
            if not isinstance(metadata, dict):
                metadata = {}
            distance = distances[index] if index < len(distances) else 1.0
            try:
                distance = float(distance)
            except (TypeError, ValueError):
                distance = 1.0
            output.append(
                {
                    "chunk_id": ids[index] if index < len(ids) else "",
                    "content": document,
                    "document_id": metadata.get("document_id"),
                    "title": metadata.get("title", ""),
                    "page_start": metadata.get("page_start", 0),
                    "page_end": metadata.get("page_end", 0),
                    "vector_distance": distance,
                }
            )
        return output

    def delete_document(self, knowledge_base_id: str, document_id: str) -> None:
        for collection in self._collections_for_knowledge_base(knowledge_base_id):
            collection.delete(where={"document_id": document_id})

    def delete_knowledge_base(self, knowledge_base_id: str) -> None:
        for collection in self._collections_for_knowledge_base(knowledge_base_id):
            self.client.delete_collection(name=collection.name)

vector_service = VectorService()
