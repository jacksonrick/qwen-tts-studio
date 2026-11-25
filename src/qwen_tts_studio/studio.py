"""Application context wiring repositories, model manager and job runner."""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

from .api.schemas import SpeechRequest
from .config import DEFAULT_SPEAKERS, MODEL_IDS, MODEL_LABELS, Paths, Settings
from .engine.audio import estimate_speech_seconds
from .engine.base import EngineError, GenParams
from .engine.jobs import JobRunner
from .engine.manager import ModelManager
from .store import Database
from .store.apikeys import ApiKeyRepo
from .store.history import HistoryRepo
from .store.voices import VoiceRepo


class Studio:
    def __init__(self, settings: Settings, paths: Paths):
        self.settings = settings
        self.paths = paths
        self.db = Database(paths.db)
        self.history = HistoryRepo(self.db)
        self.voices = VoiceRepo(self.db)
        self.api_keys = ApiKeyRepo(self.db)
        self.manager = ModelManager(settings, paths.root)
        self.runner = JobRunner(self.manager, settings, paths, self.history)
        self.started_at = time.time()

    def start(self) -> None:
        self.runner.start()

    def stop(self) -> None:
        self.runner.stop()
        self.manager.unload()

    # ------------------------------------------------------------------ helpers

    def resolve(self, req: SpeechRequest) -> tuple[GenParams, str, str | None]:
        """Turn an API request into engine parameters, model id and voice reference."""
        voice_id = req.voice_id
        model_id = req.model or MODEL_IDS[req.mode]
        params = req.to_params()
        params.chunk_size = req.chunk_size or self.settings.chunk_size

        if not self.manager.model_cached(model_id):
            label = MODEL_LABELS.get(model_id, model_id)
            raise EngineError(
                f"{label} 的 {self.settings.quant} 权重尚未下载",
                "model_not_cached",
                f"到「系统」页下载 {label} · {self.settings.quant}（约 2–4GB），等待完成后重试",
            )

        if req.mode == "clone":
            voice = self.voices.get(voice_id) if voice_id else None
            if not voice:
                raise EngineError(
                    "音色克隆需要在音色库中选择一个参考音色",
                    "missing_reference",
                    "先在音色库上传参考音频，或先生成一段声音再存为音色",
                )
            ref_text = (req.ref_text or voice.get("ref_text") or "").strip()
            # 没有参考文本就做不了 ICL 对齐，自动退到 x-vector，避免模型复读参考音频
            xvec_only = bool(req.xvec_only or voice.get("xvec_only")) or not ref_text
            spk = voice.get("spk_path")
            rvq = voice.get("rvq_path")
            wav = voice.get("wav_path")
            backend = self.manager.backend

            if xvec_only:
                # x-vector 模式只需要说话人嵌入；带上 .rvq 会让后端按 ICL 处理并直接报错
                if not (wav and Path(wav).exists()):
                    raise EngineError(
                        "音色缺少可用的参考文件",
                        "invalid_reference",
                        "重新上传参考音频，或在音色详情里重新提取音色特征",
                    )
                params.ref_audio = wav
                params.ref_text = ""
            else:
                seconds = _audio_seconds(wav) if wav else 0.0
                estimated = estimate_speech_seconds(ref_text)
                if seconds > 0 and estimated > seconds * 1.35 + 1.5:
                    raise EngineError(
                        f"参考文本比参考音频长太多（文本约 {estimated:.0f} 秒，音频只有 {seconds:.1f} 秒）",
                        "ref_text_mismatch",
                        "ICL 克隆会把参考音频当上下文接着说，文本必须与音频逐字对应；"
                        "把参考文本改成音频里真正说的那段，或打开「仅用说话人特征」",
                    )
                if backend == "ggml" and spk and rvq and Path(spk).exists() and Path(rvq).exists():
                    params.ref_spk = spk
                    params.ref_rvq = rvq
                elif wav and Path(wav).exists():
                    params.ref_audio = wav
                else:
                    raise EngineError(
                        "音色缺少可用的参考文件",
                        "invalid_reference",
                        "重新上传参考音频，或在音色详情里重新提取音色特征",
                    )
                params.ref_text = ref_text

            params.xvec_only = xvec_only
            if backend == "ggml" and params.instruct.strip():
                # ggml 的克隆接口没有 instruct 参数。音色里存了风格指令也不该让每次
                # 试听/合成都 400，这里静默忽略，torch 后端仍然完整支持。
                params.instruct = ""
            self.voices.touch(voice["id"])
            return params, model_id, voice["id"]

        if req.mode == "custom":
            speakers = self._speakers_for(model_id)
            if not params.speaker and speakers:
                params.speaker = speakers[0]
            if not params.speaker:
                raise EngineError("未选择说话人", "missing_speaker", "请选择一个内置说话人")
            return params, model_id, None

        if req.mode == "design" and not params.instruct.strip():
            raise EngineError("缺少音色描述", "missing_instruct", "用一句话描述你想要的音色")
        return params, model_id, None

    def _speakers_for(self, model_id: str) -> list[str]:
        engine = self.manager.current()
        if engine is not None and engine.model_id == model_id and engine.speakers:
            return list(engine.speakers)
        return list(DEFAULT_SPEAKERS)

    def speakers(self, model_id: str | None = None) -> dict[str, Any]:
        target = model_id or MODEL_IDS["custom"]
        engine = self.manager.current()
        loaded = engine is not None and engine.model_id == target and bool(engine.speakers)
        return {
            "model": target,
            "speakers": list(engine.speakers) if loaded else list(DEFAULT_SPEAKERS),
            "loaded": loaded,
        }

    def reload_engine_if_needed(self, *, backend_changed: bool, quant_changed: bool) -> None:
        if backend_changed or quant_changed:
            self.manager.unload()


def _audio_seconds(path: str | Path) -> float:
    """Cheap WAV/FLAC duration lookup (header only, no full decode)."""
    try:
        import soundfile as sf  # noqa: PLC0415 - optional heavy import

        info = sf.info(str(path))
        return float(info.frames) / float(info.samplerate or 1)
    except Exception:
        return 0.0
