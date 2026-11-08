"""Speech generation endpoints: REST, chunked streaming and WebSocket."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from typing import Any, AsyncIterator

import numpy as np
from fastapi import APIRouter, Depends, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, Response, StreamingResponse

from ..config import LANGUAGES, MODEL_IDS
from ..engine.base import EngineError
from ..engine.jobs import Job
from .deps import check_ws_auth, require_auth, state
from .schemas import SpeechRequest

logger = logging.getLogger(__name__)
router = APIRouter()

FIRST_EVENT_TIMEOUT = 300.0


def _prepare(request: Request, payload: SpeechRequest) -> tuple[Job, Any]:
    studio = state(request)
    params, model_id, voice_id = studio.resolve(payload)
    job = studio.runner.submit(
        params,
        model_id=model_id,
        loop=asyncio.get_running_loop(),
        streaming=True,
        voice_id=voice_id,
    )
    return job, studio


@router.get("/speakers", dependencies=[Depends(require_auth)])
async def get_speakers(request: Request, model: str | None = None) -> dict[str, Any]:
    return state(request).speakers(model)


@router.get("/languages", dependencies=[Depends(require_auth)])
async def get_languages() -> dict[str, Any]:
    return {"languages": list(LANGUAGES)}


@router.get("/jobs/{job_id}", dependencies=[Depends(require_auth)])
async def get_job(request: Request, job_id: str) -> dict[str, Any]:
    job = state(request).runner.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    return {
        "job_id": job.id,
        "status": job.status,
        "mode": job.mode,
        "model_id": job.model_id,
        "record_id": job.record_id,
        "error": job.error,
        "streaming": job.streaming,
    }


@router.post("/tts/cancel/{job_id}", dependencies=[Depends(require_auth)])
async def cancel_job(request: Request, job_id: str) -> dict[str, Any]:
    ok = state(request).runner.cancel(job_id)
    if not ok:
        raise HTTPException(status_code=404, detail="job not found")
    return {"cancelled": True}


@router.post("/tts", dependencies=[Depends(require_auth)])
async def synthesize(request: Request, payload: SpeechRequest) -> Response:
    """Non-streaming generation: returns a complete WAV file."""
    studio = state(request)
    params, model_id, voice_id = studio.resolve(payload)
    job = studio.runner.submit(
        params,
        model_id=model_id,
        loop=asyncio.get_running_loop(),
        streaming=False,
        voice_id=voice_id,
    )
    try:
        result = await asyncio.wait_for(job.done, timeout=FIRST_EVENT_TIMEOUT)
    except asyncio.TimeoutError as exc:
        studio.runner.cancel(job.id)
        raise HTTPException(status_code=504, detail="generation timed out") from exc

    if result.get("error"):
        error = result["error"]
        raise HTTPException(status_code=500, detail=error)

    audio: np.ndarray = result["audio"]
    from ..engine.audio import wav_bytes  # noqa: PLC0415

    data = wav_bytes(audio, result.get("sample_rate") or 24000)
    headers = {
        "X-Job-Id": job.id,
        "X-History-Id": result.get("record_id") or "",
        "X-Duration": f"{result.get('duration_s', 0):.3f}",
        "X-Ttfa-Ms": str(result.get("ttfa_ms") or 0),
        "X-Rtf": str(result.get("rtf") or ""),
        "Content-Disposition": f'inline; filename="{job.id}.wav"',
    }
    return Response(content=data, media_type="audio/wav", headers=headers)


@router.post("/tts/stream", dependencies=[Depends(require_auth)])
async def synthesize_stream(request: Request, payload: SpeechRequest) -> StreamingResponse:
    """Chunked raw PCM16 stream (24000 Hz, mono) for scripts and clients."""
    studio = state(request)
    params, model_id, voice_id = studio.resolve(payload)
    job = studio.runner.submit(
        params,
        model_id=model_id,
        loop=asyncio.get_running_loop(),
        streaming=True,
        voice_id=voice_id,
    )

    try:
        first = await asyncio.wait_for(job.events.get(), timeout=FIRST_EVENT_TIMEOUT)
    except asyncio.TimeoutError as exc:
        studio.runner.cancel(job.id)
        raise HTTPException(status_code=504, detail="model did not respond in time") from exc

    if first.get("type") == "error":
        raise HTTPException(status_code=500, detail=first)

    async def body() -> AsyncIterator[bytes]:
        first_event: dict[str, Any] | None = first
        try:
            while True:
                if first_event is not None:
                    event, first_event = first_event, None
                else:
                    event = await job.events.get()
                kind = event.get("type")
                if kind == "audio":
                    yield event["data"]
                elif kind in {"done", "cancelled", "error"}:
                    break
        finally:
            if job.status not in {"done", "error", "cancelled"}:
                studio.runner.cancel(job.id)

    sample_rate = first.get("sample_rate", 24000) if first.get("type") == "meta" else 24000
    headers = {
        "X-Job-Id": job.id,
        "X-Sample-Rate": str(sample_rate),
        "X-Audio-Format": "s16le",
        "Cache-Control": "no-store",
    }
    return StreamingResponse(
        body(),
        media_type="audio/L16",
        headers=headers,
    )


@router.websocket("/ws/tts")
async def ws_tts(ws: WebSocket) -> None:
    await ws.accept()
    if not check_ws_auth(ws):
        await ws.send_json({"type": "error", "code": "unauthorized", "message": "invalid API key"})
        await ws.close(code=4401)
        return

    studio = ws.app.state.studio
    job: Job | None = None

    async def sender() -> None:
        assert job is not None
        while True:
            event = await job.events.get()
            kind = event.get("type")
            if kind == "audio":
                await ws.send_bytes(event["data"])
                continue
            payload = {key: value for key, value in event.items() if key != "data"}
            await ws.send_text(json.dumps(payload, ensure_ascii=False))
            if kind in {"done", "error", "cancelled"}:
                return

    async def receiver() -> None:
        assert job is not None
        while True:
            message = await ws.receive_text()
            try:
                data = json.loads(message)
            except ValueError:
                continue
            if data.get("type") == "cancel":
                studio.runner.cancel(job.id)

    try:
        raw = await ws.receive_text()
        message = json.loads(raw)
        if message.get("type") != "start":
            await ws.send_json({"type": "error", "code": "bad_request", "message": "expected {type:start}"})
            await ws.close(code=4400)
            return

        payload = SpeechRequest(**message.get("request", {}))
        try:
            params, model_id, voice_id = studio.resolve(payload)
        except EngineError as exc:
            await ws.send_json({"type": "error", "code": exc.code, "message": str(exc), "hint": exc.hint})
            await ws.close(code=4400)
            return

        job = studio.runner.submit(
            params,
            model_id=model_id,
            loop=asyncio.get_running_loop(),
            streaming=True,
            voice_id=voice_id,
        )
        await ws.send_json(
            {"type": "accepted", "job_id": job.id, "mode": params.mode, "model": model_id, "queue": studio.runner.summary()}
        )

        send_task = asyncio.create_task(sender())
        recv_task = asyncio.create_task(receiver())
        done, pending = await asyncio.wait({send_task, recv_task}, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        for task in done:
            exception = task.exception()
            if exception and not isinstance(exception, WebSocketDisconnect):
                logger.debug("ws task ended: %s", exception)

    except WebSocketDisconnect:
        pass
    except json.JSONDecodeError:
        with contextlib.suppress(Exception):
            await ws.send_json({"type": "error", "code": "bad_json", "message": "invalid JSON"})
    except Exception as exc:  # noqa: BLE001
        logger.exception("websocket failure: %s", exc)
    finally:
        if job is not None and job.status not in {"done", "error", "cancelled"}:
            studio.runner.cancel(job.id)
        with contextlib.suppress(Exception):
            await ws.close()
