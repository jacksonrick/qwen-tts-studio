"""Model loading, residency management and capability reporting."""

from __future__ import annotations

import gc
import logging
import os
import platform
import threading
import time
from collections import OrderedDict
from pathlib import Path
from typing import Any, Callable

from ..config import MODEL_IDS, MODEL_LABELS, QUANTS, RuntimeInfo, Settings, resolve_backend, runtime_info
from .base import Capabilities, EngineError, Mode
from .faster_base import FasterGGMLEngine, FasterTorchEngine

logger = logging.getLogger(__name__)


def _dir_size(paths: list[Path]) -> int:
    total = 0
    for path in paths:
        try:
            total += path.stat().st_size
        except OSError:
            continue
    return total


class ModelManager:
    """Keeps at most N models resident and serialises loading."""

    def __init__(self, settings: Settings, data_root: Path):
        self.settings = settings
        self.data_root = Path(data_root)
        self.ref_cache_dir = self.data_root / "ref_cache"
        self.ref_cache_dir.mkdir(parents=True, exist_ok=True)
        self._resident: OrderedDict[str, Any] = OrderedDict()
        self._lock = threading.RLock()
        self._load_lock = threading.Lock()
        self._status = "idle"
        self._loading_model: str | None = None
        self._error: str | None = None
        self._loaded_at: float | None = None
        self._last_load_ms: float | None = None
        self._downloads: dict[str, dict[str, Any]] = {}

    # ---------------------------------------------------------------- status

    @property
    def backend(self) -> str:
        return resolve_backend(self.settings.backend)

    def runtime(self) -> RuntimeInfo:
        return runtime_info(self.settings.backend)

    def capabilities(self) -> Capabilities:
        engine = self.current()
        if engine is not None:
            return engine.capabilities
        if self.backend == "ggml":
            return Capabilities(
                supports_instruct_clone=False,
                supports_voice_prompt_cache=False,
                notes={"instruct_clone": "ggml 后端不支持克隆时的风格指令"},
            )
        return Capabilities(
            supports_instruct_clone=True,
            supports_voice_prompt_cache=True,
            notes={"instruct_clone": "torch 后端支持，属于实验性能力"},
        )

    def status(self) -> dict[str, Any]:
        with self._lock:
            resident = list(self._resident.keys())
            return {
                "status": self._status,
                "loading": self._loading_model,
                "error": self._error,
                "resident": resident,
                "loaded_at": self._loaded_at,
                "load_ms": self._last_load_ms,
                "backend": self.backend,
                "quant": self.settings.quant,
                "rss_mb": self._rss_mb(),
            }

    @staticmethod
    def _rss_mb() -> float | None:
        try:
            import resource  # noqa: PLC0415

            usage = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
            return round(usage / (1024 * 1024 if platform.system() == "Darwin" else 1024), 1)
        except Exception:
            return None

    def current(self) -> Any | None:
        with self._lock:
            return next(reversed(self._resident.values()), None) if self._resident else None

    def current_model_id(self) -> str | None:
        with self._lock:
            return next(reversed(self._resident.keys()), None) if self._resident else None

    # ------------------------------------------------------------------ load

    def ensure(self, mode: Mode | None = None, *, model_id: str | None = None) -> Any:
        target = model_id or MODEL_IDS[mode or "custom"]
        quant = self.settings.quant
        with self._lock:
            engine = self._resident.get(target)
            if engine is not None and engine.quant == quant:
                self._resident.move_to_end(target)
                return engine

        with self._load_lock:
            with self._lock:
                engine = self._resident.get(target)
                if engine is not None and engine.quant == quant:
                    return engine
            return self._load(target, quant)

    def _load(self, model_id: str, quant: str) -> Any:
        self._status = "loading"
        self._loading_model = model_id
        self._error = None
        started = time.perf_counter()
        try:
            engine = self._build_engine(model_id, quant)
        except EngineError as exc:
            self._status = "error"
            self._loading_model = None
            self._error = str(exc)
            raise
        except Exception as exc:  # noqa: BLE001 - surfaced to the UI with context
            self._status = "error"
            self._loading_model = None
            self._error = f"{type(exc).__name__}: {exc}"
            logger.exception("model load failed: %s", model_id)
            raise EngineError(
                f"模型加载失败：{self._error}",
                "model_load_failed",
                "检查模型是否已下载，或到系统页重新下载/切换量化",
            ) from exc

        with self._lock:
            self._resident[model_id] = engine
            while len(self._resident) > max(1, int(self.settings.max_resident)):
                oldest_id, oldest = self._resident.popitem(last=False)
                if oldest_id != model_id:
                    logger.info("unload model %s", oldest_id)
                    try:
                        oldest.close()
                    except Exception:
                        pass
            self._status = "ready"
            self._loading_model = None
            self._loaded_at = time.time()
            self._last_load_ms = round((time.perf_counter() - started) * 1000, 1)

        if self.settings.keep_model_loaded:
            engine.warmup()
        return engine

    def _build_engine(self, model_id: str, quant: str) -> Any:
        from faster_qwen3_tts import FasterQwen3TTS  # noqa: PLC0415 - heavy import

        backend = self.backend
        if backend == "ggml":
            try:
                model = FasterQwen3TTS.from_pretrained(
                    model_name=model_id,
                    backend="ggml",
                    quant=quant,
                    qwentts_ref_cache_dir=str(self.ref_cache_dir),
                    cache_dir=os.environ.get("HF_HOME") or None,
                )
            except ModuleNotFoundError as exc:
                raise EngineError(
                    "ggml 后端不可用：缺少 qwentts-cpp-python",
                    "backend_unavailable",
                    "Windows 无官方 wheel，请改用 torch 后端；或使用 WSL2/Docker",
                ) from exc
            return FasterGGMLEngine(
                model,
                model_id=model_id,
                quant=quant,
                capabilities=Capabilities(
                    supports_instruct_clone=False,
                    supports_voice_prompt_cache=False,
                    notes={"instruct_clone": "ggml 后端不支持克隆时的风格指令"},
                ),
            )

        import torch  # noqa: PLC0415

        if not torch.cuda.is_available():
            raise EngineError(
                "torch 后端需要 NVIDIA CUDA 环境",
                "backend_unavailable",
                "macOS 请使用 ggml 后端；Windows/Linux 请先安装匹配的 CUDA 版 PyTorch",
            )
        model = FasterQwen3TTS.from_pretrained(model_name=model_id, backend="torch", device="cuda")
        return FasterTorchEngine(
            model,
            model_id=model_id,
            quant=quant,
            capabilities=Capabilities(
                supports_instruct_clone=True,
                supports_voice_prompt_cache=True,
                notes={"instruct_clone": "torch 后端支持，属于实验性能力"},
            ),
        )

    def unload(self, model_id: str | None = None) -> None:
        with self._lock:
            targets = [model_id] if model_id else list(self._resident.keys())
            for key in targets:
                engine = self._resident.pop(key, None)
                if engine is not None:
                    try:
                        engine.close()
                    except Exception:
                        pass
            if not self._resident:
                self._status = "idle"
                self._loaded_at = None
            gc.collect()

    def reload(self) -> Any | None:
        model_id = self.current_model_id()
        self.unload()
        if model_id:
            return self.ensure(model_id=model_id)
        return None

    # ---------------------------------------------------------------- assets

    def model_inventory(self) -> list[dict[str, Any]]:
        from qwentts_cpp.models import resolve_gguf_paths  # noqa: PLC0415

        resident = set(self._resident.keys())
        inventory: list[dict[str, Any]] = []
        for mode, model_id in MODEL_IDS.items():
            entry: dict[str, Any] = {
                "model_id": model_id,
                "mode": mode,
                "label": MODEL_LABELS[model_id],
                "resident": model_id in resident,
                "quants": [],
                "backend": self.backend,
            }
            for quant in QUANTS:
                item: dict[str, Any] = {"quant": quant, "cached": False, "size_bytes": 0, "files": []}
                try:
                    talker, codec = resolve_gguf_paths(
                        model_id,
                        quant=quant,
                        cache_dir=os.environ.get("HF_HOME") or None,
                        local_files_only=True,
                    )
                    item.update(
                        cached=True,
                        files=[{"name": Path(talker).name, "size": _dir_size([Path(talker)])},
                               {"name": Path(codec).name, "size": _dir_size([Path(codec)])}],
                        size_bytes=_dir_size([Path(talker), Path(codec)]),
                    )
                except Exception:
                    item["cached"] = False
                entry["quants"].append(item)
            inventory.append(entry)
        return inventory

    def download(
        self,
        model_id: str,
        quant: str,
        progress: Callable[[dict[str, Any]], None] | None = None,
    ) -> list[str]:
        """Download GGUF talker + codec with coarse progress callbacks."""
        from huggingface_hub import hf_hub_download  # noqa: PLC0415

        from ..config import GGUF_REPO, GGUF_TALKER_STEM  # noqa: PLC0415

        if model_id not in GGUF_TALKER_STEM:
            raise EngineError(f"未知模型 {model_id}", "unknown_model")
        if quant not in QUANTS:
            raise EngineError(f"不支持的量化 {quant}", "unsupported_quant", "可选 BF16 / Q8_0 / Q4_K_M / F32")

        talker_name = f"{GGUF_TALKER_STEM[model_id]}-{quant}.gguf"
        codec_name = f"qwen-tokenizer-12hz-{quant}.gguf"
        cache_dir = os.environ.get("HF_HOME") or None
        out: list[str] = []
        for index, filename in enumerate((talker_name, codec_name)):
            if progress:
                progress({"stage": "downloading", "file": filename, "file_index": index, "file_count": 2, "percent": int(index * 50)})
            path = hf_hub_download(
                filename=filename,
                repo_id=GGUF_REPO,
                cache_dir=cache_dir,
                local_files_only=False,
            )
            out.append(path)
            if progress:
                progress({"stage": "downloading", "file": filename, "file_index": index, "file_count": 2, "percent": int((index + 1) * 50)})
        if progress:
            progress({"stage": "done", "percent": 100})
        return out

    def model_cached(self, model_id: str, quant: str | None = None) -> bool:
        """True when the weights for this model/quant are already on disk."""
        if self.backend != "ggml":
            return True  # torch 走 HuggingFace 缓存，加载时再报错
        from qwentts_cpp.models import resolve_gguf_paths  # noqa: PLC0415

        try:
            resolve_gguf_paths(
                model_id,
                quant=quant or self.settings.quant,
                cache_dir=os.environ.get("HF_HOME") or None,
                local_files_only=True,
            )
            return True
        except Exception:
            return False

    # ----------------------------------------------------------------- voices

    def prepare_voice(self, wav_path: Path, spk_path: Path, rvq_path: Path, *, load: bool = False) -> dict[str, Any]:
        engine = self.current()
        if engine is None or engine.model_id != MODEL_IDS["clone"] or engine.backend != "ggml":
            if not load:
                return {"supported": False, "reason": "克隆模型未驻留"}
            if not self.model_cached(MODEL_IDS["clone"]):
                raise EngineError(
                    "克隆模型尚未下载，无法预提取音色特征",
                    "model_not_cached",
                    "到「系统」页下载 Base 音色克隆模型后再试",
                )
            engine = self.ensure("clone")
        return engine.prepare_voice(wav_path, spk_path=spk_path, rvq_path=rvq_path)
