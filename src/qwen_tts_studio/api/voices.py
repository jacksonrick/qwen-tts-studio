"""Saved voice library endpoints."""

from __future__ import annotations

import json
import shutil
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, Response

from ..engine.audio import read_audio, wav_bytes, write_wav
from ..engine.base import EngineError
from .deps import require_auth, state
from .schemas import SpeakRequest, VoiceUpdate

router = APIRouter()

MAX_UPLOAD_BYTES = 25 * 1024 * 1024
MAX_REF_SECONDS = 30.0
ALLOWED_SUFFIXES = {".wav", ".mp3", ".flac", ".m4a", ".ogg", ".aac", ".opus", ".webm"}


@router.get("/voices", dependencies=[Depends(require_auth)])
async def list_voices(
    request: Request,
    query: str | None = Query(default=None),
    kind: str | None = Query(default=None),
    language: str | None = Query(default=None),
) -> dict[str, Any]:
    studio = state(request)
    items = studio.voices.list(query=query, kind=kind, language=language)
    return {"items": items, "total": len(items)}


@router.post("/voices", dependencies=[Depends(require_auth)])
async def create_voice(
    request: Request,
    file: UploadFile = File(...),
    name: str = Form(default="未命名音色"),
    ref_text: str = Form(default=""),
    instruct: str = Form(default=""),
    language: str = Form(default="Auto"),
    tags: str = Form(default="[]"),
    xvec_only: bool = Form(default=False),
    color: str = Form(default=""),
    source_history_id: str | None = Form(default=None),
) -> dict[str, Any]:
    studio = state(request)
    suffix = Path(file.filename or "ref.wav").suffix.lower()
    if suffix and suffix not in ALLOWED_SUFFIXES:
        raise HTTPException(status_code=400, detail=f"不支持的音频格式：{suffix}")

    voice_id = uuid.uuid4().hex[:12]
    folder = studio.paths.voices / voice_id
    folder.mkdir(parents=True, exist_ok=True)
    tmp = studio.paths.uploads / f"{voice_id}{suffix or '.wav'}"
    size = 0
    with tmp.open("wb") as handle:
        while chunk := await file.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_UPLOAD_BYTES:
                handle.close()
                tmp.unlink(missing_ok=True)
                shutil.rmtree(folder, ignore_errors=True)
                raise HTTPException(status_code=413, detail="参考音频超过 25MB 限制")
            handle.write(chunk)

    try:
        audio, _rate = read_audio(tmp)
    except Exception as exc:  # noqa: BLE001
        tmp.unlink(missing_ok=True)
        shutil.rmtree(folder, ignore_errors=True)
        raise HTTPException(status_code=400, detail=f"无法解析音频：{exc}") from exc
    finally:
        tmp.unlink(missing_ok=True)

    if audio.size == 0:
        shutil.rmtree(folder, ignore_errors=True)
        raise HTTPException(status_code=400, detail="音频为空")

    seconds = audio.size / 24000.0
    if seconds > MAX_REF_SECONDS:
        audio = audio[: int(MAX_REF_SECONDS * 24000)]
        seconds = MAX_REF_SECONDS

    wav_path = folder / "ref.wav"
    write_wav(wav_path, audio, 24000)

    try:
        tag_list = json.loads(tags) if tags else []
        if not isinstance(tag_list, list):
            tag_list = []
    except ValueError:
        tag_list = []

    record = {
        "id": voice_id,
        "name": name.strip() or "未命名音色",
        "kind": "clone",
        "language": language,
        "ref_text": ref_text.strip(),
        "instruct": instruct.strip(),
        "xvec_only": xvec_only,
        "tags": [str(tag) for tag in tag_list][:12],
        "color": color or None,
        "wav_path": str(wav_path),
        "source_history_id": source_history_id,
    }
    studio.voices.add(record)

    prepared: dict[str, Any] = {"supported": False}
    try:
        prepared = studio.manager.prepare_voice(wav_path, folder / "ref.spk", folder / "ref.rvq", load=False)
        if prepared.get("saved"):
            studio.voices.update(voice_id, spk_path=str(folder / "ref.spk"), rvq_path=str(folder / "ref.rvq"))
    except Exception as exc:  # noqa: BLE001 - extraction is best effort
        prepared = {"supported": False, "reason": str(exc)}

    voice = studio.voices.get(voice_id)
    return {"voice": voice, "duration_s": round(seconds, 2), "prepared": prepared}


@router.get("/voices/{voice_id}", dependencies=[Depends(require_auth)])
async def get_voice(request: Request, voice_id: str) -> dict[str, Any]:
    voice = state(request).voices.get(voice_id)
    if not voice:
        raise HTTPException(status_code=404, detail="voice not found")
    return voice


@router.patch("/voices/{voice_id}", dependencies=[Depends(require_auth)])
async def update_voice(request: Request, voice_id: str, payload: VoiceUpdate) -> dict[str, Any]:
    studio = state(request)
    if not studio.voices.get(voice_id):
        raise HTTPException(status_code=404, detail="voice not found")
    updated = studio.voices.update(voice_id, **payload.model_dump(exclude_none=True))
    return updated or {}


@router.delete("/voices/{voice_id}", dependencies=[Depends(require_auth)])
async def delete_voice(request: Request, voice_id: str) -> dict[str, Any]:
    studio = state(request)
    voice = studio.voices.delete(voice_id)
    if not voice:
        raise HTTPException(status_code=404, detail="voice not found")
    shutil.rmtree(studio.paths.voices / voice_id, ignore_errors=True)
    return {"deleted": voice_id}


@router.get("/voices/{voice_id}/audio", dependencies=[Depends(require_auth)])
async def voice_audio(request: Request, voice_id: str) -> FileResponse:
    studio = state(request)
    voice = studio.voices.get(voice_id)
    if not voice or not voice.get("wav_path") or not Path(voice["wav_path"]).exists():
        raise HTTPException(status_code=404, detail="audio not found")
    return FileResponse(voice["wav_path"], media_type="audio/wav")


@router.post("/voices/{voice_id}/prepare", dependencies=[Depends(require_auth)])
async def prepare_voice(request: Request, voice_id: str) -> dict[str, Any]:
    """Extract ggml .spk/.rvq latents so cloning skips reference encoding."""
    studio = state(request)
    voice = studio.voices.get(voice_id)
    if not voice or not voice.get("wav_path"):
        raise HTTPException(status_code=404, detail="voice not found")
    folder = studio.paths.voices / voice_id
    try:
        import asyncio  # noqa: PLC0415

        result = await asyncio.to_thread(
            studio.manager.prepare_voice,
            Path(voice["wav_path"]),
            folder / "ref.spk",
            folder / "ref.rvq",
            load=True,
        )
    except EngineError as exc:
        raise HTTPException(status_code=400, detail={"code": exc.code, "message": str(exc), "hint": exc.hint}) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    if result.get("saved"):
        studio.voices.update(voice_id, spk_path=str(folder / "ref.spk"), rvq_path=str(folder / "ref.rvq"))
    return {"prepared": result, "voice": studio.voices.get(voice_id)}


@router.post("/voices/{voice_id}/sample", dependencies=[Depends(require_auth)])
async def sample_voice(request: Request, voice_id: str, payload: SpeakRequest) -> Response:
    """Synthesize a short line with this voice (non streaming)."""
    import asyncio  # noqa: PLC0415

    from .schemas import SpeechRequest  # noqa: PLC0415

    studio = state(request)
    voice = studio.voices.get(voice_id)
    if not voice:
        raise HTTPException(status_code=404, detail="voice not found")
    speech = SpeechRequest(
        mode="clone",
        text=payload.text,
        language=payload.language or voice.get("language") or "Auto",
        voice_id=voice_id,
        ref_text=voice.get("ref_text") or "",
        instruct=voice.get("instruct") or "",
    )
    try:
        params, model_id, resolved_voice = studio.resolve(speech)
    except EngineError as exc:
        raise HTTPException(status_code=400, detail={"code": exc.code, "message": str(exc), "hint": exc.hint}) from exc
    job = studio.runner.submit(
        params,
        model_id=model_id,
        loop=asyncio.get_running_loop(),
        streaming=False,
        voice_id=resolved_voice,
    )
    result = await job.done
    if result.get("error"):
        raise HTTPException(status_code=500, detail=result["error"])
    data = wav_bytes(result["audio"], result.get("sample_rate") or 24000)
    return Response(content=data, media_type="audio/wav", headers={"X-Ttfa-Ms": str(result.get("ttfa_ms") or 0)})


@router.get("/voices/{voice_id}/export", dependencies=[Depends(require_auth)])
async def export_voice(request: Request, voice_id: str) -> FileResponse:
    """Download the reference audio plus its metadata as a zip."""
    import zipfile  # noqa: PLC0415

    studio = state(request)
    voice = studio.voices.get(voice_id)
    if not voice:
        raise HTTPException(status_code=404, detail="voice not found")
    folder = studio.paths.voices / voice_id
    archive = studio.paths.uploads / f"{voice_id}.zip"
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as bundle:
        for path in folder.iterdir():
            if path.is_file():
                bundle.write(path, arcname=path.name)
        meta = {key: value for key, value in voice.items() if key not in {"audio_url"}}
        bundle.writestr("meta.json", json.dumps(meta, ensure_ascii=False, indent=2))
    return FileResponse(archive, media_type="application/zip", filename=f"{voice_id}.zip")
