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
_CJK_RE = re.compile(r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]")


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
        audio = resample(audio, rate, target_rate)
        rate = target_rate
    return audio, rate


def resample(audio: np.ndarray, src_rate: int, dst_rate: int) -> np.ndarray:
    """Resample with a polyphase filter; falls back to linear interpolation.

    Linear interpolation is aliasing-prone when downsampling (44.1k -> 24k folds
    everything above 12k back into the audible band), and reference audio feeds both
    the speaker encoder and the ICL context, so the grit hurts similarity too.
    """
    if src_rate == dst_rate or audio.size == 0:
        return audio
    try:
        import soxr  # noqa: PLC0415 - shipped with librosa, optional
    except Exception:  # noqa: BLE001
        return resample_linear(audio, src_rate, dst_rate)
    try:
        out = soxr.resample(audio, src_rate, dst_rate, quality="HQ")
    except Exception:  # noqa: BLE001 - never fail a request over resampling
        return resample_linear(audio, src_rate, dst_rate)
    return np.ascontiguousarray(out, dtype=np.float32)


def resample_linear(audio: np.ndarray, src_rate: int, dst_rate: int) -> np.ndarray:
    if src_rate == dst_rate or audio.size == 0:
        return audio
    duration = audio.size / float(src_rate)
    target_len = max(1, int(round(duration * dst_rate)))
    src_idx = np.linspace(0.0, audio.size - 1, num=target_len, dtype=np.float64)
    return np.interp(src_idx, np.arange(audio.size, dtype=np.float64), audio).astype(np.float32)


def limit_seconds(
    audio: np.ndarray,
    max_seconds: float,
    sample_rate: int = SAMPLE_RATE,
    search_seconds: float = 1.5,
    frame_ms: float = 20.0,
    fade_ms: float = 12.0,
) -> tuple[np.ndarray, bool]:
    """Trim `audio` to `max_seconds`, cutting at a quiet point instead of mid-phoneme.

    ICL cloning uses the reference audio as context: a cut in the middle of a syllable
    makes the model complete that half sound first, which shows up as a glitch at the
    start of every generation. Search the last `search_seconds` of the allowed window
    for the lowest-energy frame and cut at its center, then fade out briefly.
    """
    max_samples = int(max_seconds * sample_rate)
    if audio.size <= max_samples:
        return audio, False

    start = max(0, max_samples - int(search_seconds * sample_rate))
    frame = max(1, int(frame_ms / 1000.0 * sample_rate))
    segment = audio[start:max_samples]
    frames = segment.size // frame
    cut = max_samples
    if frames >= 1:
        blocks = segment[: frames * frame].reshape(frames, frame).astype(np.float64)
        energies = np.sqrt((blocks**2).mean(axis=1))
        quietest = float(energies.min())
        # 静音底噪相近时优先取最靠后的那一帧，尽量把 30 秒用满。
        threshold = quietest * 2.0 + 1e-5
        candidates = np.flatnonzero(energies <= threshold)
        best = int(candidates[-1]) if candidates.size else int(np.argmin(energies))
        cut = min(max_samples, start + best * frame + frame // 2)
    trimmed = audio[:cut].copy()
    fade = min(int(fade_ms / 1000.0 * sample_rate), trimmed.size)
    if fade > 1:
        trimmed[-fade:] *= np.linspace(1.0, 0.0, fade, dtype=np.float32)
    return trimmed, True


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


def estimate_speech_seconds(text: str) -> float:
    """Rough normal-speed duration estimate: CJK ~0.22s/char, everything else ~0.07s/char."""
    text = text or ""
    cjk = len(_CJK_RE.findall(text))
    other = len(re.sub(r"\s+", "", text)) - cjk
    return max(0.0, cjk * 0.22 + other * 0.07)


def fit_text_to_seconds(text: str, seconds: float, *, slack: float = 1.1) -> str:
    """Trim `text` down to the part that roughly fills `seconds` of speech.

    Used to keep a clone reference transcript aligned with its (possibly truncated)
    reference audio: ICL cloning echoes the reference when the two disagree.
    """
    text = (text or "").strip()
    if not text or seconds <= 0:
        return text
    if estimate_speech_seconds(text) <= seconds * slack:
        return text

    pieces = [piece for piece in _SENTENCE_RE.split(text) if piece and piece.strip()]
    if len(pieces) <= 1:
        return text

    kept = ""
    for piece in pieces:
        previous = kept
        kept += piece
        if estimate_speech_seconds(kept) >= seconds:
            if previous and abs(estimate_speech_seconds(previous) - seconds) <= abs(estimate_speech_seconds(kept) - seconds):
                return previous.strip() or kept.strip()
            return kept.strip()
    return kept.strip() or text
