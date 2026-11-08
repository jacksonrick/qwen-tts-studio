"""System / model management endpoints."""

from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import Any, AsyncIterator

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import PlainTextResponse, StreamingResponse

from ..config import APP_NAME, LANGUAGES, MODEL_IDS, MODEL_LABELS, QUANTS
from ..engine.base import EngineError
from .deps import require_auth, state
from .schemas import SettingsUpdate

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/health")
async def health(request: Request) -> dict[str, Any]:
    studio = state(request)
    return {"ok": True, "app": APP_NAME, "queue": studio.runner.summary()}


@router.get("/system/info", dependencies=[Depends(require_auth)])
async def system_info(request: Request) -> dict[str, Any]:
    studio = state(request)
    runtime = studio.manager.runtime()
    return {
        "app": APP_NAME,
        "runtime": runtime.__dict__,
        "model_status": studio.manager.status(),
        "capabilities": studio.manager.capabilities().as_dict(),
        "queue": studio.runner.summary(),
        "paths": {
            "data": str(studio.paths.root),
            "audio": str(studio.paths.audio),
            "voices": str(studio.paths.voices),
        },
        "options": {
            "languages": list(LANGUAGES),
            "quants": list(QUANTS),
            "models": [{"mode": mode, "model_id": model_id, "label": MODEL_LABELS[model_id]} for mode, model_id in MODEL_IDS.items()],
        },
        "settings": _settings_payload(studio),
    }


def _settings_payload(studio: Any) -> dict[str, Any]:
    settings = studio.settings
    return {
        "backend": settings.backend,
        "quant": settings.quant,
        "default_language": settings.default_language,
        "chunk_size": settings.chunk_size,
        "max_queue": settings.max_queue,
        "keep_model_loaded": settings.keep_model_loaded,
        "max_resident": settings.max_resident,
        "auth_required": settings.auth_required,
        "split_long_text": settings.split_long_text,
        "long_text_threshold": settings.long_text_threshold,
        "temperature": settings.temperature,
        "top_k": settings.top_k,
        "top_p": settings.top_p,
        "repetition_penalty": settings.repetition_penalty,
        "max_new_tokens": settings.max_new_tokens,
        "append_silence": settings.append_silence,
        "auto_open_browser": settings.auto_open_browser,
    }


@router.get("/system/models", dependencies=[Depends(require_auth)])
async def list_models(request: Request) -> dict[str, Any]:
    studio = state(request)
    return {
        "backend": studio.manager.backend,
        "quant": studio.settings.quant,
        "models": studio.manager.model_inventory(),
        "status": studio.manager.status(),
    }


@router.post("/system/models/load", dependencies=[Depends(require_auth)])
async def load_model(
    request: Request,
    model_id: str = Query(...),
    quant: str | None = Query(default=None),
) -> dict[str, Any]:
    studio = state(request)
    if quant and quant != studio.settings.quant:
        studio.settings.quant = quant
        studio.settings.save(studio.paths.root)
    try:
        engine = await asyncio.to_thread(studio.manager.ensure, None, model_id=model_id)
    except EngineError as exc:
        raise HTTPException(status_code=500, detail={"code": exc.code, "message": str(exc), "hint": exc.hint}) from exc
    return {
        "model_id": engine.model_id,
        "backend": engine.backend,
        "quant": engine.quant,
        "speakers": engine.speakers,
        "status": studio.manager.status(),
    }


@router.post("/system/models/unload", dependencies=[Depends(require_auth)])
async def unload_model(request: Request, model_id: str | None = Query(default=None)) -> dict[str, Any]:
    studio = state(request)
    await asyncio.to_thread(studio.manager.unload, model_id)
    return studio.manager.status()


@router.get("/system/models/download", dependencies=[Depends(require_auth)])
async def download_model(
    request: Request,
    model_id: str = Query(...),
    quant: str = Query(default="BF16"),
) -> StreamingResponse:
    """Server-sent events with coarse download progress."""
    studio = state(request)
    if model_id not in MODEL_IDS.values():
        raise HTTPException(status_code=400, detail="unknown model id")
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()

    def progress(payload: dict[str, Any]) -> None:
        loop.call_soon_threadsafe(queue.put_nowait, payload)

    async def runner() -> None:
        try:
            await asyncio.to_thread(studio.manager.download, model_id, quant, progress)
        except Exception as exc:  # noqa: BLE001
            loop.call_soon_threadsafe(queue.put_nowait, {"stage": "error", "message": str(exc)})
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, None)

    async def events() -> AsyncIterator[bytes]:
        task = asyncio.create_task(runner())
        try:
            while True:
                payload = await queue.get()
                if payload is None:
                    break
                yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n".encode()
        finally:
            if not task.done():
                task.cancel()

    return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-store"})


@router.get("/system/queue", dependencies=[Depends(require_auth)])
async def queue_status(request: Request) -> dict[str, Any]:
    return state(request).runner.summary()


@router.get("/system/logs", dependencies=[Depends(require_auth)], response_class=PlainTextResponse)
async def logs(request: Request, tail: int = Query(default=200, ge=1, le=2000)) -> PlainTextResponse:
    studio = state(request)
    path = studio.paths.logs / "studio.log"
    if not path.exists():
        return PlainTextResponse("(no log file)\n")
    text = path.read_text("utf-8", errors="replace")
    lines = text.splitlines()[-tail:]
    return PlainTextResponse("\n".join(lines) + "\n")


@router.delete("/system/logs", dependencies=[Depends(require_auth)])
async def clear_logs(request: Request) -> dict[str, Any]:
    """Empty the log file in place so the live handler keeps working."""
    studio = state(request)
    path = (studio.paths.logs / "studio.log").resolve()
    truncated = 0
    for handler in logging.getLogger().handlers:
        if not isinstance(handler, logging.FileHandler):
            continue
        try:
            handler_path = Path(handler.baseFilename).resolve()
        except (AttributeError, OSError):
            continue
        if handler_path != path:
            continue
        handler.acquire()
        try:
            handler.flush()
            handler.stream.seek(0)
            handler.stream.truncate(0)
            truncated += 1
        finally:
            handler.release()
    if not truncated:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("", encoding="utf-8")
    return {"ok": True, "path": str(path), "handlers": truncated}


@router.post("/system/selftest", dependencies=[Depends(require_auth)])
async def selftest(request: Request, mode: str = Query(default="custom")) -> dict[str, Any]:
    """Load the model for a mode and synthesize a very short phrase."""
    studio = state(request)
    from .schemas import SpeechRequest  # noqa: PLC0415

    if mode not in MODEL_IDS:
        raise HTTPException(status_code=400, detail="mode must be custom/design/clone")
    payload = SpeechRequest(
        mode=mode,  # type: ignore[arg-type]
        text="你好，这是一次自检。",
        language="Chinese",
        speaker="serena",
        instruct="温暖沉稳的旁白" if mode == "design" else "",
    )
    try:
        params, model_id, voice_id = studio.resolve(payload)
    except EngineError as exc:
        raise HTTPException(status_code=400, detail={"code": exc.code, "message": str(exc)}) from exc
    job = studio.runner.submit(
        params,
        model_id=model_id,
        loop=asyncio.get_running_loop(),
        streaming=False,
        voice_id=voice_id,
    )
    result = await job.done
    if result.get("error"):
        return {"ok": False, "error": result["error"], "status": studio.manager.status()}
    return {
        "ok": True,
        "duration_s": round(result.get("duration_s", 0), 3),
        "ttfa_ms": result.get("ttfa_ms"),
        "audio_url": result.get("audio_url"),
        "status": studio.manager.status(),
    }


@router.get("/settings", dependencies=[Depends(require_auth)])
async def get_settings(request: Request) -> dict[str, Any]:
    studio = state(request)
    return {
        "settings": _settings_payload(studio),
        "options": {
            "backends": ["auto", "ggml", "torch"],
            "quants": list(QUANTS),
            "languages": list(LANGUAGES),
        },
    }


@router.put("/settings", dependencies=[Depends(require_auth)])
async def update_settings(request: Request, payload: SettingsUpdate) -> dict[str, Any]:
    studio = state(request)
    settings = studio.settings
    previous_backend = settings.backend
    previous_quant = settings.quant

    for key, value in payload.model_dump(exclude_none=True).items():
        if hasattr(settings, key):
            setattr(settings, key, value)

    if settings.quant not in QUANTS:
        raise HTTPException(status_code=400, detail="unsupported quant")
    if settings.backend not in {"auto", "ggml", "torch"}:
        raise HTTPException(status_code=400, detail="unsupported backend")

    settings.save(studio.paths.root)

    from ..config import reset_runtime_cache  # noqa: PLC0415

    reset_runtime_cache()
    if previous_backend != settings.backend or previous_quant != settings.quant:
        await asyncio.to_thread(studio.manager.unload)
    studio.runner.settings = settings

    return {"settings": _settings_payload(studio), "runtime": studio.manager.runtime().__dict__}
