"""Audio helpers: WAV IO, resampling, PCM16 conversion, sentence splitting."""

from __future__ import annotations

import io
import math
import re
from pathlib import Path

import numpy as np

SAMPLE_RATE = 24000

_SENTENCE_RE = re.compile(r"(?<=[。！？!?；;\n])|(?<=[.]\s)")
_SOFT_BREAK_RE = re.compile(r"(?<=[，,、：:])\s*")


def to_mono_float32(audio: np.ndarray) -> np.ndarray:
    arr = np.asarray(audio, dtype=np.float32)
    if arr.ndim == 2:
        arr = arr.mean(axis=1 if arr.shape[1] < arr.shape[0] else 0)
    return np.ascontiguousarray(arr.reshape(-1))


def to_pcm16(audio: np.ndarray) -> bytes:
    clipped = np.clip(np.asarray(audio, dtype=np.float32), -1.0, 1.0)
    return (clipped * 32767.0).astype("<i2").tobytes()


def write_wav(path: Path, audio: np.ndarray, sample_rate: int = SAMPLE_RATE) -> float:
    import soundfile as sf  # noqa: PLC0415 - optional heavy import

    path.parent.mkdir(parents=True, exist_ok=True)
    data = to_mono_float32(audio)
    sf.write(str(path), data, sample_rate, subtype="PCM_16")
    return float(data.size) / float(sample_rate or SAMPLE_RATE)


def wav_bytes(audio: np.ndarray, sample_rate: int = SAMPLE_RATE) -> bytes:
    import soundfile as sf  # noqa: PLC0415

    buffer = io.BytesIO()
    sf.write(buffer, to_mono_float32(audio), sample_rate, format="WAV", subtype="PCM_16")
    return buffer.getvalue()


def read_audio(path: str | Path, target_rate: int = SAMPLE_RATE) -> tuple[np.ndarray, int]:
    """Load any audio file soundfile/librosa can read as mono float32 at target rate."""
    import soundfile as sf  # noqa: PLC0415

    data, rate = sf.read(str(path), dtype="float32", always_2d=False)
    audio = to_mono_float32(data)
    if rate != target_rate:
        audio = resample_linear(audio, rate, target_rate)
        rate = target_rate
    return audio, rate


def resample_linear(audio: np.ndarray, src_rate: int, dst_rate: int) -> np.ndarray:
    if src_rate == dst_rate or audio.size == 0:
        return audio
    duration = audio.size / float(src_rate)
    target_len = max(1, int(round(duration * dst_rate)))
    src_idx = np.linspace(0.0, audio.size - 1, num=target_len, dtype=np.float64)
    return np.interp(src_idx, np.arange(audio.size, dtype=np.float64), audio).astype(np.float32)


def concat(chunks: list[np.ndarray], sample_rate: int = SAMPLE_RATE, gap_ms: int = 0) -> np.ndarray:
    if not chunks:
        return np.zeros(0, dtype=np.float32)
    gap = np.zeros(int(sample_rate * gap_ms / 1000), dtype=np.float32) if gap_ms else None
    parts: list[np.ndarray] = []
    for index, chunk in enumerate(chunks):
        if gap is not None and index:
            parts.append(gap)
        parts.append(to_mono_float32(chunk))
    return np.concatenate(parts).astype(np.float32)


def split_sentences(text: str, max_chars: int = 600) -> list[str]:
    """Split long text into generation-sized segments, keeping punctuation."""
    text = text.strip()
    if not text:
        return []
    if len(text) <= max_chars:
        return [text]

    pieces = [piece.strip() for piece in _SENTENCE_RE.split(text) if piece and piece.strip()]
    segments: list[str] = []
    buffer = ""
    for piece in pieces:
        if len(piece) > max_chars:
            if buffer:
                segments.append(buffer)
                buffer = ""
            segments.extend(_hard_split(piece, max_chars))
            continue
        if len(buffer) + len(piece) <= max_chars:
            buffer += piece
        else:
            segments.append(buffer)
            buffer = piece
    if buffer:
        segments.append(buffer)
    return [segment for segment in segments if segment.strip()]


def _hard_split(text: str, max_chars: int) -> list[str]:
    parts: list[str] = []
    remaining = text
    while len(remaining) > max_chars:
        window = remaining[:max_chars]
        split_at = max(window.rfind(mark) for mark in "，,、 。") if any(mark in window for mark in "，,、 。") else -1
        split_at = split_at + 1 if split_at > max_chars // 3 else max_chars
        parts.append(remaining[:split_at])
        remaining = remaining[split_at:]
    if remaining:
        parts.append(remaining)
    return parts


def duration(audio: np.ndarray, sample_rate: int = SAMPLE_RATE) -> float:
    return float(np.asarray(audio).size) / float(sample_rate) if sample_rate else 0.0


def estimate_tokens(text: str) -> int:
    return int(math.ceil(len(text) * 1.6)) + 32
