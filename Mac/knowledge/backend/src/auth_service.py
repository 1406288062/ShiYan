"""Password hashing and small JWT implementation using Python stdlib only."""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import os
import time
from typing import Any

from config import ACCESS_TOKEN_TTL_MINUTES, JWT_SECRET


def _b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _unb64(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def hash_password(password: str) -> str:
    if len(password) < 8:
        raise ValueError("密码至少需要 8 位")
    salt = os.urandom(16)
    digest = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2**14, r=8, p=1)
    return f"scrypt$16384$8$1${_b64(salt)}${_b64(digest)}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        algorithm, n, r, p, salt, expected = encoded.split("$", 5)
        if algorithm != "scrypt":
            return False
        actual = hashlib.scrypt(
            password.encode("utf-8"),
            salt=_unb64(salt),
            n=int(n),
            r=int(r),
            p=int(p),
        )
        return hmac.compare_digest(actual, _unb64(expected))
    except (ValueError, TypeError, UnicodeError, binascii.Error):
        return False


def create_access_token(user_id: str, email: str, display_name: str) -> str:
    header = {"alg": "HS256", "typ": "JWT"}
    now = int(time.time())
    payload = {
        "sub": user_id,
        "email": email,
        "name": display_name,
        "iat": now,
        "exp": now + ACCESS_TOKEN_TTL_MINUTES * 60,
    }
    encoded_header = _b64(json.dumps(header, separators=(",", ":")).encode())
    encoded_payload = _b64(json.dumps(payload, separators=(",", ":")).encode())
    signing_input = f"{encoded_header}.{encoded_payload}"
    signature = hmac.new(JWT_SECRET.encode("utf-8"), signing_input.encode("ascii"), hashlib.sha256).digest()
    return f"{signing_input}.{_b64(signature)}"


def decode_access_token(token: str) -> dict[str, Any]:
    try:
        encoded_header, encoded_payload, encoded_signature = token.split(".", 2)
        signing_input = f"{encoded_header}.{encoded_payload}"
        expected = hmac.new(JWT_SECRET.encode("utf-8"), signing_input.encode("ascii"), hashlib.sha256).digest()
        if not hmac.compare_digest(expected, _unb64(encoded_signature)):
            raise ValueError("token signature is invalid")
        header = json.loads(_unb64(encoded_header))
        if not isinstance(header, dict) or header.get("alg") != "HS256":
            raise ValueError("unsupported token algorithm")
        payload = json.loads(_unb64(encoded_payload))
        if not isinstance(payload, dict):
            raise ValueError("token payload is invalid")
        expiration = payload.get("exp")
        if isinstance(expiration, bool) or not isinstance(expiration, (int, float)):
            raise ValueError("token expiration is invalid")
        if int(expiration) < int(time.time()):
            raise ValueError("token expired")
        if not isinstance(payload.get("sub"), str) or not payload["sub"]:
            raise ValueError("token subject is missing")
        return payload
    except (ValueError, TypeError, OverflowError, UnicodeError, binascii.Error, json.JSONDecodeError) as exc:
        raise ValueError("无效或已过期的登录凭证") from exc
