"""History records of every generation."""

from __future__ import annotations

from typing import Any

from .db import Database, loads, now_ts


class HistoryRepo:
    def __init__(self, db: Database):
        self.db = db

    def add(self, record: dict[str, Any]) -> str:
        self.db.execute(
            """INSERT INTO history (id, mode, model, quant, backend, text, language, params_json,
                                    voice_id, audio_path, duration_s, sample_rate, ttfa_ms, rtf,
                                    status, error, audio_deleted, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                record["id"],
                record["mode"],
                record["model"],
                record.get("quant"),
                record.get("backend"),
                record["text"],
                record.get("language"),
                record.get("params_json"),
                record.get("voice_id"),
                record.get("audio_path"),
                record.get("duration_s"),
                record.get("sample_rate"),
                record.get("ttfa_ms"),
                record.get("rtf"),
                record.get("status", "done"),
                record.get("error"),
                1 if record.get("audio_deleted") else 0,
                record.get("created_at") or now_ts(),
            ),
        )
        return record["id"]

    def list(
        self,
        *,
        page: int = 1,
        page_size: int = 20,
        mode: str | None = None,
        status: str | None = None,
        query: str | None = None,
    ) -> dict[str, Any]:
        where: list[str] = []
        params: list[Any] = []
        if mode:
            where.append("mode = ?")
            params.append(mode)
        if status:
            where.append("status = ?")
            params.append(status)
        if query:
            where.append("text LIKE ?")
            params.append(f"%{query}%")
        clause = f"WHERE {' AND '.join(where)}" if where else ""
        total = self.db.scalar(f"SELECT COUNT(*) FROM history {clause}", params) or 0
        offset = max(0, (page - 1) * page_size)
        rows = self.db.query(
            f"SELECT * FROM history {clause} ORDER BY created_at DESC LIMIT ? OFFSET ?",
            [*params, page_size, offset],
        )
        return {"items": [self._decorate(row) for row in rows], "total": int(total), "page": page, "page_size": page_size}

    def get(self, record_id: str) -> dict[str, Any] | None:
        row = self.db.query_one("SELECT * FROM history WHERE id = ?", (record_id,))
        return self._decorate(row) if row else None

    def delete(self, record_id: str) -> dict[str, Any] | None:
        row = self.get(record_id)
        if row:
            self.db.execute("DELETE FROM history WHERE id = ?", (record_id,))
        return row

    def update(self, record_id: str, **fields: Any) -> None:
        if not fields:
            return
        columns = ", ".join(f"{key} = ?" for key in fields)
        self.db.execute(f"UPDATE history SET {columns} WHERE id = ?", (*fields.values(), record_id))

    def mark_audio_deleted(self, before_ts: int) -> list[str]:
        rows = self.db.query(
            "SELECT id FROM history WHERE created_at < ? AND audio_deleted = 0 AND audio_path IS NOT NULL",
            (before_ts,),
        )
        ids = [row["id"] for row in rows]
        if ids:
            self.db.execute(
                f"UPDATE history SET audio_deleted = 1, audio_path = NULL WHERE id IN ({','.join('?' * len(ids))})",
                ids,
            )
        return ids

    def distinct_modes(self) -> list[str]:
        return [row["mode"] for row in self.db.query("SELECT DISTINCT mode FROM history ORDER BY mode")]

    @staticmethod
    def _decorate(row: dict[str, Any]) -> dict[str, Any]:
        row["params"] = loads(row.pop("params_json", None), {})
        row["audio_url"] = None if row.get("audio_deleted") else f"/api/v1/history/{row['id']}/audio"
        return row
