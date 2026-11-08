"""Runtime configuration, platform detection and persisted settings."""

from __future__ import annotations

import json
import os
import platform
import sys
import threading
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path
from typing import Any

APP_NAME = "Qwen3-TTS Studio"

MODEL_IDS = {
    "custom": "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
    "design": "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign",
    "clone": "Qwen/Qwen3-TTS-12Hz-1.7B-Base",
}
MODEL_MODE = {v: k for k, v in MODEL_IDS.items()}
MODEL_LABELS = {
    MODEL_IDS["custom"]: "CustomVoice 内置音色",
    MODEL_IDS["design"]: "VoiceDesign 声音设计",
    MODEL_IDS["clone"]: "Base 音色克隆",
}
GGUF_TALKER_STEM = {
    MODEL_IDS["custom"]: "qwen-talker-1.7b-customvoice",
    MODEL_IDS["design"]: "qwen-talker-1.7b-voicedesign",
    MODEL_IDS["clone"]: "qwen-talker-1.7b-base",
}
GGUF_REPO = "Serveurperso/Qwen3-TTS-GGUF"
QUANTS = ("BF16", "Q8_0", "Q4_K_M", "F32")
LANGUAGES = (
    "Auto",
    "Chinese",
    "English",
    "French",
    "German",
    "Spanish",
    "Italian",
    "Portuguese",
    "Japanese",
    "Korean",
    "Russian",
    "Arabic",
)
# Fallback list used before the CustomVoice model is loaded; the engine reports the real list.
DEFAULT_SPEAKERS = (
    "serena",
    "aiden",
    "dylan",
    "eric",
    "ono_anna",
    "ryan",
    "sohee",
    "uncle_fu",
    "vivian",
)


def _env(name: str, default: Any = None) -> Any:
    return os.environ.get(f"QTS_{name}", default)


def _env_bool(name: str, default: bool) -> bool:
    raw = _env(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


@dataclass
class Settings:
    backend: str = "auto"  # auto | ggml | torch
    quant: str = "BF16"
    default_language: str = "Auto"
    chunk_size: int = 8
    max_queue: int = 8
    keep_model_loaded: bool = True
    max_resident: int = 1
    auth_required: bool = False
    host: str = "127.0.0.1"
    port: int = 8000
    auto_open_browser: bool = True
    split_long_text: bool = True
    long_text_threshold: int = 600
    temperature: float = 0.9
    top_k: int = 50
    top_p: float = 1.0
    repetition_penalty: float = 1.05
    max_new_tokens: int = 2048
    append_silence: bool = True
    data_dir: str = ""
    hf_endpoint: str = ""

    @classmethod
    def load(cls, data_dir: Path) -> "Settings":
        payload: dict[str, Any] = {}
        path = data_dir / "settings.json"
        if path.exists():
            try:
                payload = json.loads(path.read_text("utf-8"))
            except (OSError, ValueError):
                payload = {}
        known = {f.name for f in fields(cls)}
        payload = {k: v for k, v in payload.items() if k in known}

        overrides: dict[str, Any] = {
            "backend": _env("BACKEND"),
            "quant": _env("QUANT"),
            "host": _env("HOST"),
            "port": int(_env("PORT")) if _env("PORT") else None,
            "data_dir": _env("DATA_DIR"),
            "hf_endpoint": _env("HF_ENDPOINT"),
            "auth_required": _env_bool("AUTH_REQUIRED", False) if _env("AUTH_REQUIRED") else None,
            "keep_model_loaded": _env_bool("KEEP_MODEL_LOADED", True) if _env("KEEP_MODEL_LOADED") else None,
        }
        overrides = {k: v for k, v in overrides.items() if v is not None}
        payload.update(overrides)

        settings = cls(**payload)
        settings.data_dir = settings.data_dir or str(data_dir)
        if settings.quant not in QUANTS:
            settings.quant = "BF16"
        if settings.backend not in {"auto", "ggml", "torch"}:
            settings.backend = "auto"
        return settings

    def save(self, data_dir: Path) -> None:
        path = data_dir / "settings.json"
        payload = asdict(self)
        payload.pop("host", None)
        payload.pop("port", None)
        payload.pop("data_dir", None)
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), "utf-8")
        tmp.replace(path)


@dataclass
class Paths:
    root: Path
    audio: Path
    voices: Path
    uploads: Path
    logs: Path
    db: Path

    @classmethod
    def create(cls, root: Path) -> "Paths":
        audio = root / "audio"
        voices = root / "voices"
        uploads = root / "uploads"
        logs = root / "logs"
        for path in (root, audio, voices, uploads, logs):
            path.mkdir(parents=True, exist_ok=True)
        return cls(root=root, audio=audio, voices=voices, uploads=uploads, logs=logs, db=root / "studio.db")


def resolve_data_dir(explicit: str | Path | None = None) -> Path:
    candidate = explicit or _env("DATA_DIR") or Path.cwd() / "data"
    return Path(candidate).expanduser().resolve()


@dataclass
class RuntimeInfo:
    system: str
    machine: str
    python: str
    backend: str
    device: str
    gpu: str
    torch_version: str | None
    qwentts_version: str | None
    ggml_available: bool
    torch_available: bool
    warnings: list[str] = field(default_factory=list)


_runtime_cache: RuntimeInfo | None = None
_runtime_lock = threading.Lock()


def _probe_torch() -> tuple[str | None, bool, str]:
    try:
        import torch  # noqa: PLC0415 - heavy import, keep lazy
    except Exception:  # pragma: no cover - torch is a hard dependency but may be broken
        return None, False, ""
    try:
        if torch.cuda.is_available():
            name = torch.cuda.get_device_name(0)
            return torch.__version__, True, name
    except Exception:
        pass
    return torch.__version__, False, ""


def _probe_ggml() -> tuple[str | None, bool]:
    try:
        import qwentts_cpp  # noqa: PLC0415 - native library, keep lazy
    except Exception:
        return None, False
    return getattr(qwentts_cpp, "__version__", None), True


def resolve_backend(preference: str) -> str:
    """Map the configured preference to a concrete backend for this machine."""
    system = platform.system()
    if preference in {"ggml", "torch"}:
        return preference
    if system == "Darwin":
        return "ggml"
    if system == "Windows":
        return "torch"
    _, cuda, _ = _probe_torch()
    if cuda:
        return "torch"
    _, ggml_ok = _probe_ggml()
    return "ggml" if ggml_ok else "torch"


def runtime_info(preference: str = "auto", refresh: bool = False) -> RuntimeInfo:
    global _runtime_cache
    with _runtime_lock:
        if _runtime_cache is not None and not refresh:
            return _runtime_cache

        system = platform.system()
        machine = platform.machine()
        torch_version, cuda, gpu_name = _probe_torch()
        qwentts_version, ggml_ok = _probe_ggml()
        backend = resolve_backend(preference)
        warnings: list[str] = []

        if backend == "ggml" and not ggml_ok:
            warnings.append("ggml 后端不可用：未检测到 qwentts-cpp-python（Windows 无官方 wheel，请改用 torch 后端）")
        if backend == "torch" and not torch_version:
            warnings.append("torch 后端不可用：未能导入 torch")
        if backend == "torch" and torch_version and not cuda and system != "Darwin":
            warnings.append("未检测到可用 CUDA，torch 后端将回落到 CPU，速度会明显变慢")

        if backend == "ggml":
            device = "metal" if system == "Darwin" else ("cuda" if cuda else "cpu")
        else:
            device = "cuda" if cuda else "cpu"

        _runtime_cache = RuntimeInfo(
            system=system,
            machine=machine,
            python=sys.version.split()[0],
            backend=backend,
            device=device,
            gpu=gpu_name or ("Apple Silicon" if system == "Darwin" and machine == "arm64" else "CPU"),
            torch_version=torch_version,
            qwentts_version=qwentts_version,
            ggml_available=ggml_ok,
            torch_available=bool(torch_version),
            warnings=warnings,
        )
        return _runtime_cache


def reset_runtime_cache() -> None:
    global _runtime_cache
    with _runtime_lock:
        _runtime_cache = None
