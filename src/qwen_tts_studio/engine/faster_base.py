"""Shared implementation over `faster_qwen3_tts` wrappers (both backends)."""

from __future__ import annotations

import gc
import threading
from pathlib import Path
from typing import Any, Iterator

import numpy as np

from .base import Capabilities, EngineError, GenParams, SpeechChunk
from .audio import SAMPLE_RATE, concat, read_audio


class FasterEngine:
    """Wraps a `FasterQwen3TTS` / `GGMLQwen3TTS` instance behind a stable API."""

    backend = "ggml"

    def __init__(self, model: Any, *, model_id: str, quant: str, capabilities: Capabilities):
        self.model = model
        self.model_id = model_id
        self.quant = quant
        self.capabilities = capabilities
        self.sample_rate = int(getattr(model, "sample_rate", SAMPLE_RATE) or SAMPLE_RATE)
        self.speakers = self._read_speakers(model)
        self._lock = threading.RLock()

    @staticmethod
    def _read_speakers(model: Any) -> list[str]:
        candidates = [model, getattr(model, "model", None), getattr(getattr(model, "model", None), "model", None)]
        for target in candidates:
            if target is None:
                continue
            getter = getattr(target, "get_supported_speakers", None)
            if not callable(getter):
                continue
            try:
                values = getter()
            except Exception:
                continue
            if values:
                return [str(value) for value in values]
        return []

    def _sampling_kwargs(self, params: GenParams) -> dict[str, Any]:
        return {
            "max_new_tokens": int(params.max_new_tokens),
            "min_new_tokens": int(params.min_new_tokens),
            "temperature": float(params.temperature),
            "top_k": int(params.top_k),
            "top_p": float(params.top_p),
            "do_sample": bool(params.do_sample),
            "repetition_penalty": float(params.repetition_penalty),
        }

    def _call(self, params: GenParams, *, streaming: bool) -> tuple[str, dict[str, Any]]:
        suffix = "_streaming" if streaming else ""
        base = self._sampling_kwargs(params)
        text = (params.text or "").strip()
        if not text:
            raise EngineError("文本为空", "empty_text", "请输入要合成的文本")

        if params.mode == "custom":
            if not params.speaker:
                raise EngineError("未选择说话人", "missing_speaker", "请选择一个内置说话人")
            kwargs = {
                "text": text,
                "speaker": params.speaker,
                "language": params.language,
                "instruct": params.instruct or None,
                "non_streaming_mode": params.non_streaming_mode,
                **base,
            }
            return f"generate_custom_voice{suffix}", kwargs

        if params.mode == "design":
            if not (params.instruct or "").strip():
                raise EngineError("缺少音色描述", "missing_instruct", "声音设计需要一段音色描述")
            kwargs = {
                "text": text,
                "instruct": params.instruct.strip(),
                "language": params.language,
                "non_streaming_mode": params.non_streaming_mode,
                **base,
            }
            return f"generate_voice_design{suffix}", kwargs

        if params.mode == "clone":
            kwargs = self._clone_kwargs(params)
            kwargs.update(base)
            kwargs["non_streaming_mode"] = params.non_streaming_mode
            kwargs["append_silence"] = params.append_silence
            return f"generate_voice_clone{suffix}", kwargs

        raise EngineError(f"未知模式 {params.mode}", "unknown_mode")

    def _clone_kwargs(self, params: GenParams) -> dict[str, Any]:
        raise NotImplementedError

    def generate(self, params: GenParams) -> tuple[np.ndarray, int]:
        method_name, kwargs = self._call(params, streaming=False)
        method = getattr(self.model, method_name, None)
        if method is None:
            raise EngineError(f"当前后端缺少 {method_name}", "unsupported_mode", "请切换模型或后端")
        with self._lock:
            audio_list, sample_rate = method(**kwargs)
        chunks = [np.asarray(item, dtype=np.float32).reshape(-1) for item in audio_list]
        return concat(chunks), int(sample_rate or self.sample_rate)

    def stream(self, params: GenParams) -> Iterator[SpeechChunk]:
        method_name, kwargs = self._call(params, streaming=True)
        kwargs["chunk_size"] = int(params.chunk_size)
        method = getattr(self.model, method_name, None)
        if method is None:
            raise EngineError(f"当前后端缺少 {method_name}", "unsupported_mode", "请切换模型或后端")
        generator = None
        with self._lock:
            generator = method(**kwargs)
            try:
                for index, (chunk, sample_rate, timing) in enumerate(generator):
                    yield SpeechChunk(
                        audio=np.asarray(chunk, dtype=np.float32).reshape(-1),
                        sample_rate=int(sample_rate or self.sample_rate),
                        index=index,
                        is_final=bool((timing or {}).get("is_final")),
                        timing=timing or {},
                    )
            finally:
                if generator is not None and hasattr(generator, "close"):
                    try:
                        generator.close()
                    except Exception:
                        pass

    def prepare_voice(self, wav_path: Path, *, spk_path: Path | None = None, rvq_path: Path | None = None) -> dict[str, Any]:
        return {"supported": False}

    def warmup(self) -> None:
        try:
            self.model.warmup(prefill_len=100)
        except Exception:
            pass

    def close(self) -> None:
        with self._lock:
            self.model = None
            self.speakers = []
            gc.collect()


class FasterGGMLEngine(FasterEngine):
    backend = "ggml"

    @property
    def runtime(self) -> Any:
        return getattr(self.model, "runtime", None)

    def _clone_kwargs(self, params: GenParams) -> dict[str, Any]:
        if (params.instruct or "").strip():
            raise EngineError(
                "ggml 后端不支持克隆时的风格指令",
                "unsupported_parameter",
                "清空 instruct，或将后端切换为 torch",
            )
        kwargs: dict[str, Any] = {
            "text": params.text.strip(),
            "language": params.language,
            "ref_text": params.ref_text or "",
            "xvec_only": bool(params.xvec_only),
        }
        if params.ref_spk and params.ref_rvq:
            kwargs["ref_spk"] = params.ref_spk
            kwargs["ref_rvq"] = params.ref_rvq
        elif params.ref_audio:
            kwargs["ref_audio"] = params.ref_audio
        else:
            raise EngineError("音色克隆缺少参考音频", "missing_reference", "请选择或上传一段参考音频")
        return kwargs

    def prepare_voice(self, wav_path: Path, *, spk_path: Path | None = None, rvq_path: Path | None = None) -> dict[str, Any]:
        runtime = self.runtime
        if runtime is None or not hasattr(runtime, "extract_voice_ref"):
            return {"supported": False, "reason": "当前 qwentts.cpp 版本不支持参考音色预提取"}
        audio, rate = read_audio(wav_path, target_rate=SAMPLE_RATE)
        if audio.size == 0:
            raise EngineError("参考音频为空", "invalid_reference")
        with self._lock:
            voice_ref = runtime.extract_voice_ref(audio)
        if spk_path is None or rvq_path is None:
            return {"supported": True, "saved": False, "sample_rate": rate}
        spk_path.parent.mkdir(parents=True, exist_ok=True)
        voice_ref.save(spk_path, rvq_path)
        return {
            "supported": True,
            "saved": True,
            "spk_path": str(spk_path),
            "rvq_path": str(rvq_path),
            "frames": int(getattr(voice_ref, "ref_T", 0)),
            "sample_rate": rate,
        }


class FasterTorchEngine(FasterEngine):
    backend = "torch"

    def _clone_kwargs(self, params: GenParams) -> dict[str, Any]:
        kwargs: dict[str, Any] = {
            "text": params.text.strip(),
            "language": params.language,
            "ref_text": params.ref_text or "",
            "xvec_only": bool(params.xvec_only),
        }
        if params.ref_audio:
            kwargs["ref_audio"] = params.ref_audio
        else:
            raise EngineError("音色克隆缺少参考音频", "missing_reference", "请选择或上传一段参考音频")
        if (params.instruct or "").strip():
            kwargs["instruct"] = params.instruct.strip()
        return kwargs
