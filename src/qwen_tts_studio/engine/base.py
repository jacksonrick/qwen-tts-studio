"""Backend-agnostic contracts shared by the ggml and torch engines."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator, Literal, Protocol

Mode = Literal["custom", "design", "clone"]


class EngineError(RuntimeError):
    """Engine level failure carrying a stable machine readable code."""

    def __init__(self, message: str, code: str = "engine_error", hint: str | None = None):
        super().__init__(message)
        self.code = code
        self.hint = hint


@dataclass
class Capabilities:
    supports_instruct_clone: bool
    supports_voice_prompt_cache: bool
    supports_seed: bool = False
    supports_stream: bool = True
    notes: dict[str, str] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {
            "supports_instruct_clone": self.supports_instruct_clone,
            "supports_voice_prompt_cache": self.supports_voice_prompt_cache,
            "supports_seed": self.supports_seed,
            "supports_stream": self.supports_stream,
            "notes": self.notes,
        }


@dataclass
class GenParams:
    mode: Mode
    text: str
    language: str = "Auto"
    speaker: str = ""
    instruct: str = ""
    ref_audio: str | None = None
    ref_text: str = ""
    ref_spk: str | None = None
    ref_rvq: str | None = None
    xvec_only: bool = False
    temperature: float = 0.9
    top_k: int = 50
    top_p: float = 1.0
    repetition_penalty: float = 1.05
    max_new_tokens: int = 2048
    min_new_tokens: int = 2
    do_sample: bool = True
    chunk_size: int = 8
    append_silence: bool = True
    non_streaming_mode: bool | None = None

    def clone_kwargs(self) -> dict[str, Any]:
        kwargs: dict[str, Any] = {
            "text": self.text,
            "language": self.language,
            "ref_text": self.ref_text,
            "xvec_only": self.xvec_only,
        }
        if self.ref_spk and self.ref_rvq:
            kwargs["ref_spk"] = self.ref_spk
            kwargs["ref_rvq"] = self.ref_rvq
        elif self.ref_audio:
            kwargs["ref_audio"] = self.ref_audio
        else:
            raise EngineError("音色克隆缺少参考音频", "missing_reference", "请选择或上传一段参考音频")
        return kwargs


@dataclass
class SpeechChunk:
    audio: Any  # np.ndarray, kept untyped to avoid a hard numpy import here
    sample_rate: int
    index: int
    is_final: bool = False
    timing: dict[str, Any] = field(default_factory=dict)


class TTSEngine(Protocol):
    backend: str
    model_id: str
    quant: str
    sample_rate: int
    capabilities: Capabilities
    speakers: list[str]

    def generate(self, params: GenParams) -> tuple[Any, int]: ...

    def stream(self, params: GenParams) -> Iterator[SpeechChunk]: ...

    def prepare_voice(self, wav_path: Path, *, spk_path: Path | None = None, rvq_path: Path | None = None) -> dict[str, Any]: ...

    def warmup(self) -> None: ...

    def close(self) -> None: ...
