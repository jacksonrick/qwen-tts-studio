"""Request / response models."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

from ..engine.base import GenParams

MAX_TEXT_CHARS = 8000


class SpeechRequest(BaseModel):
    mode: Literal["custom", "design", "clone"] = "custom"
    text: str = Field(default="", max_length=MAX_TEXT_CHARS)
    language: str = "Auto"

    speaker: str = ""
    instruct: str = ""
    voice_id: str | None = None
    ref_text: str = ""
    xvec_only: bool = False

    model: str | None = None
    quant: str | None = None

    temperature: float = Field(default=0.9, ge=0.0, le=2.0)
    top_k: int = Field(default=50, ge=0, le=500)
    top_p: float = Field(default=1.0, gt=0.0, le=1.0)
    repetition_penalty: float = Field(default=1.05, ge=0.5, le=2.0)
    max_new_tokens: int = Field(default=2048, ge=64, le=8192)
    chunk_size: int = Field(default=8, ge=1, le=48)
    append_silence: bool = True
    non_streaming_mode: bool | None = None
    do_sample: bool = True

    @field_validator("text")
    @classmethod
    def _strip(cls, value: str) -> str:
        return value.strip()

    @field_validator("language")
    @classmethod
    def _language(cls, value: str) -> str:
        return (value or "Auto").strip() or "Auto"

    def to_params(self) -> GenParams:
        return GenParams(
            mode=self.mode,  # type: ignore[arg-type]
            text=self.text,
            language=self.language,
            speaker=self.speaker,
            instruct=self.instruct,
            ref_text=self.ref_text,
            xvec_only=self.xvec_only,
            temperature=self.temperature,
            top_k=self.top_k,
            top_p=self.top_p,
            repetition_penalty=self.repetition_penalty,
            max_new_tokens=self.max_new_tokens,
            chunk_size=self.chunk_size,
            append_silence=self.append_silence,
            non_streaming_mode=self.non_streaming_mode,
            do_sample=self.do_sample,
        )


class SpeakRequest(BaseModel):
    text: str = Field(min_length=1, max_length=400)
    language: str = "Auto"


class VoiceUpdate(BaseModel):
    name: str | None = None
    tags: list[str] | None = None
    ref_text: str | None = None
    instruct: str | None = None
    language: str | None = None
    xvec_only: bool | None = None
    color: str | None = None


class SettingsUpdate(BaseModel):
    backend: str | None = None
    quant: str | None = None
    default_language: str | None = None
    chunk_size: int | None = Field(default=None, ge=1, le=48)
    max_queue: int | None = Field(default=None, ge=1, le=64)
    keep_model_loaded: bool | None = None
    max_resident: int | None = Field(default=None, ge=1, le=3)
    auth_required: bool | None = None
    split_long_text: bool | None = None
    long_text_threshold: int | None = Field(default=None, ge=120, le=4000)
    temperature: float | None = Field(default=None, ge=0.0, le=2.0)
    top_k: int | None = Field(default=None, ge=0, le=500)
    top_p: float | None = Field(default=None, gt=0.0, le=1.0)
    repetition_penalty: float | None = Field(default=None, ge=0.5, le=2.0)
    max_new_tokens: int | None = Field(default=None, ge=64, le=8192)
    append_silence: bool | None = None
    auto_open_browser: bool | None = None


class ApiKeyCreate(BaseModel):
    name: str = Field(default="default", max_length=64)


class OpenAISpeechRequest(BaseModel):
    model: str = "qwen3-tts"
    input: str = Field(min_length=1, max_length=MAX_TEXT_CHARS)
    voice: str = "serena"
    response_format: str = "wav"
    speed: float | None = Field(default=None, ge=0.25, le=4.0)
    instructions: str | None = None
    language: str | None = None


def error_payload(code: str, message: str, hint: str | None = None) -> dict[str, Any]:
    return {"error": {"code": code, "message": message, "hint": hint}}
