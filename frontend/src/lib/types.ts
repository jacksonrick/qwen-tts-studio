export type Mode = "custom" | "design" | "clone";

export interface SpeechRequest {
  mode: Mode;
  text: string;
  language: string;
  speaker?: string;
  instruct?: string;
  voice_id?: string | null;
  ref_text?: string;
  xvec_only?: boolean;
  temperature?: number;
  top_k?: number;
  top_p?: number;
  repetition_penalty?: number;
  max_new_tokens?: number;
  chunk_size?: number;
  append_silence?: boolean;
  non_streaming_mode?: boolean | null;
  do_sample?: boolean;
}

export interface Voice {
  id: string;
  name: string;
  kind: string;
  language: string | null;
  ref_text: string | null;
  instruct: string | null;
  xvec_only: boolean;
  tags: string[];
  color: string | null;
  wav_path: string | null;
  spk_path: string | null;
  rvq_path: string | null;
  has_ref_spk: boolean;
  use_count: number;
  created_at: number;
  updated_at: number;
  audio_url: string | null;
}

export interface HistoryRecord {
  id: string;
  mode: Mode;
  model: string;
  quant: string | null;
  backend: string | null;
  text: string;
  language: string | null;
  params: Record<string, unknown>;
  voice_id: string | null;
  audio_url: string | null;
  duration_s: number | null;
  sample_rate: number | null;
  ttfa_ms: number | null;
  rtf: number | null;
  status: string;
  error: string | null;
  created_at: number;
}

export interface Capabilities {
  supports_instruct_clone: boolean;
  supports_voice_prompt_cache: boolean;
  supports_seed: boolean;
  supports_stream: boolean;
  notes: Record<string, string>;
}

export interface ModelStatus {
  status: string;
  loading: string | null;
  error: string | null;
  resident: string[];
  loaded_at: number | null;
  load_ms: number | null;
  backend: string;
  quant: string;
  rss_mb: number | null;
}

export interface RuntimeInfo {
  system: string;
  machine: string;
  python: string;
  backend: string;
  device: string;
  gpu: string;
  torch_version: string | null;
  qwentts_version: string | null;
  ggml_available: boolean;
  torch_available: boolean;
  warnings: string[];
}

export interface Settings {
  backend: string;
  quant: string;
  default_language: string;
  chunk_size: number;
  max_queue: number;
  keep_model_loaded: boolean;
  max_resident: number;
  auth_required: boolean;
  split_long_text: boolean;
  long_text_threshold: number;
  temperature: number;
  top_k: number;
  top_p: number;
  repetition_penalty: number;
  max_new_tokens: number;
  append_silence: boolean;
  auto_open_browser: boolean;
}

export interface SystemInfo {
  app: string;
  runtime: RuntimeInfo;
  model_status: ModelStatus;
  capabilities: Capabilities;
  queue: { queue_size: number; max_queue: number; running: number; queued: number; worker_alive: boolean };
  paths: { data: string; audio: string; voices: string };
  options: { languages: string[]; quants: string[]; models: { mode: Mode; model_id: string; label: string }[] };
  settings: Settings;
}

export interface ModelQuant {
  quant: string;
  cached: boolean;
  size_bytes: number;
  files: { name: string; size: number }[];
}

export interface ModelEntry {
  model_id: string;
  mode: Mode;
  label: string;
  resident: boolean;
  backend: string;
  quants: ModelQuant[];
}

export interface ApiKeyRecord {
  id: string;
  name: string;
  prefix: string;
  created_at: number;
  last_used_at: number | null;
}

export type StreamStatus = "idle" | "connecting" | "queued" | "loading" | "streaming" | "done" | "error" | "cancelled";

export interface StreamMetrics {
  ttfaMs?: number;
  rtf?: number;
  audioSeconds: number;
  chunks: number;
  model?: string;
  backend?: string;
  quant?: string;
  sampleRate?: number;
  queuePosition?: number;
}

export interface StreamResult {
  recordId?: string;
  audioUrl?: string;
  durationS?: number;
  sampleRate?: number;
  ttfaMs?: number;
  rtf?: number;
  chunks?: number;
}

export interface StreamError {
  code: string;
  message: string;
  hint?: string | null;
}
