/**
 * Hand maintained API reference rendered by the API page.
 * Keep in sync with src/qwen_tts_studio/api/*.py when endpoints change.
 */

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "WS";

/** 示例用：30 天前的 Unix 秒，避免文档里放一个早就过期的硬编码时间戳 */
const CLEANUP_EXAMPLE_TS = String(Math.floor(Date.now() / 1000) - 30 * 86400);

export interface ApiParam {
  name: string;
  type: string;
  required?: boolean;
  default?: string;
  description: string;
}

export interface ApiEndpoint {
  id: string;
  method: HttpMethod;
  path: string;
  summary: string;
  /** Defaults to true. Set false for public endpoints. */
  auth?: boolean;
  notes?: string[];
  params?: ApiParam[];
  returns?: string[];
  examplePath?: string;
  exampleQuery?: Record<string, string>;
  exampleBody?: Record<string, unknown>;
  exampleForm?: Record<string, string>;
  exampleRaw?: string;
  outputFile?: string;
}

export interface ApiGroup {
  id: string;
  title: string;
  description: string;
  endpoints: ApiEndpoint[];
}

const SPEECH_PARAMS: ApiParam[] = [
  { name: "mode", type: "string", default: "custom", description: "合成模式：custom 内置音色 / design 文字设计音色 / clone 音色克隆" },
  { name: "text", type: "string", required: true, description: "要合成的文本，最长 8000 字；空白会返回 400 empty_text" },
  { name: "language", type: "string", default: "Auto", description: "语言英文名（Chinese / English / Japanese…），Auto 自动判断" },
  { name: "speaker", type: "string", default: "首个内置音色", description: "仅 custom 模式使用；省略时取内置列表第一个，取值见 GET /speakers" },
  { name: "instruct", type: "string", default: '""', description: "design 模式必填（音色描述）；custom / clone 作为风格指令，ggml 后端克隆时会返回 400" },
  { name: "voice_id", type: "string", required: false, description: "仅 clone 模式必填，取自音色库；缺失返回 400 missing_reference" },
  { name: "ref_text", type: "string", default: '""', description: "仅 clone 模式；覆盖音色库里的参考文本，须与参考音频逐字对应" },
  { name: "xvec_only", type: "boolean", default: "false", description: "仅 clone 模式；只取说话人特征，不做 ICL 对齐，跨语种更稳。为 true 时忽略 ref_text" },
  { name: "model", type: "string", default: "自动", description: "一般不用传；覆盖该模式对应的模型 ID" },
  { name: "quant", type: "string", default: "跟随系统设置", description: "预留字段，当前请求级不生效；量化在 PUT /settings 里切换" },
  { name: "temperature", type: "number", default: "0.9", description: "采样温度，范围 0–2" },
  { name: "top_k", type: "integer", default: "50", description: "采样 top-k，范围 0–500" },
  { name: "top_p", type: "number", default: "1.0", description: "核采样，范围 (0, 1]" },
  { name: "repetition_penalty", type: "number", default: "1.05", description: "重复惩罚，范围 0.5–2" },
  { name: "max_new_tokens", type: "integer", default: "2048", description: "单次生成 token 上限，范围 64–8192" },
  { name: "chunk_size", type: "integer", default: "8", description: "流式解码的 chunk 大小，范围 1–48；越小首包越快" },
  { name: "append_silence", type: "boolean", default: "true", description: "句尾补静音，避免播放被截断" },
  { name: "non_streaming_mode", type: "boolean | null", default: "null", description: "交给引擎的非流式解码开关，一般不用传" },
  { name: "do_sample", type: "boolean", default: "true", description: "是否采样；false 时走贪心解码" },
];

const VOICE_UPDATE_PARAMS: ApiParam[] = [
  { name: "name", type: "string", description: "音色名称" },
  { name: "tags", type: "string[]", description: "标签数组，最多保留 12 个" },
  { name: "ref_text", type: "string", description: "参考文本，必须与参考音频逐字对应；置空后克隆自动走 x-vector" },
  { name: "instruct", type: "string", description: "该音色的默认风格提示" },
  { name: "language", type: "string", description: "默认语言" },
  { name: "xvec_only", type: "boolean", description: "是否只用说话人特征" },
  { name: "color", type: "string", description: "界面卡片颜色" },
];

const SETTINGS_PARAMS: ApiParam[] = [
  { name: "backend", type: "string", description: '推理后端：auto / ggml / torch' },
  { name: "quant", type: "string", description: "量化档位：BF16 / Q8_0 / Q4_K_M / F32" },
  { name: "default_language", type: "string", description: "默认语言" },
  { name: "chunk_size", type: "integer", description: "默认 chunk 大小，1–48" },
  { name: "max_queue", type: "integer", description: "队列长度上限，1–64" },
  { name: "keep_model_loaded", type: "boolean", description: "生成后是否常驻模型" },
  { name: "max_resident", type: "integer", description: "最多同时驻留的模型数，1–3" },
  { name: "auth_required", type: "boolean", description: "是否强制鉴权（本机回环地址始终免鉴权）" },
  { name: "split_long_text", type: "boolean", description: "长文本是否自动分段合成" },
  { name: "long_text_threshold", type: "integer", description: "触发分段的正文字数，120–4000" },
  { name: "temperature", type: "number", description: "默认采样温度，0–2" },
  { name: "top_k", type: "integer", description: "默认 top-k，0–500" },
  { name: "top_p", type: "number", description: "默认 top-p，(0, 1]" },
  { name: "repetition_penalty", type: "number", description: "默认重复惩罚，0.5–2" },
  { name: "max_new_tokens", type: "integer", description: "默认 token 上限，64–8192" },
  { name: "append_silence", type: "boolean", description: "默认是否补静音" },
  { name: "auto_open_browser", type: "boolean", description: "启动时是否自动打开浏览器" },
];

export const API_BASE = "http://127.0.0.1:8000";

export const API_GROUPS: ApiGroup[] = [
  {
    id: "speech",
    title: "语音合成",
    description: "三种模式共用一套请求体；克隆需先在音色库建音色。",
    endpoints: [
      {
        id: "tts",
        method: "POST",
        path: "/api/v1/tts",
        summary: "非流式合成，返回完整 WAV",
        notes: [
          "响应体是 audio/wav，同时带 X-Job-Id / X-History-Id / X-Duration / X-Ttfa-Ms / X-Rtf 响应头。",
          "clone 模式下若参考文本明显长于参考音频（估算时长 > 音频 × 1.35 + 1.5s），会返回 400 ref_text_mismatch。",
          "ggml 后端不支持克隆时带 instruct，会返回 400 unsupported_parameter。",
        ],
        params: SPEECH_PARAMS,
        returns: [
          "200 audio/wav — 完整音频，24kHz 单声道 16bit",
          "400 — 参数或音色问题（code 见错误码表）",
          "429 — 队列已满；504 — 等待首包超时",
        ],
        exampleBody: { mode: "custom", text: "你好，这是通过接口合成的一段语音。", speaker: "serena", language: "Chinese" },
        outputFile: "out.wav",
      },
      {
        id: "tts-stream",
        method: "POST",
        path: "/api/v1/tts/stream",
        summary: "流式输出裸 PCM16（24kHz 单声道）",
        notes: [
          "请求体与 POST /tts 完全相同。",
          "响应没有文件头，是连续的 PCM16LE，采样率见响应头 X-Sample-Rate，格式见 X-Audio-Format。",
          "客户端断开或出错时服务端会取消对应任务。",
        ],
        params: SPEECH_PARAMS,
        returns: ["200 audio/L16 — PCM16LE 流", "400 / 429 / 504 — 同上"],
        exampleRaw: `curl -N -X POST '${API_BASE}/api/v1/tts/stream' \\
  -H 'Content-Type: application/json' \\
  -H 'X-API-Key: qts_xxx' \\
  -d '{"mode":"custom","text":"流式测试，一二三四五。","speaker":"aiden","language":"Chinese"}' \\
  | ffplay -f s16le -ar 24000 -ac 1 -`,
      },
      {
        id: "ws-tts",
        method: "WS",
        path: "/api/v1/ws/tts",
        summary: "双向流式：JSON 事件 + 二进制音频帧",
        notes: [
          '首帧必须是 {"type":"start","request":{…}}，request 字段同 SpeechRequest。',
          "服务端事件：accepted（含 job_id）/ meta / 二进制 audio 帧 / done / error / cancelled。",
          '中途取消发送 {"type":"cancel"}。',
          "鉴权：非本机访问时带 X-API-Key 头，或用 ?api_key= 查询参数。",
          "错误关闭码：4400 请求格式错误，4401 鉴权失败。",
        ],
        params: [
          { name: "type", type: '"start"', required: true, description: "首帧类型" },
          { name: "request", type: "SpeechRequest", required: true, description: "与 POST /tts 的请求体相同" },
        ],
        returns: ["accepted / meta / done 为 JSON 文本帧", "audio 为二进制音频帧", "error / cancelled 为 JSON 文本帧"],
        exampleRaw: `# pip install websockets
import asyncio, json, websockets

async def main():
    async with websockets.connect("ws://127.0.0.1:8000/api/v1/ws/tts") as ws:
        await ws.send(json.dumps({"type": "start", "request": {
            "mode": "custom", "text": "你好，这是 WebSocket 流式合成。",
            "speaker": "serena", "language": "Chinese"}}))
        with open("ws-out.pcm", "wb") as f:
            async for message in ws:
                if isinstance(message, bytes):
                    f.write(message)
                else:
                    event = json.loads(message)
                    if event["type"] in {"done", "error"}:
                        print(event)
                        break

asyncio.run(main())`,
      },
      {
        id: "job",
        method: "GET",
        path: "/api/v1/jobs/{job_id}",
        summary: "查询任务状态",
        params: [{ name: "job_id", type: "string", required: true, description: "提交任务时返回的 ID" }],
        returns: ["job_id / status / mode / model_id / record_id / error / streaming", "404 — 任务不存在或已被清理"],
        examplePath: "/api/v1/jobs/8f3c1d2e9a0b4c7d",
      },
      {
        id: "cancel",
        method: "POST",
        path: "/api/v1/tts/cancel/{job_id}",
        summary: "取消排队或生成中的任务",
        params: [{ name: "job_id", type: "string", required: true, description: "要取消的任务 ID" }],
        returns: ["200 {cancelled: true}", "404 — 任务不存在"],
        examplePath: "/api/v1/tts/cancel/8f3c1d2e9a0b4c7d",
      },
      {
        id: "speakers",
        method: "GET",
        path: "/api/v1/speakers",
        summary: "内置说话人列表",
        params: [{ name: "model", type: "string", description: "指定模型 ID，默认 CustomVoice 模型" }],
        returns: ["model / speakers / loaded（loaded 为 false 时是兜底列表）"],
        exampleQuery: { model: "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice" },
      },
      {
        id: "languages",
        method: "GET",
        path: "/api/v1/languages",
        summary: "支持的语言英文名列表",
        returns: ["languages: string[]"],
      },
    ],
  },
  {
    id: "voices",
    title: "音色库",
    description: "上传参考音频建音色；克隆质量取决于参考文本与音频是否对齐。",
    endpoints: [
      {
        id: "list-voices",
        method: "GET",
        path: "/api/v1/voices",
        summary: "音色列表（支持筛选）",
        params: [
          { name: "query", type: "string", description: "按名称 / 参考文本模糊搜索" },
          { name: "kind", type: "string", description: "音色类型，当前只有 clone" },
          { name: "language", type: "string", description: "按语言筛选，如 Chinese" },
        ],
        returns: ["items: Voice[]，每项含 id / name / ref_text / wav_path / audio_url / spk_path / rvq_path 等", "total: number"],
      },
      {
        id: "create-voice",
        method: "POST",
        path: "/api/v1/voices",
        summary: "上传参考音频并入库（multipart/form-data）",
        notes: [
          "支持 wav / mp3 / flac / m4a / ogg / aac / opus / webm，单文件上限 25MB。",
          "超过 30 秒会在 30 秒前的停顿处收尾（不是硬切，避免把字切一半）；ref_text 会自动收敛到与这段音频匹配的整句，避免 ICL 复读。",
          "ref_text 留空时，克隆请求会自动退到 x-vector 模式。",
          "入库后会尽力预提取 .spk/.rvq 特征；失败不影响建音色，可再调 POST /voices/{id}/prepare。",
        ],
        params: [
          { name: "file", type: "file", required: true, description: "参考音频文件（multipart）" },
          { name: "name", type: "string", default: "未命名音色", description: "音色名称" },
          { name: "ref_text", type: "string", default: '""', description: "参考音频里说的原话，逐字一致" },
          { name: "instruct", type: "string", default: '""', description: "默认风格提示（ggml 克隆时不支持）" },
          { name: "language", type: "string", default: "Auto", description: "音色语言" },
          { name: "tags", type: "string", default: '"[]"', description: "JSON 数组字符串，最多 12 个" },
          { name: "xvec_only", type: "boolean", default: "false", description: "只用说话人特征，不需要参考文本" },
          { name: "color", type: "string", default: '""', description: "卡片颜色" },
          { name: "source_history_id", type: "string", default: "null", description: "来源历史记录 ID（从历史存音色时带上）" },
        ],
        returns: [
          "voice — 入库后的完整记录",
          "duration_s / source_duration_s — 实际使用时长与原始时长",
          "truncated — 音频是否被截断；ref_text_trimmed — 参考文本是否被自动收敛",
          "prepared — 特征提取结果（supported / saved 等）",
        ],
        exampleForm: { file: "@ref.wav", name: "我的音色", ref_text: "这是参考音频里说的原话。", language: "Chinese" },
      },
      {
        id: "get-voice",
        method: "GET",
        path: "/api/v1/voices/{voice_id}",
        summary: "音色详情",
        params: [{ name: "voice_id", type: "string", required: true, description: "12 位音色 ID" }],
        examplePath: "/api/v1/voices/41a3244f1ea2",
      },
      {
        id: "update-voice",
        method: "PATCH",
        path: "/api/v1/voices/{voice_id}",
        summary: "修改音色元数据（含参考文本）",
        params: [{ name: "voice_id", type: "string", required: true, description: "音色 ID" }, ...VOICE_UPDATE_PARAMS],
        returns: ["200 更新后的音色记录", "404 — 音色不存在"],
        examplePath: "/api/v1/voices/41a3244f1ea2",
        exampleBody: { ref_text: "这是参考音频里真正说的那段话。", xvec_only: false },
      },
      {
        id: "delete-voice",
        method: "DELETE",
        path: "/api/v1/voices/{voice_id}",
        summary: "删除音色及其参考文件",
        params: [{ name: "voice_id", type: "string", required: true, description: "音色 ID" }],
        returns: ["200 {deleted: voice_id}", "404 — 音色不存在"],
        examplePath: "/api/v1/voices/41a3244f1ea2",
      },
      {
        id: "voice-audio",
        method: "GET",
        path: "/api/v1/voices/{voice_id}/audio",
        summary: "试听参考音频",
        params: [{ name: "voice_id", type: "string", required: true, description: "音色 ID" }],
        returns: ["200 audio/wav", "404 — 音色或音频文件不存在"],
        examplePath: "/api/v1/voices/41a3244f1ea2/audio",
        outputFile: "ref.wav",
      },
      {
        id: "voice-sample",
        method: "POST",
        path: "/api/v1/voices/{voice_id}/sample",
        summary: "用该音色试一句话",
        notes: [
          "内部按 clone 模式合成，沿用音色的 ref_text 与 xvec_only 设置，并处理与 /tts 相同的对齐校验。",
          "响应是完整 WAV，带 X-Ttfa-Ms 响应头。",
        ],
        params: [
          { name: "voice_id", type: "string", required: true, description: "音色 ID" },
          { name: "text", type: "string", required: true, description: "试听文本，1–400 字" },
          { name: "language", type: "string", default: "音色语言 / Auto", description: "本次试听语言" },
        ],
        returns: ["200 audio/wav", "400 — 音色对齐或后端能力问题", "404 — 音色不存在"],
        examplePath: "/api/v1/voices/41a3244f1ea2/sample",
        exampleBody: { text: "你好，这是我的一段试听。", language: "Chinese" },
        outputFile: "sample.wav",
      },
      {
        id: "voice-prepare",
        method: "POST",
        path: "/api/v1/voices/{voice_id}/prepare",
        summary: "预提取 .spk / .rvq 特征",
        notes: ["需要 Base 模型已下载；成功后克隆会跳过参考编码，首包更快。"],
        params: [{ name: "voice_id", type: "string", required: true, description: "音色 ID" }],
        returns: ["200 {prepared, voice}", "400 — 后端不支持或提取失败", "404 — 音色不存在"],
        examplePath: "/api/v1/voices/41a3244f1ea2/prepare",
      },
      {
        id: "voice-export",
        method: "GET",
        path: "/api/v1/voices/{voice_id}/export",
        summary: "导出参考音频与元数据（zip）",
        params: [{ name: "voice_id", type: "string", required: true, description: "音色 ID" }],
        returns: ["200 application/zip — 含 ref.wav、特征文件与 meta.json", "404 — 音色不存在"],
        examplePath: "/api/v1/voices/41a3244f1ea2/export",
        outputFile: "voice.zip",
      },
    ],
  },
  {
    id: "history",
    title: "历史记录",
    description: "每次成功合成都会落库，可回听、下载、同参数重跑。",
    endpoints: [
      {
        id: "list-history",
        method: "GET",
        path: "/api/v1/history",
        summary: "分页查询生成历史",
        params: [
          { name: "page", type: "integer", default: "1", description: "页码，从 1 开始" },
          { name: "page_size", type: "integer", default: "20", description: "每页条数，1–100" },
          { name: "mode", type: "string", description: "custom / design / clone" },
          { name: "status", type: "string", description: "done / error" },
          { name: "query", type: "string", description: "按文本模糊搜索" },
        ],
        returns: ["items / total / page / page_size"],
        exampleQuery: { page: "1", page_size: "20", mode: "clone" },
      },
      {
        id: "preview-cleanup",
        method: "GET",
        path: "/api/v1/history/preview",
        summary: "清理前预览：会删多少条、占多少磁盘",
        params: [
          {
            name: "before",
            type: "integer",
            required: true,
            description: "Unix 秒；统计该时间点之前的记录。必须早于 1 分钟前",
          },
        ],
        returns: ["records / audio_files / audio_bytes / oldest / newest", "400 — before 不合法"],
        exampleQuery: { before: CLEANUP_EXAMPLE_TS },
      },
      {
        id: "cleanup-history",
        method: "DELETE",
        path: "/api/v1/history",
        summary: "按时间批量清理记录与音频文件",
        notes: [
          "不可撤销：记录从库里删除，音频文件同时从磁盘删除",
          "最近 1 分钟内的记录永远保留，避免误删刚生成的结果",
        ],
        params: [
          {
            name: "before",
            type: "integer",
            required: true,
            description: "Unix 秒；删除该时间点之前的全部记录",
          },
        ],
        returns: ["200 {deleted, audio_removed, freed_bytes}", "400 — before 不合法"],
        exampleQuery: { before: CLEANUP_EXAMPLE_TS },
      },
      {
        id: "get-history",
        method: "GET",
        path: "/api/v1/history/{record_id}",
        summary: "单条历史详情（含完整参数）",
        params: [{ name: "record_id", type: "string", required: true, description: "历史记录 ID" }],
        returns: ["记录字段 + params（合成时使用的完整参数）", "404 — 记录不存在"],
        examplePath: "/api/v1/history/84f1259cae284cc3",
      },
      {
        id: "history-audio",
        method: "GET",
        path: "/api/v1/history/{record_id}/audio",
        summary: "在线播放音频（支持 Range 拖动）",
        params: [{ name: "record_id", type: "string", required: true, description: "历史记录 ID" }],
        returns: ["200 audio/wav", "206 — Range 分段", "404 — 音频已删除"],
        examplePath: "/api/v1/history/84f1259cae284cc3/audio",
        outputFile: "history.wav",
      },
      {
        id: "history-download",
        method: "GET",
        path: "/api/v1/history/{record_id}/download",
        summary: "下载音频（attachment）",
        params: [{ name: "record_id", type: "string", required: true, description: "历史记录 ID" }],
        returns: ["200 audio/wav", "404 — 音频已删除"],
        examplePath: "/api/v1/history/84f1259cae284cc3/download",
        outputFile: "history.wav",
      },
      {
        id: "delete-history",
        method: "DELETE",
        path: "/api/v1/history/{record_id}",
        summary: "删除记录及音频文件",
        params: [{ name: "record_id", type: "string", required: true, description: "历史记录 ID" }],
        returns: ["200 {deleted: record_id}", "404 — 记录不存在"],
        examplePath: "/api/v1/history/84f1259cae284cc3",
      },
      {
        id: "regenerate",
        method: "POST",
        path: "/api/v1/history/{record_id}/regenerate",
        summary: "沿用原参数重跑（可覆盖文本）",
        notes: ["请求体可省略；只支持覆盖 text 与 language，其余采样参数沿用原记录。"],
        params: [
          { name: "record_id", type: "string", required: true, description: "历史记录 ID" },
          { name: "text", type: "string", description: "新的合成文本（可选）" },
          { name: "language", type: "string", description: "新的语言（可选）" },
        ],
        returns: ["200 audio/wav（同时写入新的历史记录）", "400 — 原音色已删除或参数失效"],
        examplePath: "/api/v1/history/84f1259cae284cc3/regenerate",
        exampleBody: { text: "同一段参数，换一句话再跑一次。" },
        outputFile: "regenerated.wav",
      },
    ],
  },
  {
    id: "system",
    title: "系统与模型",
    description: "运行时信息、模型下载与驻留、队列、日志和全局设置。",
    endpoints: [
      {
        id: "health",
        method: "GET",
        path: "/api/v1/health",
        summary: "健康检查与队列概况",
        auth: false,
        returns: ["ok / app / queue"],
      },
      {
        id: "version",
        method: "GET",
        path: "/api/v1/version",
        summary: "应用名与版本号",
        auth: false,
        returns: ["app / version"],
      },
      {
        id: "system-info",
        method: "GET",
        path: "/api/v1/system/info",
        summary: "运行时、设备能力、队列、路径与设置",
        returns: ["app / runtime / model_status / capabilities / queue / paths / options / settings"],
      },
      {
        id: "models",
        method: "GET",
        path: "/api/v1/system/models",
        summary: "模型清单、缓存与驻留状态",
        returns: ["backend / quant / models[] / status"],
      },
      {
        id: "model-load",
        method: "POST",
        path: "/api/v1/system/models/load",
        summary: "加载指定模型（可切换量化）",
        notes: ["切换 quant 会写入设置并卸载旧模型；首次加载可能耗时数十秒。"],
        params: [
          { name: "model_id", type: "string", required: true, description: "模型 ID，见 GET /system/models" },
          { name: "quant", type: "string", description: "BF16 / Q8_0 / Q4_K_M / F32，省略则用当前设置" },
        ],
        returns: ["model_id / backend / quant / speakers / status", "500 — 权重缺失或加载失败"],
        exampleQuery: { model_id: "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice", quant: "BF16" },
      },
      {
        id: "model-unload",
        method: "POST",
        path: "/api/v1/system/models/unload",
        summary: "卸载模型释放显存",
        params: [{ name: "model_id", type: "string", description: "指定模型；省略则全部卸载" }],
        returns: ["卸载后的 manager.status()"],
      },
      {
        id: "model-download",
        method: "GET",
        path: "/api/v1/system/models/download",
        summary: "下载模型权重（SSE 进度流）",
        notes: ["响应是 text/event-stream，每个 data: 行一条 JSON 进度；stage 为 error 表示失败。"],
        params: [
          { name: "model_id", type: "string", required: true, description: "模型 ID，仅接受三个官方模型" },
          { name: "quant", type: "string", default: "BF16", description: "目标量化档位" },
        ],
        returns: ["data: {stage, …} 事件流", "400 — 未知 model_id"],
        exampleQuery: { model_id: "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice", quant: "BF16" },
      },
      {
        id: "queue",
        method: "GET",
        path: "/api/v1/system/queue",
        summary: "队列与 worker 状态",
        returns: ["queue_size / max_queue / running / queued / worker_alive"],
      },
      {
        id: "logs",
        method: "GET",
        path: "/api/v1/system/logs",
        summary: "读取日志尾部（text/plain）",
        params: [{ name: "tail", type: "integer", default: "200", description: "返回最后 N 行，1–2000" }],
        returns: ["200 text/plain", "无日志时返回 (no log file)"],
        exampleQuery: { tail: "200" },
      },
      {
        id: "clear-logs",
        method: "DELETE",
        path: "/api/v1/system/logs",
        summary: "清空日志文件",
        returns: ["ok / path / handlers（原地清空的文件句柄数）"],
      },
      {
        id: "selftest",
        method: "POST",
        path: "/api/v1/system/selftest",
        summary: "加载模型并合成一句自检语音",
        params: [{ name: "mode", type: "string", default: "custom", description: "custom / design / clone" }],
        returns: ["ok / duration_s / ttfa_ms / audio_url / status", "ok 为 false 时附带 error"],
        exampleQuery: { mode: "custom" },
      },
      {
        id: "get-settings",
        method: "GET",
        path: "/api/v1/settings",
        summary: "读取全局设置与可选值",
        returns: ["settings / options（backends / quants / languages）"],
      },
      {
        id: "update-settings",
        method: "PUT",
        path: "/api/v1/settings",
        summary: "更新全局设置",
        notes: ["只需传要改的字段；切换 backend 或 quant 会自动卸载当前模型。后端与量化会做合法值校验。"],
        params: SETTINGS_PARAMS,
        returns: ["settings / runtime", "400 — backend 或 quant 不受支持"],
        exampleBody: { backend: "ggml", quant: "Q8_0", chunk_size: 8, auth_required: false },
      },
    ],
  },
  {
    id: "keys",
    title: "鉴权",
    description: "本机回环地址始终免鉴权；强制鉴权只影响非本机请求。",
    endpoints: [
      {
        id: "list-keys",
        method: "GET",
        path: "/api/v1/apikeys",
        summary: "密钥列表与鉴权开关",
        returns: ["items（只含前缀，不含明文）/ auth_required"],
      },
      {
        id: "create-key",
        method: "POST",
        path: "/api/v1/apikeys",
        summary: "新建密钥（明文只返回一次）",
        params: [{ name: "name", type: "string", default: "default", description: "密钥名称，最长 64 字符" }],
        returns: ["key — 明文 qts_…，仅本次返回", "record — 不含哈希的记录"],
        exampleBody: { name: "my-app" },
      },
      {
        id: "delete-key",
        method: "DELETE",
        path: "/api/v1/apikeys/{key_id}",
        summary: "吊销密钥",
        params: [{ name: "key_id", type: "string", required: true, description: "密钥 ID" }],
        returns: ["200 {deleted: key_id}", "404 — 密钥不存在"],
        examplePath: "/api/v1/apikeys/key_7c1f2a",
      },
    ],
  },
  {
    id: "openai",
    title: "OpenAI 兼容",
    description: "可直接替换 OpenAI 语音接口；voice 支持三种写法。",
    endpoints: [
      {
        id: "openai-speech",
        method: "POST",
        path: "/v1/audio/speech",
        summary: "OpenAI 风格语音合成",
        notes: [
          "voice 支持三种写法：内置说话人名（serena）、voice:<音色ID>（克隆）、design:<音色描述>（声音设计）。",
          "response_format 目前只支持 wav 与 pcm；mp3 等会返回 400。",
          "speed 为兼容字段，当前不生效；instructions 在 custom / design 下作为风格指令。",
        ],
        params: [
          { name: "model", type: "string", default: "qwen3-tts", description: "兼容字段，按 voice 自动决定实际模型" },
          { name: "input", type: "string", required: true, description: "要合成的文本，最长 8000 字" },
          { name: "voice", type: "string", default: "serena", description: "内置说话人名 / voice:<音色ID> / design:<描述>" },
          { name: "response_format", type: "string", default: "wav", description: "wav 或 pcm（pcm 为裸 PCM16LE）" },
          { name: "speed", type: "number", default: "null", description: "兼容字段，当前忽略" },
          { name: "instructions", type: "string", default: "null", description: "风格指令；design 模式下也可作为音色描述" },
          { name: "language", type: "string", default: "Auto", description: "语言英文名" },
        ],
        returns: ["200 audio/wav 或 audio/L16", "400 — 未知音色 / 不支持的格式 / 对齐校验失败"],
        exampleBody: { input: "你好，这是通过 OpenAI 兼容接口合成的一段语音。", voice: "serena", language: "Chinese", response_format: "wav" },
        outputFile: "speech.wav",
      },
      {
        id: "openai-voices",
        method: "GET",
        path: "/v1/audio/voices",
        summary: "OpenAI 风格音色列表",
        returns: ["object: list / data[]（内置与克隆音色，克隆的 id 带 voice: 前缀）"],
      },
    ],
  },
];

export const CURL_NOTES = [
  "示例里的 X-API-Key 仅在开启强制鉴权且从非本机访问时需要，本机 127.0.0.1 可省略。",
  "所有时间单位为秒，音频统一 24kHz 单声道；流式接口是裸 PCM16LE，没有 WAV 头。",
  "错误响应统一为 {error: {code, message, hint}} 或 FastAPI 的 {detail: …}。",
];

export const ERROR_CODES: { code: string; status: string; meaning: string }[] = [
  { code: "empty_text", status: "400", meaning: "文本为空" },
  { code: "missing_reference", status: "400", meaning: "克隆模式没传 voice_id 或音色已被删除" },
  { code: "invalid_reference", status: "400", meaning: "音色缺少可用的参考音频 / 特征文件" },
  { code: "ref_text_mismatch", status: "400", meaning: "参考文本明显长于参考音频，ICL 会复读；改文本或改用 xvec_only" },
  { code: "unsupported_parameter", status: "400", meaning: "当前后端不支持该参数" },
  { code: "missing_instruct", status: "400", meaning: "design 模式缺少音色描述" },
  { code: "missing_speaker", status: "400", meaning: "custom 模式没有可用说话人" },
  { code: "model_not_cached", status: "400", meaning: "该模式权重尚未下载" },
  { code: "unknown_voice", status: "400", meaning: "OpenAI 兼容接口里 voice 无法解析" },
  { code: "unauthorized", status: "401", meaning: "缺少或错误的 X-API-Key / Bearer Token" },
  { code: "not_found", status: "404", meaning: "音色、历史记录、任务或密钥不存在" },
  { code: "payload_too_large", status: "413", meaning: "参考音频超过 25MB" },
  { code: "queue_full", status: "429", meaning: "队列已满，稍后重试" },
  { code: "generation_failed", status: "500", meaning: "推理失败，详见 message 与系统日志" },
  { code: "client_too_slow", status: "500", meaning: "流式下游读得太慢，服务端已丢弃积压音频并终止，重试或减小 chunk_size" },
  { code: "timeout", status: "504", meaning: "等待模型首包超时" },
];

export const SAMPLES: { label: string; code: string }[] = [
  {
    label: "OpenAI 兼容",
    code: `curl -X POST ${API_BASE}/v1/audio/speech \\
  -H 'Content-Type: application/json' \\
  -d '{
  "input": "你好，这是通过接口合成的一段语音。",
  "voice": "serena",
  "language": "Chinese",
  "response_format": "wav"
}' --output speech.wav`,
  },
  {
    label: "声音设计",
    code: `curl -X POST ${API_BASE}/api/v1/tts \\
  -H 'Content-Type: application/json' \\
  -d '{
  "mode": "design",
  "text": "夜色渐深，城市终于安静下来。",
  "instruct": "温暖沉稳的男声旁白，语速偏慢",
  "language": "Chinese"
}' --output design.wav`,
  },
  {
    label: "音色克隆",
    code: `# 1. 建音色（参考文本必须是音频里说的原话）
curl -X POST ${API_BASE}/api/v1/voices \\
  -F file=@ref.wav \\
  -F name="我的音色" \\
  -F ref_text="参考音频里说的原话" \\
  -F language="Chinese"

# 2. 用返回的 voice.id 合成新文本
curl -X POST ${API_BASE}/api/v1/tts \\
  -H 'Content-Type: application/json' \\
  -d '{
  "mode": "clone",
  "voice_id": "41a3244f1ea2",
  "text": "用这个音色念一段新的话。",
  "language": "Chinese"
}' --output clone.wav`,
  },
  {
    label: "流式播放",
    code: `curl -N -X POST ${API_BASE}/api/v1/tts/stream \\
  -H 'Content-Type: application/json' \\
  -d '{"mode":"custom","text":"流式测试，一二三四五。","speaker":"aiden","language":"Chinese"}' \\
  | ffplay -f s16le -ar 24000 -ac 1 -`,
  },
  {
    label: "Python",
    code: `import requests

res = requests.post(
    "${API_BASE}/api/v1/tts",
    json={"mode": "custom", "text": "你好", "speaker": "serena", "language": "Chinese"},
    headers={"X-API-Key": "qts_xxx"},  # 开启强制鉴权后必填
)
res.raise_for_status()
open("out.wav", "wb").write(res.content)`,
  },
];

export type ParamLocation = "path" | "query" | "body" | "form" | "frame";

/** Where a parameter goes: path placeholder, query string, JSON body, form field or WS frame. */
export function paramLocation(endpoint: ApiEndpoint, param: ApiParam): ParamLocation {
  if (endpoint.path.includes(`{${param.name}}`)) return "path";
  if (endpoint.exampleForm) return "form";
  if (endpoint.exampleBody) return "body";
  if (endpoint.method === "WS") return "frame";
  return "query";
}

function queryString(params?: Record<string, string>): string {
  if (!params) return "";
  const search = new URLSearchParams(params).toString();
  return search ? `?${search}` : "";
}

/** Build a runnable curl command for an endpoint. */
export function buildCurl(endpoint: ApiEndpoint): string {
  if (endpoint.exampleRaw) return endpoint.exampleRaw;

  const url = `${API_BASE}${endpoint.examplePath ?? endpoint.path}${queryString(endpoint.exampleQuery)}`;
  const method = endpoint.method === "GET" ? "" : `-X ${endpoint.method} `;
  const parts: string[] = [`curl ${method}'${url}'`];

  if (endpoint.exampleBody) {
    parts.push("  -H 'Content-Type: application/json'");
    if (endpoint.auth !== false) parts.push("  -H 'X-API-Key: qts_xxx'");
    const body = JSON.stringify(endpoint.exampleBody, null, 2);
    parts.push(`  -d '${body}'`);
  } else if (endpoint.exampleForm) {
    if (endpoint.auth !== false) parts.push("  -H 'X-API-Key: qts_xxx'");
    for (const [key, value] of Object.entries(endpoint.exampleForm)) {
      parts.push(`  -F '${key}=${value}'`);
    }
  } else if (endpoint.auth !== false) {
    parts.push("  -H 'X-API-Key: qts_xxx'");
  }

  if (endpoint.outputFile) parts.push(`  --output ${endpoint.outputFile}`);

  return parts.length === 1 ? parts[0] : `${parts.join(" \\\n")}`;
}
