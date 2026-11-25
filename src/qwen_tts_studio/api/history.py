"""History browsing, audio delivery and regeneration."""

from __future__ import annotations

import asyncio
import contextlib
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import FileResponse, Response

from ..engine.audio import wav_bytes
from ..engine.base import EngineError
from .deps import require_auth, state
from .schemas import SpeechRequest

router = APIRouter()


def _audio_response(path: Path, request: Request, *, filename: str | None = None, download: bool = False) -> Response:
    if not path.exists():
        raise HTTPException(status_code=404, detail="audio file missing")
    size = path.stat().st_size
    disposition = "attachment" if download else "inline"
    headers = {"Accept-Ranges": "bytes", "Content-Disposition": f'{disposition}; filename="{filename or path.name}"'}
    range_header = request.headers.get("range")
    if range_header and range_header.startswith("bytes="):
        spec = range_header[6:].split("-")
        try:
            start = int(spec[0]) if spec[0] else 0
            end = int(spec[1]) if len(spec) > 1 and spec[1] else size - 1
        except ValueError:
            start, end = 0, size - 1
        start = max(0, min(start, size - 1))
        end = max(start, min(end, size - 1))
        with path.open("rb") as handle:
            handle.seek(start)
            payload = handle.read(end - start + 1)
        headers["Content-Range"] = f"bytes {start}-{end}/{size}"
        headers["Content-Length"] = str(len(payload))
        return Response(content=payload, status_code=206, media_type="audio/wav", headers=headers)
    return FileResponse(path, media_type="audio/wav", headers=headers)


@router.get("/history", dependencies=[Depends(require_auth)])
async def list_history(
    request: Request,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    mode: str | None = Query(default=None),
    status: str | None = Query(default=None),
    query: str | None = Query(default=None),
) -> dict[str, Any]:
    studio = state(request)
    return studio.history.list(page=page, page_size=page_size, mode=mode, status=status, query=query)


def _older_than(before: int) -> int:
    """Only allow cutting strictly into the past, so a bad timestamp cannot wipe new records."""
    if before <= 0 or before > time.time() - 60:
        raise HTTPException(status_code=400, detail="before 必须是 1 分钟以前的 Unix 时间戳")
    return before


@router.get("/history/preview", dependencies=[Depends(require_auth)])
async def preview_cleanup(request: Request, before: int = Query(..., ge=0)) -> dict[str, Any]:
    """How many records (and how much disk) a cleanup would remove."""
    studio = state(request)
    rows = studio.history.pending_before(_older_than(before))
    audio_files = 0
    audio_bytes = 0
    for row in rows:
        path = row.get("audio_path")
        if not path:
            continue
        audio_files += 1
        with contextlib.suppress(OSError):
            audio_bytes += Path(path).stat().st_size
    return {
        "before": before,
        "records": len(rows),
        "audio_files": audio_files,
        "audio_bytes": audio_bytes,
        "oldest": rows[0]["created_at"] if rows else None,
        "newest": rows[-1]["created_at"] if rows else None,
    }


@router.delete("/history", dependencies=[Depends(require_auth)])
async def cleanup_history(request: Request, before: int = Query(..., ge=0)) -> dict[str, Any]:
    """Bulk delete: remove every record older than `before`, including its audio file."""
    studio = state(request)
    rows = studio.history.delete_before(_older_than(before))
    audio_removed = 0
    freed_bytes = 0
    folders: set[Path] = set()
    for row in rows:
        path = row.get("audio_path")
        if not path:
            continue
        file = Path(path)
        with contextlib.suppress(OSError):
            freed_bytes += file.stat().st_size
        try:
            file.unlink()
            audio_removed += 1
            folders.add(file.parent)
        except OSError:
            pass
    # 顺手清掉空的 年/月/日 目录，避免 audio 下留一堆空壳
    for folder in sorted(folders, key=lambda item: len(item.parts), reverse=True):
        for candidate in (folder, folder.parent, folder.parent.parent):
            with contextlib.suppress(OSError):
                candidate.rmdir()
    return {"deleted": len(rows), "audio_removed": audio_removed, "freed_bytes": freed_bytes}


@router.get("/history/{record_id}", dependencies=[Depends(require_auth)])
async def get_history(request: Request, record_id: str) -> dict[str, Any]:
    record = state(request).history.get(record_id)
    if not record:
        raise HTTPException(status_code=404, detail="record not found")
    return record


@router.get("/history/{record_id}/audio", dependencies=[Depends(require_auth)])
async def history_audio(request: Request, record_id: str) -> Response:
    studio = state(request)
    record = studio.history.get(record_id)
    if not record or not record.get("audio_path"):
        raise HTTPException(status_code=404, detail="audio not found")
    return _audio_response(Path(record["audio_path"]), request, filename=f"{record_id}.wav")


@router.get("/history/{record_id}/download", dependencies=[Depends(require_auth)])
async def history_download(request: Request, record_id: str) -> Response:
    studio = state(request)
    record = studio.history.get(record_id)
    if not record or not record.get("audio_path"):
        raise HTTPException(status_code=404, detail="audio not found")
    return _audio_response(Path(record["audio_path"]), request, filename=f"{record_id}.wav", download=True)


@router.delete("/history/{record_id}", dependencies=[Depends(require_auth)])
async def delete_history(request: Request, record_id: str) -> dict[str, Any]:
    studio = state(request)
    record = studio.history.delete(record_id)
    if not record:
        raise HTTPException(status_code=404, detail="record not found")
    if record.get("audio_path"):
        Path(record["audio_path"]).unlink(missing_ok=True)
    return {"deleted": record_id}


@router.post("/history/{record_id}/regenerate", dependencies=[Depends(require_auth)])
async def regenerate(request: Request, record_id: str, overrides: dict[str, Any] | None = None) -> Response:
    studio = state(request)
    record = studio.history.get(record_id)
    if not record:
        raise HTTPException(status_code=404, detail="record not found")
    params = record.get("params") or {}
    payload = SpeechRequest(
        mode=record["mode"],
        text=(overrides or {}).get("text") or record["text"],
        language=(overrides or {}).get("language") or record.get("language") or "Auto",
        speaker=params.get("speaker") or "",
        instruct=params.get("instruct") or "",
        voice_id=record.get("voice_id"),
        ref_text=params.get("ref_text") or "",
        xvec_only=bool(params.get("xvec_only")),
        temperature=params.get("temperature", 0.9),
        top_k=params.get("top_k", 50),
        top_p=params.get("top_p", 1.0),
        repetition_penalty=params.get("repetition_penalty", 1.05),
        max_new_tokens=params.get("max_new_tokens", 2048),
        chunk_size=params.get("chunk_size", 8),
        append_silence=params.get("append_silence", True),
        non_streaming_mode=params.get("non_streaming_mode"),
    )
    try:
        resolved, model_id, voice_id = studio.resolve(payload)
    except EngineError as exc:
        raise HTTPException(status_code=400, detail={"code": exc.code, "message": str(exc)}) from exc
    job = studio.runner.submit(
        resolved,
        model_id=model_id,
        loop=asyncio.get_running_loop(),
        streaming=False,
        voice_id=voice_id,
    )
    result = await job.done
    job.release_result()
    if result.get("error"):
        raise HTTPException(status_code=500, detail=result["error"])
    return Response(
        content=wav_bytes(result["audio"], result.get("sample_rate") or 24000),
        media_type="audio/wav",
        headers={"X-History-Id": result.get("record_id") or "", "X-Ttfa-Ms": str(result.get("ttfa_ms") or 0)},
    )
