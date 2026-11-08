"""Saved voices (clone references, designed voices and builtin speaker shortcuts)."""

from __future__ import annotations

import json
from typing import Any

from .db import Database, loads, now_ts


class VoiceRepo:
    def __init__(self, db: Database):
        self.db = db

    def add(self, record: dict[str, Any]) -> str:
        ts = now_ts()
        self.db.execute(
            """INSERT INTO voices (id, name, kind, language, ref_text, instruct, xvec_only, tags_json,
                                   color, wav_path, spk_path, rvq_path, source_history_id,
                                   use_count, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                record["id"],
                record["name"],
                record["kind"],
                record.get("language"),
                record.get("ref_text"),
                record.get("instruct"),
                1 if record.get("xvec_only") else 0,
                json.dumps(record.get("tags") or [], ensure_ascii=False),
                record.get("color"),
                record.get("wav_path"),
                record.get("spk_path"),
                record.get("rvq_path"),
                record.get("source_history_id"),
                0,
                record.get("created_at") or ts,
                ts,
            ),
        )
        return record["id"]

    def list(self, *, query: str | None = None, kind: str | None = None, language: str | None = None) -> list[dict[str, Any]]:
        where: list[str] = []
        params: list[Any] = []
        if kind:
            where.append("kind = ?")
            params.append(kind)
        if language:
            where.append("language = ?")
            params.append(language)
        if query:
            where.append("(name LIKE ? OR tags_json LIKE ? OR ref_text LIKE ?)")
            params.extend([f"%{query}%"] * 3)
        clause = f"WHERE {' AND '.join(where)}" if where else ""
        rows = self.db.query(f"SELECT * FROM voices {clause} ORDER BY created_at DESC", params)
        return [self._decorate(row) for row in rows]

    def get(self, voice_id: str) -> dict[str, Any] | None:
        row = self.db.query_one("SELECT * FROM voices WHERE id = ?", (voice_id,))
        return self._decorate(row) if row else None

    def update(self, voice_id: str, **fields: Any) -> dict[str, Any] | None:
        if fields:
            if "tags" in fields:
                fields["tags_json"] = json.dumps(fields.pop("tags") or [], ensure_ascii=False)
            fields["updated_at"] = now_ts()
            columns = ", ".join(f"{key} = ?" for key in fields)
            self.db.execute(f"UPDATE voices SET {columns} WHERE id = ?", (*fields.values(), voice_id))
        return self.get(voice_id)

    def delete(self, voice_id: str) -> dict[str, Any] | None:
        row = self.get(voice_id)
        if row:
            self.db.execute("DELETE FROM voices WHERE id = ?", (voice_id,))
        return row

    def touch(self, voice_id: str) -> None:
        self.db.execute(
            "UPDATE voices SET use_count = use_count + 1, updated_at = ? WHERE id = ?",
            (now_ts(), voice_id),
        )

    def languages(self) -> list[str]:
        return [row["language"] for row in self.db.query("SELECT DISTINCT language FROM voices WHERE language IS NOT NULL")]

    @staticmethod
    def _decorate(row: dict[str, Any]) -> dict[str, Any]:
        row["tags"] = loads(row.pop("tags_json", None), [])
        row["xvec_only"] = bool(row.get("xvec_only"))
        row["has_ref_spk"] = bool(row.get("spk_path"))
        row["audio_url"] = f"/api/v1/voices/{row['id']}/audio" if row.get("wav_path") else None
        return row
