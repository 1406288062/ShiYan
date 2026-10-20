"""Use the same Qwen embedding model through a private CPU embedding worker."""
import math
from urllib.parse import urlsplit
import requests

def embed_qwen(texts, operation, instruction, endpoint, progress=None):
    url = urlsplit(endpoint)
    if url.scheme != 'http' or url.hostname != '127.0.0.1' or url.username or url.password or url.query or url.fragment or url.path != '/v1/embeddings':
        raise ValueError('Qwen embedding worker must be a private loopback endpoint')
    result = []
    if progress: progress(0, len(texts))
    for index, text in enumerate(texts):
        content = f'Instruct: {instruction}\nQuery:{text}' if operation == 'question_embedding' else text
        response = requests.post(endpoint, json={'input': content, 'model': 'qwen3-embedding', 'encoding_format': 'float', 'truncate': True}, timeout=(5, 120))
        response.raise_for_status()
        rows = response.json().get('data')
        if not isinstance(rows, list) or len(rows) != 1:
            raise ValueError('Qwen embedding response count mismatch')
        vector = rows[0].get('embedding')
        if not isinstance(vector, list) or len(vector) != 1024 or any(not isinstance(v, (float,int)) or not math.isfinite(v) for v in vector):
            raise ValueError('Qwen embedding dimensions or values are invalid')
        norm = math.sqrt(sum(v*v for v in vector))
        if norm < 1e-12: raise ValueError('Qwen embedding is empty')
        result.append([v/norm for v in vector])
        if progress: progress(index + 1, len(texts))
    return result
