"""OpenAI compatible /v1/audio/speech endpoint."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response

from ..config import MODEL_IDS
from ..engine.audio import SAMPLE_RATE, to_pcm16, wav_bytes
from ..engine.base import EngineError
from .deps import require_auth, state
from .schemas import OpenAISpeechRequest, SpeechRequest

router = APIRouter()


def _voice_to_request(payload: OpenAISpeechRequest, studio: Any) -> SpeechRequest:
    voice = (payload.voice or "").strip()
    language = payload.language or "Auto"

    if voice.startswith("design:"):
        return SpeechRequest(
            mode="design",
            text=payload.input,
            language=language,
            instruct=payload.instructions or voice[7:].strip(),
        )

    if voice.startswith("voice:"):
        voice_id = voice[6:].strip()
        if not studio.voices.get(voice_id):
            raise EngineError(f"未知音色 {voice_id}", "unknown_voice", "在音色库中确认该音色是否存在")
        return SpeechRequest(mode="clone", text=payload.input, language=language, voice_id=voice_id)

    known = studio.speakers()["speakers"]
    if voice and voice not in known:
        if studio.voices.get(voice):
            return SpeechRequest(mode="clone", text=payload.input, language=language, voice_id=voice)
        raise EngineError(
            f"未知音色 {voice}",
            "unknown_voice",
            "使用内置说话人名、voice:<音色ID> 或 design:<描述>",
        )

    return SpeechRequest(
        mode="custom",
        text=payload.input,
        language=language,
        speaker=voice or (known[0] if known else "serena"),
        instruct=payload.instructions or "",
    )


@router.post("/v1/audio/speech", dependencies=[Depends(require_auth)])
async def openai_speech(request: Request, payload: OpenAISpeechRequest) -> Response:
    import asyncio  # noqa: PLC0415

    studio = state(request)
    fmt = (payload.response_format or "wav").lower()
    if fmt not in {"wav", "pcm"}:
        raise HTTPException(status_code=400, detail=f"response_format {fmt} 暂不支持，请使用 wav 或 pcm")

    try:
        speech = _voice_to_request(payload, studio)
        params, model_id, voice_id = studio.resolve(speech)
    except EngineError as exc:
        raise HTTPException(status_code=400, detail={"code": exc.code, "message": str(exc), "hint": exc.hint}) from exc

    job = studio.runner.submit(
        params,
        model_id=model_id,
        loop=asyncio.get_running_loop(),
        streaming=False,
        voice_id=voice_id,
    )
    result = await job.done
    if result.get("error"):
        raise HTTPException(status_code=500, detail=result["error"])

    audio = result["audio"]
    sample_rate = result.get("sample_rate") or SAMPLE_RATE
    if fmt == "pcm":
        return Response(content=to_pcm16(audio), media_type="audio/L16", headers={"X-Sample-Rate": str(sample_rate)})
    return Response(content=wav_bytes(audio, sample_rate), media_type="audio/wav")


@router.get("/v1/audio/voices", dependencies=[Depends(require_auth)])
async def openai_voices(request: Request) -> dict[str, Any]:
    studio = state(request)
    speakers = studio.speakers()["speakers"]
    voices = studio.voices.list()
    return {
        "object": "list",
        "data": [
            *[{"id": name, "name": name, "type": "builtin", "model": MODEL_IDS["custom"]} for name in speakers],
            *[
                {
                    "id": f"voice:{voice['id']}",
                    "name": voice["name"],
                    "type": "cloned",
                    "language": voice.get("language"),
                    "model": MODEL_IDS["clone"],
                }
                for voice in voices
            ],
        ],
    }
