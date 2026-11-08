import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError } from "@/lib/api";
import type { SpeechRequest, StreamError, StreamMetrics, StreamResult, StreamStatus } from "@/lib/types";

const SAMPLE_RATE = 24000;

class PcmPlayer {
  private ctx: AudioContext | null = null;
  private playhead = 0;
  private sources = new Set<AudioBufferSourceNode>();
  readonly sampleRate: number;

  constructor(sampleRate = SAMPLE_RATE) {
    this.sampleRate = sampleRate;
  }

  private ensure(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: this.sampleRate });
      this.playhead = 0;
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
  }

  push(buffer: ArrayBuffer) {
    const ctx = this.ensure();
    const samples = new Int16Array(buffer);
    if (!samples.length) return;
    const audioBuffer = ctx.createBuffer(1, samples.length, this.sampleRate);
    const channel = audioBuffer.getChannelData(0);
    for (let i = 0; i < samples.length; i += 1) channel[i] = samples[i] / 32768;
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);
    const startAt = Math.max(ctx.currentTime + 0.08, this.playhead);
    source.start(startAt);
    this.playhead = startAt + audioBuffer.duration;
    this.sources.add(source);
    source.onended = () => this.sources.delete(source);
  }

  stop() {
    this.sources.forEach((source) => {
      try {
        source.stop();
      } catch {
        /* already stopped */
      }
    });
    this.sources.clear();
    this.playhead = 0;
  }

  async close() {
    this.stop();
    if (this.ctx) {
      try {
        await this.ctx.close();
      } catch {
        /* ignore */
      }
      this.ctx = null;
    }
  }
}

function wsUrl() {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const key = localStorage.getItem("qts_api_key");
  return `${protocol}://${location.host}/api/v1/ws/tts${key ? `?api_key=${encodeURIComponent(key)}` : ""}`;
}

const ACTIVE: StreamStatus[] = ["connecting", "queued", "loading", "streaming"];

export function useTts() {
  const [status, setStatus] = useState<StreamStatus>("idle");
  const [metrics, setMetrics] = useState<StreamMetrics>({ audioSeconds: 0, chunks: 0 });
  const [result, setResult] = useState<StreamResult | null>(null);
  const [error, setError] = useState<StreamError | null>(null);
  const [segments, setSegments] = useState<{ index: number; total: number } | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const playerRef = useRef<PcmPlayer | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const statusRef = useRef<StreamStatus>("idle");

  const setBoth = useCallback((next: StreamStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const cleanup = useCallback(async () => {
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws && ws.readyState <= WebSocket.OPEN) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    abortRef.current?.abort();
    abortRef.current = null;
    await playerRef.current?.close();
    playerRef.current = null;
  }, []);

  const reset = useCallback(() => {
    void cleanup();
    setBoth("idle");
    setMetrics({ audioSeconds: 0, chunks: 0 });
    setResult(null);
    setError(null);
    setSegments(null);
  }, [cleanup, setBoth]);

  const stop = useCallback(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "cancel" }));
    }
    abortRef.current?.abort();
    playerRef.current?.stop();
    setBoth("cancelled");
  }, [setBoth]);

  const start = useCallback(
    async (request: SpeechRequest, options?: { streaming?: boolean }) => {
      if (ACTIVE.includes(statusRef.current)) return;
      await cleanup();
      setError(null);
      setResult(null);
      setSegments(null);
      setMetrics({ audioSeconds: 0, chunks: 0 });

      if (options?.streaming === false) {
        setBoth("loading");
        const controller = new AbortController();
        abortRef.current = controller;
        try {
          const response = await fetch("/api/v1/tts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(request),
            signal: controller.signal,
          });
          if (!response.ok) {
            const payload = (await response.json().catch(() => null)) as
              | { detail?: { code?: string; message?: string; hint?: string } }
              | null;
            const detail = payload?.detail;
            throw new ApiError(detail?.message ?? "生成失败", detail?.code ?? "generation_failed", response.status, detail?.hint);
          }
          const blob = await response.blob();
          const historyId = response.headers.get("X-History-Id") ?? "";
          const duration = Number(response.headers.get("X-Duration") ?? 0);
          const ttfa = Number(response.headers.get("X-Ttfa-Ms") ?? 0);
          const rtf = Number(response.headers.get("X-Rtf") ?? 0);
          const url = historyId ? `/api/v1/history/${historyId}/audio` : URL.createObjectURL(blob);
          setResult({ recordId: historyId, audioUrl: url, durationS: duration, ttfaMs: ttfa, rtf: rtf || undefined });
          setMetrics({ audioSeconds: duration, chunks: 0, ttfaMs: ttfa, rtf: rtf || undefined });
          setBoth("done");
          const audio = new Audio(URL.createObjectURL(blob));
          void audio.play().catch(() => undefined);
        } catch (err) {
          if ((err as Error).name === "AbortError") {
            setBoth("idle");
            return;
          }
          const apiError = err as ApiError;
          setError({ code: apiError.code ?? "generation_failed", message: apiError.message, hint: apiError.hint });
          setBoth("error");
        }
        return;
      }

      setBoth("connecting");
      const player = new PcmPlayer();
      playerRef.current = player;
      let sampleRate = SAMPLE_RATE;
      let audioSeconds = 0;
      // 端到端首包：从点击到第一帧 PCM 到达（服务端 ttfa 只统计原生推理段）
      const startedAt = performance.now();
      let firstChunk = true;

      const ws = new WebSocket(wsUrl());
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "start", request }));
      };

      ws.onmessage = (event) => {
        if (typeof event.data !== "string") {
          const buffer = event.data as ArrayBuffer;
          player.push(buffer);
          audioSeconds += buffer.byteLength / 2 / sampleRate;
          const measured = firstChunk ? Math.round(performance.now() - startedAt) : 0;
          firstChunk = false;
          setMetrics((prev) => ({
            ...prev,
            audioSeconds,
            chunks: prev.chunks + 1,
            ttfaMs: prev.ttfaMs || measured || undefined,
          }));
          return;
        }
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(event.data) as Record<string, unknown>;
        } catch {
          return;
        }
        const type = payload.type as string;
        if (type === "accepted") {
          setMetrics((prev) => ({
            ...prev,
            queuePosition: (payload.queue as { queued?: number } | undefined)?.queued ?? 0,
          }));
        } else if (type === "queued") {
          setBoth("queued");
          setMetrics((prev) => ({ ...prev, queuePosition: Number(payload.queue_position ?? 0) }));
        } else if (type === "loading") {
          setBoth("loading");
        } else if (type === "meta") {
          sampleRate = Number(payload.sample_rate ?? SAMPLE_RATE);
          setBoth("streaming");
          setMetrics((prev) => ({
            ...prev,
            sampleRate,
            model: payload.model as string,
            backend: payload.backend as string,
            quant: payload.quant as string,
          }));
        } else if (type === "segments") {
          setSegments({ index: 0, total: Number(payload.count ?? 1) });
        } else if (type === "stats") {
          setBoth("streaming");
          setMetrics((prev) => ({
            ...prev,
            audioSeconds: Number(payload.audio_s ?? prev.audioSeconds),
            rtf: payload.rtf as number | undefined,
          }));
          if (payload.segments) {
            setSegments({ index: Number(payload.segment ?? 0), total: Number(payload.segments ?? 1) });
          }
        } else if (type === "done") {
          const audioUrl = payload.audio_url as string | null;
          setResult({
            recordId: payload.record_id as string | undefined,
            audioUrl: audioUrl ?? undefined,
            durationS: Number(payload.duration_s ?? 0),
            sampleRate,
            ttfaMs: Number(payload.ttfa_ms ?? 0),
            rtf: payload.rtf as number | undefined,
            chunks: Number(payload.chunks ?? 0),
          });
          setMetrics((prev) => ({ ...prev, ttfaMs: Number(payload.ttfa_ms ?? 0), rtf: payload.rtf as number | undefined }));
          setBoth("done");
          ws.close();
        } else if (type === "error") {
          setError({ code: String(payload.code ?? "error"), message: String(payload.message ?? "生成失败"), hint: payload.hint as string });
          setBoth("error");
          ws.close();
        } else if (type === "cancelled") {
          setBoth("cancelled");
          ws.close();
        }
      };

      ws.onerror = () => {
        setError({ code: "socket_error", message: "与后端的连接中断", hint: "确认后端仍在运行，然后重试" });
        setBoth("error");
      };

      ws.onclose = () => {
        if (statusRef.current === "streaming" || statusRef.current === "loading" || statusRef.current === "queued") {
          setBoth("cancelled");
        }
      };
    },
    [cleanup, setBoth],
  );

  useEffect(() => {
    return () => {
      void cleanup();
    };
  }, [cleanup]);

  return {
    status,
    metrics,
    result,
    error,
    segments,
    start,
    stop,
    reset,
    isBusy: ACTIVE.includes(status),
  };
}
