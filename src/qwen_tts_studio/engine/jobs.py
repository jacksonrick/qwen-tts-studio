"""Single-worker generation queue with cancellation and event broadcasting."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import queue
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator

import numpy as np

from ..config import Settings
from ..store.history import HistoryRepo
from .audio import SAMPLE_RATE, concat, duration as audio_duration, split_sentences, write_wav
from .base import EngineError, GenParams
from .manager import ModelManager

logger = logging.getLogger(__name__)

# 每个任务最多缓存多少条待下发事件（音频帧 + 统计）。超过说明下游没在读，
# 继续堆积只会把 PCM 留在内存里，因此直接判定客户端过慢并终止任务。
EVENT_QUEUE_MAX = 96


class JobCancelled(Exception):
    pass


@dataclass
class Job:
    id: str
    params: GenParams
    model_id: str
    loop: asyncio.AbstractEventLoop
    mode: str
    voice_id: str | None = None
    streaming: bool = True
    status: str = "queued"
    cancel_event: threading.Event = field(default_factory=threading.Event)
    events: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=EVENT_QUEUE_MAX))
    done: asyncio.Future | None = None
    created_at: float = field(default_factory=time.time)
    started_at: float | None = None
    finished_at: float | None = None
    record_id: str | None = None
    error: dict[str, Any] | None = None
    overflow: bool = False

    def emit(self, event: dict[str, Any]) -> None:
        try:
            self.loop.call_soon_threadsafe(self._push, event)
        except RuntimeError:
            pass

    def _push(self, event: dict[str, Any]) -> None:
        """Runs on the event loop thread; bounded so a stalled consumer cannot eat RAM."""
        if self.overflow:
            # 已经判定客户端过慢：音频与统计再进来也没人听，只放行终态事件
            if event.get("type") in {"audio", "stats"}:
                return
        try:
            self.events.put_nowait(event)
        except asyncio.QueueFull:
            self._abort_overflow()

    def _abort_overflow(self) -> None:
        if self.overflow:
            return
        self.overflow = True
        self.cancel_event.set()
        # 丢掉积压的 PCM，换成一条明确的错误，让客户端立刻知道发生了什么
        while True:
            try:
                self.events.get_nowait()
            except asyncio.QueueEmpty:
                break
        with contextlib.suppress(asyncio.QueueFull):
            self.events.put_nowait(
                {
                    "type": "error",
                    "code": "client_too_slow",
                    "message": "下游读取音频太慢，已终止本次生成",
                    "hint": "降低流式分段大小、检查网络，或改用非流式接口",
                }
            )

    def drain_events(self) -> None:
        while True:
            try:
                self.events.get_nowait()
            except asyncio.QueueEmpty:
                return

    def release_result(self) -> None:
        """Drop the finished result (it holds the whole waveform) once the caller copied it."""
        self.done = None

    def emit_audio(self, data: bytes, index: int, audio_seconds: float) -> None:
        self.emit({"type": "audio", "data": data, "index": index, "audio_s": audio_seconds})

    def cancelled(self) -> bool:
        return self.cancel_event.is_set()


class JobRunner:
    """Serialises inference on one background thread (native runtime is single-tenant)."""

    def __init__(self, manager: ModelManager, settings: Settings, paths: Any, history: HistoryRepo):
        self.manager = manager
        self.settings = settings
        self.paths = paths
        self.history = history
        self._queue: queue.Queue[Job | None] = queue.Queue(maxsize=max(1, int(settings.max_queue)))
        self._jobs: dict[str, Job] = {}
        self._lock = threading.RLock()
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()

    # --------------------------------------------------------------- lifecycle

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._worker, name="tts-worker", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        try:
            self._queue.put_nowait(None)
        except queue.Full:
            pass
        if self._thread:
            self._thread.join(timeout=5)

    def _worker(self) -> None:
        while not self._stop.is_set():
            try:
                job = self._queue.get(timeout=0.5)
            except queue.Empty:
                continue
            if job is None:
                break
            try:
                self._run(job)
            except Exception:  # noqa: BLE001 - worker must survive
                logger.exception("job crashed: %s", job.id)
            finally:
                self._queue.task_done()

    # ------------------------------------------------------------------- public

    def submit(
        self,
        params: GenParams,
        *,
        model_id: str,
        loop: asyncio.AbstractEventLoop,
        streaming: bool = True,
        voice_id: str | None = None,
    ) -> Job:
        job = Job(
            id=uuid.uuid4().hex[:16],
            params=params,
            model_id=model_id,
            loop=loop,
            mode=params.mode,
            voice_id=voice_id,
            streaming=streaming,
            done=loop.create_future(),
        )
        with self._lock:
            self._jobs[job.id] = job
            if len(self._jobs) > 64:
                for old_id, old in list(self._jobs.items())[:-64]:
                    if old.status in {"done", "error", "cancelled"}:
                        self._jobs.pop(old_id, None)
                        # 已完成任务的事件队列可能还压着没人读的 PCM，一并释放
                        old.drain_events()
                        old.done = None
        try:
            self._queue.put_nowait(job)
        except queue.Full as exc:
            with self._lock:
                self._jobs.pop(job.id, None)
            raise EngineError(
                f"队列已满（上限 {self.settings.max_queue}）",
                "queue_full",
                "等待当前任务完成，或在系统页调大队列长度",
            ) from exc
        position = self._queue.qsize()
        job.emit({"type": "queued", "job_id": job.id, "queue_position": max(0, position - 1)})
        return job

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self._jobs.get(job_id)

    def cancel(self, job_id: str) -> bool:
        job = self.get(job_id)
        if job is None:
            return False
        job.cancel_event.set()
        job.emit({"type": "cancelling", "job_id": job_id})
        return True

    def summary(self) -> dict[str, Any]:
        with self._lock:
            active = [job for job in self._jobs.values() if job.status == "running"]
            queued = [job for job in self._jobs.values() if job.status == "queued"]
        return {
            "queue_size": self._queue.qsize(),
            "max_queue": self.settings.max_queue,
            "running": len(active),
            "queued": len(queued),
            "worker_alive": bool(self._thread and self._thread.is_alive()),
        }

    # --------------------------------------------------------------------- run

    def _run(self, job: Job) -> None:
        job.status = "running"
        job.started_at = time.time()
        params = job.params
        model = job.model_id
        started = time.perf_counter()
        gen_started: float | None = None  # 模型加载完成后再计时，RTF 只统计生成耗时
        collected: list[np.ndarray] = []
        chunk_count = 0
        audio_seconds = 0.0
        first_chunk_ms: float | None = None
        sample_rate = SAMPLE_RATE
        cancelled = False
        engine: Any = None
        error: dict[str, Any] | None = None

        try:
            if job.cancelled():
                raise JobCancelled
            job.emit({"type": "loading", "model": model, "resident": self.manager.current_model_id() == model})
            engine = self.manager.ensure(model_id=model)
            gen_started = time.perf_counter()
            sample_rate = engine.sample_rate
            job.emit(
                {
                    "type": "meta",
                    "job_id": job.id,
                    "model": model,
                    "mode": params.mode,
                    "quant": engine.quant,
                    "backend": engine.backend,
                    "sample_rate": sample_rate,
                    "format": "s16le",
                    "channels": 1,
                    "chunk_size": params.chunk_size,
                }
            )

            segments = self._segments(params.text)
            job.emit({"type": "segments", "count": len(segments)})
            for segment_index, segment in enumerate(segments):
                if job.cancelled():
                    raise JobCancelled
                segment_params = self._with_text(params, segment)
                if job.streaming:
                    stream = engine.stream(segment_params)
                    try:
                        for chunk in stream:
                            if job.cancelled():
                                raise JobCancelled
                            if first_chunk_ms is None:
                                first_chunk_ms = (time.perf_counter() - started) * 1000
                            collected.append(chunk.audio)
                            chunk_count += 1
                            audio_seconds += audio_duration(chunk.audio, chunk.sample_rate)
                            job.emit_audio(_pcm16(chunk.audio), chunk_count - 1, round(audio_seconds, 3))
                            job.emit(
                                {
                                    "type": "stats",
                                    "chunk_index": chunk_count - 1,
                                    "audio_s": round(audio_seconds, 3),
                                    "elapsed_ms": round((time.perf_counter() - started) * 1000, 1),
                                    "rtf": _rtf(audio_seconds, gen_started or started),
                                    "segment": segment_index,
                                    "segments": len(segments),
                                }
                            )
                    finally:
                        if hasattr(stream, "close"):
                            stream.close()
                else:
                    audio, rate = engine.generate(segment_params)
                    sample_rate = int(rate or sample_rate)
                    collected.append(audio)
                    audio_seconds += audio_duration(audio, sample_rate)

            if job.cancelled():
                raise JobCancelled

        except JobCancelled:
            cancelled = True
        except EngineError as exc:
            error = {"code": exc.code, "message": str(exc), "hint": exc.hint}
        except Exception as exc:  # noqa: BLE001 - report to client
            logger.exception("generation failed: %s", job.id)
            error = {"code": "generation_failed", "message": f"{type(exc).__name__}: {exc}", "hint": "查看服务端日志"}

        elapsed = time.perf_counter() - started
        audio = concat(collected) if collected else np.zeros(0, dtype=np.float32)
        total_seconds = audio_duration(audio, sample_rate)

        if error is None and job.overflow:
            error = {
                "code": "client_too_slow",
                "message": "下游读取音频太慢，已终止本次生成",
                "hint": "降低流式分段大小、检查网络，或改用非流式接口",
            }

        if error is not None:
            job.status = "error"
            job.error = error
            # 背压场景下客户端已经收到过 client_too_slow，不用再重复发一条
            if not job.overflow:
                job.emit({"type": "error", **error})
        elif cancelled and total_seconds <= 0.05:
            job.status = "cancelled"
            job.emit({"type": "cancelled", "job_id": job.id})
        else:
            job.status = "cancelled" if cancelled else "done"

        job.finished_at = time.time()

        record_id = None
        audio_url = None
        if total_seconds > 0.05 and (job.status in {"done", "cancelled"}):
            record_id = job.id
            path = self._audio_path(job)
            write_wav(path, audio, sample_rate)
            record = {
                "id": record_id,
                "mode": params.mode,
                "model": model,
                "quant": getattr(engine, "quant", None),
                "backend": self.manager.backend,
                "text": params.text,
                "language": params.language,
                "params_json": _params_json(params, voice_id=job.voice_id),
                "voice_id": job.voice_id,
                "audio_path": str(path),
                "duration_s": round(total_seconds, 3),
                "sample_rate": sample_rate,
                "ttfa_ms": int(first_chunk_ms) if first_chunk_ms else int(elapsed * 1000),
                "rtf": _rtf(total_seconds, gen_started or started),
                "status": job.status,
                "created_at": int(job.created_at),
            }
            self.history.add(record)
            job.record_id = record_id
            audio_url = f"/api/v1/history/{record_id}/audio"
        elif error is not None:
            record_id = job.id
            self.history.add(
                {
                    "id": record_id,
                    "mode": params.mode,
                    "model": model,
                    "quant": self.settings.quant,
                    "backend": self.manager.backend,
                    "text": params.text,
                    "language": params.language,
                    "params_json": _params_json(params, voice_id=job.voice_id),
                    "voice_id": job.voice_id,
                    "status": "error",
                    "error": error.get("message"),
                    "ttfa_ms": int(elapsed * 1000),
                    "created_at": int(job.created_at),
                }
            )

        if job.status in {"done", "cancelled"}:
            job.emit(
                {
                    "type": "done",
                    "job_id": job.id,
                    "record_id": record_id,
                    "audio_url": audio_url,
                    "duration_s": round(total_seconds, 3),
                    "sample_rate": sample_rate,
                    "ttfa_ms": int(first_chunk_ms) if first_chunk_ms else int(elapsed * 1000),
                    "rtf": _rtf(total_seconds, gen_started or started),
                    "chunks": chunk_count,
                    "cancelled": cancelled,
                    "elapsed_ms": round(elapsed * 1000, 1),
                }
            )

        if job.done and not job.done.done():
            try:
                job.loop.call_soon_threadsafe(
                    job.done.set_result,
                    {
                        "job_id": job.id,
                        "record_id": record_id,
                        "audio_url": audio_url,
                        "status": job.status,
                        "error": error,
                        "duration_s": total_seconds,
                        "ttfa_ms": int(first_chunk_ms) if first_chunk_ms else int(elapsed * 1000),
                        "rtf": _rtf(total_seconds, gen_started or started),
                        "sample_rate": sample_rate,
                        "chunks": chunk_count,
                        # 流式任务的声音已经逐帧下发，没必要再把整段波形挂在 Future 上占内存
                        "audio": audio if not job.streaming else None,
                    },
                )
            except RuntimeError:
                pass

    # ------------------------------------------------------------------ helpers

    def _segments(self, text: str) -> list[str]:
        if not self.settings.split_long_text:
            return [(text or "").strip() or " "]
        return split_sentences(text, self.settings.long_text_threshold) or [" "]

    def _with_text(self, params: GenParams, text: str) -> GenParams:
        clone = GenParams(**{**params.__dict__, "text": text})
        return clone

    def _audio_path(self, job: Job) -> Path:
        stamp = time.localtime(job.created_at)
        folder = self.paths.audio / time.strftime("%Y", stamp) / time.strftime("%m", stamp) / time.strftime("%d", stamp)
        folder.mkdir(parents=True, exist_ok=True)
        return folder / f"{job.id}.wav"


def _pcm16(audio: np.ndarray) -> bytes:
    clipped = np.clip(np.asarray(audio, dtype=np.float32).reshape(-1), -1.0, 1.0)
    return (clipped * 32767.0).astype("<i2").tobytes()


def _rtf(audio_seconds: float, started: float) -> float | None:
    """Real time factor = 处理耗时 / 音频时长（< 1 表示快于实时）。"""
    elapsed = time.perf_counter() - started
    if elapsed <= 0 or audio_seconds <= 0:
        return None
    return round(elapsed / audio_seconds, 2)


def _params_json(params: GenParams, *, voice_id: str | None) -> str:
    import json  # noqa: PLC0415

    payload = {
        "language": params.language,
        "speaker": params.speaker,
        "instruct": params.instruct,
        "xvec_only": params.xvec_only,
        "ref_text": params.ref_text,
        "temperature": params.temperature,
        "top_k": params.top_k,
        "top_p": params.top_p,
        "repetition_penalty": params.repetition_penalty,
        "max_new_tokens": params.max_new_tokens,
        "chunk_size": params.chunk_size,
        "append_silence": params.append_silence,
        "non_streaming_mode": params.non_streaming_mode,
        "voice_id": voice_id,
    }
    return json.dumps(payload, ensure_ascii=False)
