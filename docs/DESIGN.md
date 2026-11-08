# Qwen3-TTS Studio 设计与实施方案

> 版本：v0.1 方案稿 · 目标：个人自用的本地 TTS 工作台（声音设计 / 音色克隆 / 语音生成）  
> 依据：本机已安装 `faster-qwen3-tts 0.5.0` + `qwentts-cpp-python 0.5.0`（已核对源码），参考 `hangry-labs/faster-qwen3-tts-studio` 的功能面。



---

## 1. 目标与范围

一个人的本地 Web 工作台：单端口启动（FastAPI 同时提供 API 与前端静态页），浏览器里完成「描述造声 → 试听 → 存成音色 → 拿它念稿 → 边生成边播 → 归档历史」，同时对外暴露 HTTP API 给脚本 / 其他客户端调用。

范围内：

- 三种生成模式：VoiceDesign（描述造声）、VoiceClone（参考音频克隆）、CustomVoice（内置说话人 + 风格指令）
- 流式生成 + 浏览器边生成边播（首包 ~300–600ms）
- 音色库（克隆参考 / 设计成品 / 内置说话人三类，可复用为参考）
- 历史记录（全文、参数、音频、指标、一键复用与再生成）
- 系统页（模型下载/加载/卸载、量化、后端、硬件与性能、数据目录）
- API 页（OpenAPI 文档、curl 示例、API Key 管理）+ OpenAI 兼容端点

范围外（明确不做，避免摊大）：多人账号体系、SSML/魔改剧本编辑、音频后处理（降噪/EQ/响度）、ASR 参考转写、Docker 镜像发布、微服务拆分。

---

## 2. 事实基线（已在本机源码中核实，方案据此设计）

| 项              | 结论                                                                                                                                                      | 影响                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 默认后端           | `FasterQwen3TTS.from_pretrained(backend="torch"\|"ggml")`，torch 走 CUDA Graphs，ggml 走 qwentts.cpp                                                        | 需抽象出统一引擎层                                   |
| Mac 可用性        | 本机 `torch 2.15.0` 但 `cuda.is_available()=False`；ggml 库含 `libggml-metal.dylib`                                                                           | macOS 只能走 ggml + Metal                      |
| Windows + ggml | `qwentts-cpp-python 0.5.0` 仅发布 `manylinux_2_39`(cu128 x86_64/aarch64) 与 `macosx_14_0_arm64` wheel，**无 win wheel**                                       | Windows 走 torch+CUDA；要 ggml 只能用 WSL2/Docker |
| 模型映射           | ggml 通过 `Serveurperso/Qwen3-TTS-GGUF` 拉 `.gguf`；量化 `F32/BF16/Q8_0/Q4_K_M`；talker 与 tokenizer 必须同量化档                                                     | 模型管理要成对校验                                   |
| 体积             | 1.7B BF16 talker 3.84–3.88GB + tokenizer 0.36GB；Q8_0 约 2.04+0.29GB；Q4_K_M 约 1.18+0.25GB                                                                 | 三模型全 BF16 ≈ 12GB 磁盘；常驻只能 1 个                |
| 本机缓存           | 已下 `1.7b-customvoice-BF16`、`1.7b-voicedesign-BF16`、`tokenizer-BF16`；**缺 `1.7b-base`**                                                                   | 首次克隆需下载 3.88GB                              |
| 输出音频           | 固定 24kHz 单声道 float32，流式包为 `np.ndarray`（`stream()` 默认首包 4 帧 ≈ 333ms，后续 8 帧 ≈ 640ms）                                                                      | 前端 AudioContext 固定 24k，传输用 PCM16            |
| 取消             | 生成器 `close()` → 原生 `cancel_event.set()` → `qt_synthesize` 立即中断                                                                                          | 支持"停止生成"，无需进程级杀线程                           |
| 并发             | `QwenTTS` 内部 `threading.Lock`，同一时刻只跑一路                                                                                                                  | 必须单 worker 串行队列                             |
| 克隆参考缓存         | ggml 首次克隆会 `extract_voice_ref()` 生成 `.spk`/`.rvq` 并落盘；后续可传 `ref_spk`/`ref_rvq` 跳过提取                                                                     | 音色库应主动保存这两个文件，TTFA 大幅下降                     |
| 后端差异           | ggml：**拒收** clone 的 `instruct`、**拒收** torch 的 `voice_clone_prompt`、`non_streaming_mode` 传值有 warning；torch：支持 `instruct`（实验性）、支持 `voice_clone_prompt` 缓存 | 参数面板需按后端能力动态禁用                              |
| 采样随机性          | 公开 API 未暴露 `seed`（原生 `QwenTTS.stream(seed=...)` 有）                                                                                                      | 种子列为"扩展能力"，需直连低层 API                        |
| 说话人列表          | `model.get_supported_speakers()`（CustomVoice 内置 9 个，运行时获取）                                                                                              | 前端下拉走接口，不硬编码                                |
| 语言             | `Auto, Chinese, English, French, German, Spanish, Italian, Portuguese, Japanese, Korean, Russian, Arabic`                                               | UI 用英文枚举名直传                                 |

---

## 3. 总体架构

```
浏览器 (React + shadcn/ui)
   │  REST / WebSocket / chunked HTTP
   ▼
FastAPI (uvicorn, 单端口 :8000)
   ├── /api/v1/*       业务 API（JSON + 音频流）
   ├── /v1/audio/speech OpenAI 兼容
   ├── /ws/tts         流式双向通道
   └── /               前端构建产物（StaticFiles + SPA fallback）
         │
         ▼
   任务层  JobQueue（单 worker，FIFO，可取消，事件广播）
         │
         ▼
   引擎层  EngineFactory → GGMLBackend | TorchBackend
         │  ModelManager：加载/卸载/换模型/预热/能力声明
         ▼
   faster_qwen3_tts → qwentts.cpp(Metal/CUDA) 或 torch(CUDA Graphs)
         │
         ▼
   存储层  SQLite（history/voices/settings/api_keys）+ data/audio/*.wav + data/voices/*
```

关键取舍：

1. **单进程单 worker**：模型推理本就串行，多进程只会重复占内存。用 `max_workers=1` 的线程池 + `asyncio` 事件桥，请求排队长度可配，超限返回 429。
2. **模型按需换入**：1.7B BF16 单模型占 3.9GB，Mac 统一内存扛不住三模型常驻。`ModelManager` 维护「当前驻留模型 + LRU(可配 N≥1)」，切模式时卸载旧模型再加载（mmap 加载 ~1–3s），并对外暴露 loading 状态给前端。
3. **音频一律落盘**：流式播放消耗内存流，最终 WAV 写入 `data/audio/{job_id}.wav` 再入库；历史/音色/下载全部走文件，避免 base64 塞 JSON。

---

## 4. 功能设计

### 4.1 生成台（默认页）

布局：左侧参数栏（模式 Tab + 音色 + 语言 + 高级参数），右侧编辑区（文本框 + 播放条），底部生成条（生成 / 流式 / 停止 + 指标）。

- **模式切换（三 Tab）**
  - 语音生成（CustomVoice）：说话人下拉（`get_supported_speakers()`）+ 可选风格指令 `instruct`（1.7B 支持）
  - 声音设计（VoiceDesign）：`instruct` 描述框，带预设 chips（如「温暖沉稳的男声旁白」「二十岁女声，轻快」「沙哑沧桑，语速慢」），支持把描述保存为"设计配方"
  - 音色克隆（Base）：参考音频（上传 / 拖拽 / 麦克风录制 / 从音色库选）+ 参考文本 `ref_text` + 克隆模式开关（ICL 默认 / x-vector-only）
- **语言**：Auto + 11 项枚举；与 UI 语言无关
- **高级参数（折叠）**：`temperature / top_k / top_p / repetition_penalty / max_new_tokens / chunk_size / append_silence / non_streaming_mode / xvec_only`，按后端能力置灰并给 tooltip 说明原因（例如 ggml + clone + instruct → "当前后端不支持"）
- **生成方式**：`流式播放`（WS）与 `生成完整音频`（REST）两个按钮，一个"停止"
- **播放器**：边生成边播（WebAudio 队列），生成结束用最终 WAV 渲染波形（wavesurfer），支持进度拖动、AB 复听、下载、另存为音色
- **指标条**：TTFA（首包毫秒）、RTF、音频时长、chunk 数、队列等待、模型加载耗时
- **长文本**：超过阈值（默认 600 字）自动按标点/换行切句，逐句生成边播，句间补 80–120ms 静音，最终拼接成一个 WAV（服务端完成，前端只展示"第 n/N 段"）

### 4.2 音色库（Voices）

- 三类来源：`clone`（上传参考）、`designed`（设计成功后存下）、`builtin`（内置说话人，只读）
- 字段：名称、标签、语言、`ref_text`、`instruct`、克隆模式、封面/色卡、使用次数、来源历史
- 入库时保存：`ref.wav`（统一转 24k mono）、`ref.spk`、`ref.rvq`（ggml 下主动 `extract_voice_ref` 提取，torch 下仅存 wav）、`meta.json`
- 操作：试听原声、用一句话试音、设为生成台参考、编辑、删除、导出（zip：wav+meta，便于跨机器迁移）
- 搜索/筛选：名称、标签、语言、来源类型

### 4.3 历史记录（History）

- 每次生成落一条：模式、模型+量化、文本全文、参数快照 JSON、语言、音色引用、音频路径、时长、TTFA/RTF、状态（done/cancelled/error）
- 列表：时间倒序、分页、按模式/语言/状态/关键词过滤；行内试听、下载、删除
- 单条详情：参数表、原始请求 JSON、错误信息、"再生成一次"（参数回填）、"作为克隆参考"（用生成结果做音色）
- 批量：多选删除、批量导出 wav

### 4.4 API 页

- 内置 `/docs`（Swagger）与 `/redoc` 链接
- 手写示例区：切模式/克隆/流式的 curl 与 Python 片段，带"复制"和"在当前服务上试跑"
- API Key 管理：创建（返回明文一次）、命名、最近使用时间、吊销；本地 localhost 可配免鉴权
- 兼容性说明：OpenAI `/v1/audio/speech` 的 `voice` 取值约定（内置说话人名 / `voice:{id}` / `design:{描述}`）

### 4.5 系统页（System）

- **模型管理**：三模型 × 量化档位列表，显示本地是否已缓存、磁盘占用、当前驻留、加载中状态；按钮：下载（带进度）、加载、卸载、校验（talker/tokenizer 同档）
- **后端与设备**：`auto/ggml/torch` 切换（切换后需重新加载）、量化默认值、`chunk_size`、首包帧数、是否常驻、并发队列上限；展示平台探测结果（`metal / cuda:x / cpu`、显存/内存、torch 与 qwentts 版本）
- **存储**：数据目录、音频总占用、清理 N 天前音频（保留历史记录，标记音频已删）
- **诊断**：最近日志尾部、一次"自检"（加载→合成 1 句→返回耗时），便于排查
- **设置持久化**：`data/settings.json` + 环境变量覆盖（`QTS_*` 前缀）

---

## 5. 后端设计

### 5.1 目录结构

```
src/qwen_tts_studio/
├── __init__.py            # main(): 解析参数 → uvicorn.run(app)
├── app.py                 # create_app(): 中间件、异常处理、路由注册、静态托管
├── config.py              # Settings(pydantic-settings) + 平台探测 + 路径解析
├── api/
│   ├── deps.py            # API Key 校验、job 句柄、分页
│   ├── schemas.py         # 请求/响应模型（SpeechRequest 等）
│   ├── system.py          # /system/*、/models/*
│   ├── tts.py             # /speakers、/tts、/tts/stream
│   ├── ws.py              # /ws/tts
│   ├── voices.py          # /voices/*
│   ├── history.py         # /history/*
│   ├── settings.py        # /settings
│   ├── apikeys.py         # /apikeys
│   └── openai_compat.py   # /v1/audio/speech、/v1/audio/voices
├── engine/
│   ├── base.py            # TTSEngine Protocol、GenParams、SpeechChunk、Capabilities
│   ├── manager.py         # ModelManager（加载/卸载/LRU/锁/预热/能力表）
│   ├── ggml.py            # GGML 实现（含 .spk/.rvq 缓存复用）
│   ├── torch_backend.py   # torch 实现（含 voice_clone_prompt LRU）
│   ├── jobs.py            # JobRegistry + 单 worker 队列 + 取消 + 事件广播
│   └── audio.py           # wav 读写、重采样、PCM16、静音拼接、切句
├── store/
│   ├── db.py              # sqlite3 连接、WAL、schema 版本迁移
│   ├── history.py voices.py settings.py apikeys.py
└── static/                # 前端 dist 拷贝（构建脚本产出）
frontend/                  # Vite + React + TS + Tailwind + shadcn/ui
```

### 5.2 引擎抽象

```python
@dataclass
class Capabilities:
    supports_instruct_clone: bool   # ggml=False, torch=True
    supports_seed: bool             # ggml 低层支持，公开 API 未暴露 → 先 False
    supports_prompt_cache: bool     # torch=True
    supports_stream: bool = True

class TTSEngine(Protocol):
    model_id: str; quant: str; sample_rate: int
    capabilities: Capabilities
    speakers: list[str]
    def generate(self, p: GenParams) -> tuple[np.ndarray, int]        # 合并后整段
    def stream(self, p: GenParams) -> Iterator[SpeechChunk]           # 逐包产出 + 计时
    def prepare_voice(self, wav_path) -> None                         # 预提 .spk/.rvq
    def warmup(self) -> None
```

`SpeechChunk`：`{pcm: np.ndarray(float32), sample_rate, index, is_final, timing}`，由任务层转成 PCM16 二进制帧。

`GenParams` 只放业务字段（mode/text/language/instruct/speaker/ref\_*/采样参数/chunk_size/append_silence/xvec_only/non_streaming_mode），由各后端映射：

| 业务字段              | ggml                                               | torch                                         |
| ----------------- | -------------------------------------------------- | --------------------------------------------- |
| mode=custom       | `generate_custom_voice(_streaming)`                | 同                                             |
| mode=design       | `generate_voice_design(_streaming)`                | 同                                             |
| mode=clone        | 优先 `ref_spk`+`ref_rvq`；否则 `ref_audio`+`ref_text`   | `ref_audio`+`ref_text` 或 `voice_clone_prompt` |
| `instruct`（clone） | 不支持 → 校验层拦截                                        | 透传（实验性）                                       |
| `chunk_size`      | 映射 `codec_chunk_sec = chunk/12`，首包固定 4 帧           | 直接透传                                          |
| `seed`            | 需绕开 wrapper，直调 `qwentts_cpp.QwenTTS.stream(seed=)` | `torch.manual_seed`（全局，慎用）                    |

### 5.3 模型管理

```
ModelManager
  _resident: dict[model_id, engine]      # 受 max_resident(默认1) 限制
  _lock: threading.RLock
  ensure(model_id, quant) -> engine      # 已驻留直接返回；否则卸载 LRU → 加载 → warmup
  status() -> {resident, loading, last_error, device, memory}
```

- 加载在独立线程执行，`loading` 状态通过 SSE/WS 事件推给前端，避免请求卡死
- 加载失败保留 `last_error` 并在系统页展示（参考项目也强调这点）
- 量化/后端变更 → 强制卸载后重载
- 预热：首请求前调 `warmup()`；ggml 下为 no-op，但仍跑一次 3 字短句预热 Metal kernel（可选）

### 5.4 任务与取消

- `JobQueue`：`queue.Queue(maxsize=cfg.max_queue)` + 1 个消费线程；`Job` 持有 `cancel_event`
- 取消：`job.cancel_event.set()`，消费线程在 chunk 之间检查 → `gen.close()` → 原生中断；状态置 `cancelled`，已产出的音频截断并保存（可选保留）
- 队列满 → HTTP 429 `{"code":"queue_full"}`
- 事件：`job.events` 是 `asyncio.Queue`，WS/SSE 直接消费；事件类型 `queued/loading/meta/chunk_stats/progress_final/done/error`

---

## 6. 流式协议

### 6.1 WebSocket `/api/v1/ws/tts`（前端主用）

客户端 → 服务端：

```json
{"type":"start","request":{ ...SpeechRequest... }}
{"type":"cancel"}
```

服务端 → 客户端（文本帧为 JSON，二进制帧为音频）：

```
{"type":"accepted","job_id":"...","queue_position":0}
{"type":"meta","sample_rate":24000,"format":"s16le","channels":1,"mode":"clone","model":"...","ttfa_hint_ms":450}
<binary>  # PCM16LE 24000Hz mono，连续多帧
{"type":"stats","chunk_index":3,"audio_s":1.92,"decode_ms":640,"rtf":0.31}
...
{"type":"done","job_id":"...","audio_url":"/api/v1/history/{id}/audio","duration_s":4.2,"ttfa_ms":412,"rtf":0.28}
{"type":"error","code":"model_load_failed","message":"..."}
```

- 首帧前不发 `meta`，`meta` 一到前端即可建 `AudioContext(24000)`
- 二进制帧只放裸 PCM，不带任何头，减少解析开销
- 断连即取消：`WebSocketDisconnect` → `job.cancel_event.set()`

### 6.2 chunked HTTP `/api/v1/tts/stream`（给脚本用）

- 请求体 JSON，响应 `Content-Type: audio/L16; rate=24000; channels=1`，`Transfer-Encoding: chunked`
- 响应头带 `X-Job-Id`、`X-Sample-Rate`、`X-Model`；尾部统计通过 `Trailer`（可选）或轮询 `/jobs/{id}`
- 支持 `Accept: audio/wav` 时改为"边生成边写 WAV 头 + 数据"（下载场景）

### 6.3 非流式 `/api/v1/tts`

`POST` 返回 `audio/wav` + 头 `X-Ttfa-Ms`、`X-Rtf`、`X-Duration`，同时入库历史。

### 6.4 前端播放调度要点


- 单 `AudioContext`（24k），`playhead` 记录下一个包应开始的时间：`startAt = max(ctx.currentTime + 0.08, playhead)`
- `AudioBuffer.copyToChannel(Float32Array(pcm16/32768))`，`source.start(startAt)`，`playhead = startAt + duration`
- 停止：`source.stop()` 全清 + 关 WS + 复位 playhead；暂停（不中断生成）用 `ctx.suspend()`
- 生成完成后再用最终 WAV 建 wavesurfer 实例做精确回放与下载；避免对实时流做波形

---

## 7. API 规范

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/health` | 存活 + 版本 |
| GET | `/api/v1/system/info` | 平台、设备、torch/qwentts 版本、内存、数据目录、占用 |
| GET | `/api/v1/system/models` | 三模型×量化：cached/loaded/size/status |
| POST | `/api/v1/system/models/{id}/download` | 下载（SSE 进度） |
| POST | `/api/v1/system/models/{id}/load` \| `/unload` | 加载/卸载 |
| PUT | `/api/v1/system/backend` | 后端/量化/常驻策略 |
| GET | `/api/v1/system/logs?tail=200` | 日志尾部 |
| DELETE | `/api/v1/system/logs` | 清空日志文件（就地截断，不重启进程） |
| GET | `/api/v1/speakers?model=` | 内置说话人列表 |
| POST | `/api/v1/tts` | 非流式 WAV |
| POST | `/api/v1/tts/stream` | chunked PCM |
| WS | `/api/v1/ws/tts` | 流式双向 |
| POST | `/api/v1/tts/cancel/{job_id}` | 取消（HTTP 侧） |
| GET | `/api/v1/voices` | 列表（q/tag/kind/lang/page） |
| POST | `/api/v1/voices` | multipart：`audio` + `name` + `ref_text` + …（入库即提 spk/rvq） |
| POST | `/api/v1/voices/from-history/{id}` | 用历史结果存音色 |
| PATCH/DELETE | `/api/v1/voices/{id}` | 改名/标签/删除 |
| GET | `/api/v1/voices/{id}/audio` \| `/sample` | 原声 / 试音（短句合成） |
| GET | `/api/v1/voices/export` | zip 导出 |
| GET | `/api/v1/history` | 分页列表 |
| GET | `/api/v1/history/{id}` | 详情 |
| GET | `/api/v1/history/{id}/audio` | WAV（支持 Range） |
| DELETE | `/api/v1/history/{id}` \| `/history?before=` | 删单/清理 |
| POST | `/api/v1/history/{id}/regenerate` | 同参重跑 |
| GET/PUT | `/api/v1/settings` | 读/写设置 |
| GET/POST/DELETE | `/api/v1/apikeys` | Key 管理 |
| POST | `/v1/audio/speech` | OpenAI 兼容（wav/pcm，`stream_format`） |
| GET | `/v1/audio/voices` | 兼容音色列表 |

鉴权：`X-API-Key` 或 `Authorization: Bearer`；默认仅监听 `127.0.0.1` 时放行本机来源，配置 `auth_required=true` 时强制。写操作校验 `Origin`（同源列表），防跨站触发。

`SpeechRequest` 核心字段：
```json
{
  "mode": "custom | design | clone",
  "text": "...", "language": "Auto",
  "speaker": "serena", "instruct": "warm narrator",
  "voice_id": "v_01H...", "ref_text": "...", "xvec_only": false,
  "model": "Qwen/Qwen3-TTS-12Hz-1.7B-Base", "quant": "BF16",
  "temperature": 0.9, "top_k": 50, "top_p": 1.0, "repetition_penalty": 1.05,
  "max_new_tokens": 2048, "chunk_size": 8, "append_silence": true,
  "split_long_text": true, "save_history": true
}
```

---

## 8. 数据模型（SQLite, WAL）

```sql
voices(id TEXT PK, name TEXT, kind TEXT, language TEXT, ref_text TEXT,
       instruct TEXT, xvec_only INT, tags TEXT, color TEXT,
       wav_path TEXT, spk_path TEXT, rvq_path TEXT,
       source_history_id TEXT, use_count INT, created_at INT, updated_at INT);

history(id TEXT PK, mode TEXT, model TEXT, quant TEXT, backend TEXT,
        text TEXT, language TEXT, params_json TEXT, voice_id TEXT,
        audio_path TEXT, duration_s REAL, sample_rate INT,
        ttfa_ms INT, rtf REAL, status TEXT, error TEXT,
        audio_deleted INT DEFAULT 0, created_at INT);
CREATE INDEX idx_history_created ON history(created_at DESC);
CREATE INDEX idx_history_mode ON history(mode, created_at DESC);

settings(key TEXT PK, value_json TEXT);
api_keys(id TEXT PK, name TEXT, key_hash TEXT, prefix TEXT, created_at INT, last_used_at INT);
```

文件布局：
```
data/
├── studio.db
├── audio/2026/11/08/{job_id}.wav
├── voices/{voice_id}/{ref.wav,ref.spk,ref.rvq,meta.json}
├── uploads/{tmp}            # 上传临时，处理完即删
└── logs/studio.log
```

---

## 9. 前端设计

- 技术：Vite + React 19 + TS + Tailwind v4 + shadcn/ui + lucide-react + TanStack Query + zustand（只存播放器/表单草稿）+ wavesurfer.js
- 路由：`/`（生成台）、`/voices`、`/history`、`/history/:id`、`/api`、`/system`
- 布局：左侧 56px 图标导航栏 + 右侧内容；生成台两栏（参数 360px / 编辑区自适应），窄屏 <1024px 折叠为 Tab
- 视觉：暗色优先（跟系统），中性灰底 + 单一强调色，圆角 12px，无渐变；参数项统一 `Label + 控件 + 说明` 三行结构
- 状态分层：服务端状态用 Query（`speakers/models/voices/history/settings`），流式会话用 `useTtsStream` hook（`idle/queued/loading/streaming/done/error` + 指标 + 取消）
- 组件清单（关键）：`ModeTabs`、`SpeakerSelect`、`InstructEditor`（含预设 chips）、`RefAudioPicker`（上传/录音/音色库三合一）、`AdvancedParams`（按 capabilities 禁用）、`StreamPlayer`（WebAudio 队列 + 计时）、`WaveformPlayer`、`MetricsBar`、`HistoryTable`、`VoiceCard`、`ModelManagerTable`、`ApiKeyTable`、`CodeBlock`
- 空态与失败态明确：模型未下载→引导去系统页下载并显示体积；队列满→提示排队；后端不支持某参数→控件直接禁用并说明

---

## 10. 平台与依赖矩阵

| 平台 | 后端 | 说明 |
|---|---|---|
| macOS 14+ arm64 | **ggml**（Metal） | 推荐 `Q8_0`（体积/速度平衡）；`BF16` 质量最好但更吃带宽 |
| Linux x86_64/aarch64 + NVIDIA | torch（CUDA Graphs）或 ggml（cu128 wheel） | torch RTF 更高；ggml 更省显存，显存 <8GB 优先 ggml |
| Windows 10/11 + NVIDIA | **torch**（CUDA Graphs） | ggml 无 win wheel；如需 ggml 用 WSL2/Docker（Linux 轮子） |
| 无 GPU | ggml CPU | 可用但慢（RTF ≪ 1），仅做功能验证 |

依赖建议（下一阶段改 `pyproject.toml`）：
```toml
dependencies = [
  "fastapi>=0.115", "uvicorn[standard]>=0.30", "pydantic-settings>=2.4",
  "python-multipart>=0.0.7", "soundfile>=0.12", "numpy>=1.26",
  "faster-qwen3-tts>=0.5.0",
  "qwentts-cpp-python>=0.5.0; sys_platform != 'win32'",
]
[project.optional-dependencies]
cuda = []   # Windows/Linux 由安装脚本按 cu 版本装 torch
dev  = ["pytest", "ruff", "httpx"]
```
- macOS 上 `faster-qwen3-tts` 会连带装 CPU 版 torch（约 1.2GB），无法避免（包硬依赖）；可在文档说明"mac 上 torch 仅用于满足依赖"
- Windows 安装顺序：先按驱动装对应 CUDA 版 torch，再 `uv sync`，避免拉到不匹配轮子
- 端口/主机：`--host 127.0.0.1 --port 8000`，`--open` 自动开浏览器；单端口同时服务 API 与前端

---

## 11. 性能与健壮性

| 关注点 | 措施 |
|---|---|
| 首包延迟 | `chunk_size=8`（≈667ms/包）+ ggml 首包 4 帧；前端 80ms 预缓冲；实测展示 TTFA |
| 模型切换开销 | mmap 加载，常驻 1 个；换模式提示"正在加载模型"并显示进度；同模型内切模式不重载 |
| 克隆首包慢 | 入库时预提 `.spk/.rvq`；请求侧传 `ref_spk/ref_rvq`，跳过参考编码 |
| 内存 | 三模型不常驻；音频用完即释放；`np.float32` 只在管线内存在，传输 PCM16 减半 |
| 长文本 | 先切句再逐句生成，单句失败可重试该句；总时长上限保护（如 5 分钟） |
| 取消 | 生成器 close → 原生 cancel；WS 断连即取消；取消后仍保存已生成片段（可选） |
| 错误 | 统一 `{code,message,hint}`；模型未下载/加载失败/显存不足/不支持参数都有专门 code 与前端文案 |
| 安全 | 默认 localhost；写操作校验 Origin；上传限制类型（wav/mp3/flac/m4a）与大小（≤20MB）、时长（≤30s）；文件名不落地用 uuid |
| 可观测 | 结构化日志（请求 id、job id、耗时分段）、`/system/logs` 查看尾部、每次生成记录 ttfa/rtf |

---

## 12. 里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| M0 | 项目骨架：`config/app/main`、静态托管、`/health`、前端脚手架能跑 | 起服务后浏览器出空工作台 UI |
| M1 | 引擎层：`ModelManager` + ggml/torch 双实现 + 三模式非流式 `/tts` | 三种模式各出一段正确 WAV，指标落库 |
| M2 | 流式：`/ws/tts` + `/tts/stream` + 前端 `StreamPlayer` + 取消 | 边生成边播无明显断音，停止按钮 <500ms 生效 |
| M3 | 音色库 + 历史 + SQLite | 克隆参考入库复用，TTFA 明显下降；历史可试听/删除/再生成 |
| M4 | 系统页 + 设置 + 模型下载/加载 + API 页 + Key | 能在线下载缺的 Base 模型并切换量化 |
| M5 | OpenAI 兼容端点 + 长文本切句 + 打包启动脚本 | `curl /v1/audio/speech` 出 wav；长文 3 分钟稿可完整生成 |
| M6 | 健壮性：错误码、日志、上传校验、429、诊断自检 | 断网/超时/并发/取消等异常不崩进程 |

---

## 13. 风险与对策

1. **Windows 无 ggml 轮子**：直接承诺 torch+CUDA 路线；文档给 WSL2 方案。若必须原生 Windows ggml，需自行编译 libqwen（成本高，暂不做）。
2. **wrapper 参数覆盖不全**（seed、subtalker_*、first_chunk_frames 不可配）：短期接受；确需时在 `engine/ggml.py` 里直连 `qwentts_cpp.QwenTTS.stream()`，保留 `faster_qwen3_tts` 作为默认路径。
3. **上游版本迭代快**（0.5.0 → 后续）：引擎层做适配隔离，锁版本、README 记录升级检查清单（`Capabilities` 逐项回归）。
4. **Mac BF16 Metal 性能未实测**：M1 做一次 3 量化 × 3 模式的基准（首包/RTF），把结果写进系统页默认推荐值。
5. **质量类问题**（长句重复、ICL 开头音素污染）：`append_silence=True` 默认开；长文本切句；必要时暴露 `min_new_tokens/repetition_penalty` 调节。
6. **仓库 `.gitignore` 当前是 `*`**（venv 生成），后续需改成正常忽略列表，否则代码无法入库。

---

## 14. 待确认

1. 默认量化：Mac 上以 `Q8_0` 为默认（体积 2GB/模型，速度更好），还是坚持 `BF16`（质量优先）？——建议 M1 基准后定。
2. 是否需要"设计音色 → 自动转成克隆参考"的一键链路（参考项目有这个卖点，实现上用生成 WAV + `ref_text=原文` 即可）。
3. 是否需要英文界面（i18n）；不加则 UI 全中文，省一层抽象。
4. SSML / 多角色对话编辑是否列入二期（当前方案不做）。

---

## 15. 实现记录（v0.1 已落地）

已确认的决策：量化/后端都做（系统页可选，默认 BF16 + auto）；实现"生成结果一键存为音色"；不做 i18n；不做 SSML。

### 15.1 代码索引

| 文件 | 职责 |
| --- | --- |
| `src/qwen_tts_studio/cli.py` | argparse + uvicorn 启动 + 自动开浏览器 |
| `src/qwen_tts_studio/app.py` | 应用工厂、CORS、写请求 Origin 校验、静态托管与 SPA 回退、EngineError → JSON |
| `src/qwen_tts_studio/config.py` | Settings 持久化、平台探测、后端解析、模型/量化常量 |
| `src/qwen_tts_studio/studio.py` | 上下文装配 + 请求解析（模式 → 模型/参考/参数） |
| `engine/faster_base.py` | 引擎共用实现（三模式参数映射、流式包装、ggml 参考特征提取） |
| `engine/manager.py` | 模型驻留/LRU/加载锁、能力表、模型清单、下载、`.spk/.rvq` 准备 |
| `engine/jobs.py` | 单 worker 队列、事件广播、取消、落库、长文本分段 |
| `engine/audio.py` | WAV 读写、重采样、PCM16、切句 |
| `api/*.py` | REST / WS / OpenAI 兼容 / 系统 / 音色 / 历史 / 密钥 |
| `frontend/src/hooks/use-tts.ts` | WS 会话状态机 + WebAudio PCM16 排队播放 |
| `frontend/src/pages/*` | 生成台、音色库、历史、API、系统 |

### 15.2 与方案的偏差

1. **设置存 `data/settings.json`**（而非 settings 表），字段变更加 `PUT /api/v1/settings`，无需迁移。
2. **克隆只接受 `voice_id`**：请求体不带内联参考音频，临时参考先入库（前端"存为音色"或音色库上传）。这样 `.spk/.rvq` 缓存复用路径统一。
3. **模型未下载时直接报错**（`model_not_cached`，HTTP 400 并给下载指引），不静默触发 4GB 下载；下载入口收敛到系统页。
4. **`seed` 未暴露**：上游公开 API 没有该参数，方案里的"扩展能力"未做。
5. **模型文件留在 HuggingFace 缓存**，不复制到 `data/`；`data/ref_cache/` 仅存 ggml 参考特征。
6. 额外补齐：录音 → 转 24k WAV 上传、历史音频 Range 请求（播放器可拖动）、音色导出 zip、SSE 模型下载进度。

### 15.3 实测（MacBook Apple Silicon / ggml / BF16 1.7B）

| 场景 | 结果 |
| --- | --- |
| 冷启动加载模型 | 5–7s（Metal kernel 首次编译），KV cache 约 896MB |
| 纯生成首包（模型已驻留） | 121ms（原生 Perf）/ 360–460ms（端到端 WS） |
| 非流式 RTF | 0.43–0.46（2s 音频约 0.9s 生成） |
| 流式 RTF | 0.41–0.70（含分段解码开销） |
| 取消延迟 | 约 277ms（发送 cancel → 收到 done，含已生成片段落盘） |
| 16 字中文 | 约 5.8s 音频，10 个数据包 |

RTF 定义：处理耗时 / 音频时长，仅统计模型加载完成之后的生成段；首包（ttfa）从任务开始算，因此在冷启动请求里会包含模型加载时间。

### 15.4 尚未覆盖

- 长文本（>600 字）分段生成已实现但未做大规模质量验证。
- torch 后端（Windows/Linux CUDA）代码路径完整，未在 NVIDIA 机器上实测。
- 音色库的标签编辑、封面配色未接 UI（后端已支持 PATCH）。

### 15.5 v0.1.1 修复记录

| 问题 | 原因 | 处理 |
| --- | --- | --- |
| 音色库点「提特征」报 `prepare_voice() takes 4 positional arguments but 5 were given` | `ModelManager.prepare_voice` 的 `load` 是 keyword-only，`asyncio.to_thread` 里按位置传了 `True` | 调用改 `load=True`；接口层其余调用点复核为关键字传参 |
| 生成台点「流式播放」后文本输入框变高、结束后回落 | 右栏整列高度由内容决定，流式时多出进度条/状态提示，`flex-1` 的文本卡随之吸收多余高度 | 右栏改 `xl:h-full + flex` 定高容器：文本卡固定 `xl:h-[400px]`，运行状态卡 `flex-1 min-h-[200px] + 内部滚动`，整列不再随内容重排（实测输入框高度 271px 恒定） |
| 系统日志显示在页面末尾 | 就地展开一张卡 | 改为宽版弹窗（`Dialog size="wide"`），打开即读，4s 自动刷新，向上翻阅时停止跟随；新增 `DELETE /api/v1/system/logs` 就地截断日志文件（不重启进程），弹窗内可清空 |
| 历史试听鼠标悬停就播放 | 按钮 `onMouseEnter` 就挂载 `<audio autoPlay>` | 去掉 hover 触发，仅点击展开并播放，再点收起 |

### 15.6 v0.1.2 修复记录（指标口径 + 文档）

| 问题 | 原因 | 处理 |
| --- | --- | --- |
| UI 里的 RTF 与文档对不上（界面 2.18，文档 0.46） | `_rtf()` 返回 `音频时长 / 处理耗时`，是"实时倍速"而非 RTF；且计时起点在模型加载之前 | 改为 `耗时 / 音频时长`；新增 `gen_started`（`manager.ensure()` 之后），RTF 只统计生成段；历史记录里 17 条旧值按倒数回填 |
| 流式过程中「首包延迟」一直显示 `—` | 服务端只在 `done` 帧里回传 `ttfa_ms` | 前端在收到第一帧 PCM 时用 `performance.now()` 自测一个端到端值先填上，`done` 到达后再用服务端值覆盖 |
| README 缺少截图与使用/开发说明 | — | 重写 README（GitHub 风格：徽章、目录、截图、使用说明、API 表、开发指引、FAQ），截图存 `docs/images/`（Playwright 1440×900 @2x 抓取后压到 1800px 宽） |
