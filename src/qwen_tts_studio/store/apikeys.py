"""API key storage (hashed with sha256, plaintext shown once)."""

from __future__ import annotations

import hashlib
import secrets
from typing import Any

from .db import Database, now_ts


def _hash(key: str) -> str:
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


class ApiKeyRepo:
    def __init__(self, db: Database):
        self.db = db

    def create(self, name: str) -> tuple[dict[str, Any], str]:
        key = f"qts_{secrets.token_urlsafe(24)}"
        record = {
            "id": secrets.token_hex(8),
            "name": name or "default",
            "key_hash": _hash(key),
            "prefix": key[:12],
            "created_at": now_ts(),
        }
        self.db.execute(
            "INSERT INTO api_keys (id, name, key_hash, prefix, created_at) VALUES (?,?,?,?,?)",
            (record["id"], record["name"], record["key_hash"], record["prefix"], record["created_at"]),
        )
        return record, key

    def list(self) -> list[dict[str, Any]]:
        rows = self.db.query("SELECT id, name, prefix, created_at, last_used_at FROM api_keys ORDER BY created_at DESC")
        return rows

    def delete(self, key_id: str) -> bool:
        row = self.db.query_one("SELECT id FROM api_keys WHERE id = ?", (key_id,))
        if not row:
            return False
        self.db.execute("DELETE FROM api_keys WHERE id = ?", (key_id,))
        return True

    def verify(self, key: str) -> dict[str, Any] | None:
        digest = _hash(key)
        row = self.db.query_one("SELECT * FROM api_keys WHERE key_hash = ?", (digest,))
        if not row:
            return None
        self.db.execute("UPDATE api_keys SET last_used_at = ? WHERE id = ?", (now_ts(), row["id"]))
        return row

    def has_keys(self) -> bool:
        return bool(self.db.scalar("SELECT COUNT(*) FROM api_keys"))
