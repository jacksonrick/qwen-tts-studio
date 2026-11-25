import type {
  ApiKeyRecord,
  HistoryRecord,
  ModelEntry,
  ModelStatus,
  Settings,
  SpeechRequest,
  SystemInfo,
  Voice,
} from "./types";

const BASE = "/api/v1";

export class ApiError extends Error {
  code: string;
  hint?: string | null;
  status: number;

  constructor(message: string, code = "request_failed", status = 500, hint?: string | null) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.status = status;
  }
}

function authHeaders(): Record<string, string> {
  const key = localStorage.getItem("qts_api_key");
  return key ? { "X-API-Key": key } : {};
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...authHeaders(),
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    const detail = (payload as { detail?: unknown; error?: unknown } | null)?.detail ??
      (payload as { error?: unknown } | null)?.error;
    if (detail && typeof detail === "object") {
      const record = detail as { code?: string; message?: string; hint?: string };
      throw new ApiError(record.message ?? response.statusText, record.code ?? "request_failed", response.status, record.hint);
    }
    if (typeof detail === "string") {
      throw new ApiError(detail, "request_failed", response.status);
    }
    throw new ApiError(response.statusText || "请求失败", "request_failed", response.status);
  }
  if (response.status === 204) return undefined as T;
  const type = response.headers.get("content-type") ?? "";
  if (type.includes("application/json")) return (await response.json()) as T;
  return (await response.blob()) as unknown as T;
}

export const api = {
  info: () => request<SystemInfo>("/system/info"),
  models: () => request<{ backend: string; quant: string; models: ModelEntry[]; status: ModelStatus }>("/system/models"),
  loadModel: (modelId: string, quant?: string) =>
    request<{ model_id: string; backend: string; quant: string; speakers: string[] }>(
      `/system/models/load?model_id=${encodeURIComponent(modelId)}${quant ? `&quant=${quant}` : ""}`,
      { method: "POST" },
    ),
  unloadModel: (modelId?: string) =>
    request<ModelStatus>(`/system/models/unload${modelId ? `?model_id=${encodeURIComponent(modelId)}` : ""}`, {
      method: "POST",
    }),
  queue: () =>
    request<{ queue_size: number; max_queue: number; running: number; queued: number; worker_alive: boolean }>(
      "/system/queue",
    ),
  logs: (tail = 200) => request<Blob>(`/system/logs?tail=${tail}`),
  clearLogs: () => request<{ ok: boolean; path: string }>("/system/logs", { method: "DELETE" }),
  selftest: (mode: string) =>
    request<{ ok: boolean; duration_s?: number; ttfa_ms?: number; audio_url?: string; error?: { message: string } }>(
      `/system/selftest?mode=${mode}`,
      { method: "POST" },
    ),

  settings: () => request<{ settings: Settings; options: { backends: string[]; quants: string[]; languages: string[] } }>("/settings"),
  updateSettings: (patch: Partial<Settings>) =>
    request<{ settings: Settings }>("/settings", { method: "PUT", body: JSON.stringify(patch) }),

  speakers: (model?: string) =>
    request<{ model: string; speakers: string[]; loaded: boolean }>(`/speakers${model ? `?model=${encodeURIComponent(model)}` : ""}`),
  languages: () => request<{ languages: string[] }>("/languages"),

  voices: (params?: { query?: string; kind?: string; language?: string }) => {
    const search = new URLSearchParams();
    if (params?.query) search.set("query", params.query);
    if (params?.kind) search.set("kind", params.kind);
    if (params?.language) search.set("language", params.language);
    const qs = search.toString();
    return request<{ items: Voice[]; total: number }>(`/voices${qs ? `?${qs}` : ""}`);
  },
  createVoice: (form: FormData) =>
    request<{
      voice: Voice;
      duration_s: number;
      source_duration_s?: number;
      truncated?: boolean;
      ref_text_trimmed?: boolean;
      instruct_ignored?: boolean;
      prepared: Record<string, unknown>;
    }>("/voices", { method: "POST", body: form }),
  updateVoice: (id: string, patch: Partial<Voice>) => request<Voice>(`/voices/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteVoice: (id: string) => request<{ deleted: string }>(`/voices/${id}`, { method: "DELETE" }),
  prepareVoice: (id: string) =>
    request<{
      prepared: { supported?: boolean; saved?: boolean; reason?: string; frames?: number; sample_rate?: number };
      voice: Voice;
    }>(`/voices/${id}/prepare`, { method: "POST" }),
  sampleVoice: async (id: string, text: string, language: string) => {
    const response = await fetch(`${BASE}/voices/${id}/sample`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ text, language }),
    });
    if (!response.ok) throw new ApiError("试音失败", "sample_failed", response.status);
    return response.blob();
  },
  voiceAudioUrl: (id: string) => `${BASE}/voices/${id}/audio`,
  voiceExportUrl: (id: string) => `${BASE}/voices/${id}/export`,

  history: (params: { page?: number; page_size?: number; mode?: string; status?: string; query?: string }) => {
    const search = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
    });
    return request<{ items: HistoryRecord[]; total: number; page: number; page_size: number }>(`/history?${search.toString()}`);
  },
  historyRecord: (id: string) => request<HistoryRecord>(`/history/${id}`),
  deleteHistory: (id: string) => request<{ deleted: string }>(`/history/${id}`, { method: "DELETE" }),
  historyPreview: (before: number) =>
    request<{ before: number; records: number; audio_files: number; audio_bytes: number; oldest: number | null; newest: number | null }>(
      `/history/preview?before=${before}`,
    ),
  cleanupHistory: (before: number) =>
    request<{ deleted: number; audio_removed: number; freed_bytes: number }>(`/history?before=${before}`, {
      method: "DELETE",
    }),
  regenerate: async (id: string, overrides?: Record<string, unknown>) => {
    const response = await fetch(`${BASE}/history/${id}/regenerate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(overrides ?? {}),
    });
    if (!response.ok) throw new ApiError("重新生成失败", "regenerate_failed", response.status);
    return response.blob();
  },

  keys: () => request<{ items: ApiKeyRecord[]; auth_required: boolean }>("/apikeys"),
  createKey: (name: string) =>
    request<{ key: string; record: ApiKeyRecord }>("/apikeys", { method: "POST", body: JSON.stringify({ name }) }),
  deleteKey: (id: string) => request<{ deleted: string }>(`/apikeys/${id}`, { method: "DELETE" }),
};

export async function streamDownload(
  modelId: string,
  quant: string,
  onProgress: (payload: Record<string, unknown>) => void,
  signal?: AbortSignal,
) {
  const response = await fetch(`${BASE}/system/models/download?model_id=${encodeURIComponent(modelId)}&quant=${quant}`, {
    headers: authHeaders(),
    signal,
  });
  if (!response.ok || !response.body) throw new ApiError("下载失败", "download_failed", response.status);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      const line = block.split("\n").find((item) => item.startsWith("data: "));
      if (!line) continue;
      try {
        onProgress(JSON.parse(line.slice(6)));
      } catch {
        /* ignore malformed frames */
      }
    }
  }
}

export type { SpeechRequest };
