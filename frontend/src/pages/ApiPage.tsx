import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, ExternalLink, KeyRound, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { PageHeader } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/form";
import { Badge, Separator, Spinner } from "@/components/ui/misc";
import { api } from "@/lib/api";
import { copyText, formatRelative } from "@/lib/utils";

const ENDPOINTS: { method: string; path: string; description: string }[] = [
  { method: "POST", path: "/api/v1/tts", description: "非流式合成，返回完整 WAV" },
  { method: "POST", path: "/api/v1/tts/stream", description: "流式 PCM16（24kHz 单声道）" },
  { method: "WS", path: "/api/v1/ws/tts", description: "双向流式：JSON 事件 + 二进制音频帧" },
  { method: "GET", path: "/api/v1/speakers", description: "内置说话人列表" },
  { method: "GET", path: "/api/v1/voices", description: "音色库列表" },
  { method: "POST", path: "/api/v1/voices", description: "上传参考音频（multipart）" },
  { method: "POST", path: "/api/v1/voices/{id}/sample", description: "用该音色试一句话" },
  { method: "GET", path: "/api/v1/history", description: "历史记录（分页/筛选）" },
  { method: "POST", path: "/api/v1/history/{id}/regenerate", description: "同参数重跑" },
  { method: "GET", path: "/api/v1/system/info", description: "运行时、设备与队列状态" },
  { method: "GET", path: "/api/v1/system/models", description: "模型与量化清单" },
  { method: "POST", path: "/v1/audio/speech", description: "OpenAI 兼容语音接口" },
  { method: "GET", path: "/v1/audio/voices", description: "OpenAI 兼容音色列表" },
];

const SAMPLES: { label: string; code: string }[] = [
  {
    label: "内置说话人（OpenAI 兼容）",
    code: `curl -X POST http://127.0.0.1:8000/v1/audio/speech \\
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
    code: `curl -X POST http://127.0.0.1:8000/api/v1/tts \\
  -H 'Content-Type: application/json' \\
  -d '{
    "mode": "design",
    "text": "夜色渐深，城市终于安静下来。",
    "instruct": "温暖沉稳的男声旁白，语速偏慢",
    "language": "Chinese"
  }' --output design.wav`,
  },
  {
    label: "音色克隆（先入库再调用）",
    code: `curl -X POST http://127.0.0.1:8000/api/v1/voices \\
  -F file=@ref.wav \\
  -F name="我的音色" \\
  -F ref_text="参考音频里说的原话" \\
  -F language="Chinese"

curl -X POST http://127.0.0.1:8000/api/v1/tts \\
  -H 'Content-Type: application/json' \\
  -d '{
    "mode": "clone",
    "voice_id": "<上一步返回的 voice.id>",
    "text": "用这个音色念一段新的话。",
    "language": "Chinese"
  }' --output clone.wav`,
  },
  {
    label: "流式（边生成边播）",
    code: `curl -N -X POST http://127.0.0.1:8000/api/v1/tts/stream \\
  -H 'Content-Type: application/json' \\
  -d '{"mode":"custom","text":"流式测试，一二三四五。","speaker":"aiden","language":"Chinese"}' \\
  --output - | ffplay -f s16le -ar 24000 -ac 1 -`,
  },
  {
    label: "Python 客户端",
    code: `import requests

res = requests.post(
    "http://127.0.0.1:8000/api/v1/tts",
    json={"mode": "custom", "text": "你好", "speaker": "serena", "language": "Chinese"},
    headers={"X-API-Key": "qts_xxx"},  # 开启鉴权后必填
)
res.raise_for_status()
open("out.wav", "wb").write(res.content)`,
  },
];

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="group relative rounded-lg border border-border/70 bg-background/70">
      <pre className="overflow-x-auto p-3 text-[11px] leading-relaxed text-foreground/85">
        <code>{code}</code>
      </pre>
      <Button
        variant="ghost"
        size="icon-sm"
        className="absolute right-1.5 top-1.5 opacity-0 transition-opacity group-hover:opacity-100"
        onClick={async () => {
          await copyText(code);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check className="text-primary" /> : <Copy />}
      </Button>
    </div>
  );
}

export default function ApiPage() {
  const queryClient = useQueryClient();
  const [keyName, setKeyName] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const [active, setActive] = useState(0);

  const { data } = useQuery({ queryKey: ["apikeys"], queryFn: api.keys });
  const create = useMutation({
    mutationFn: () => api.createKey(keyName || "default"),
    onSuccess: async (result) => {
      setCreated(result.key);
      setKeyName("");
      await queryClient.invalidateQueries({ queryKey: ["apikeys"] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "创建失败"),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteKey(id),
    onSuccess: async () => {
      toast.success("已吊销");
      await queryClient.invalidateQueries({ queryKey: ["apikeys"] });
    },
  });

  return (
    <div className="flex flex-col">
      <PageHeader
        title="API"
        description="同一端口既是界面也是接口；局域网访问建议开启鉴权"
        action={
          <Button variant="outline" asChild>
            <a href="/docs" target="_blank" rel="noreferrer">
              <ExternalLink /> OpenAPI 文档
            </a>
          </Button>
        }
      />

      <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle>请求示例</CardTitle>
              <CardDescription>Base URL：http://127.0.0.1:8000，音频统一 24kHz 单声道</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-1.5">
                {SAMPLES.map((sample, index) => (
                  <button
                    key={sample.label}
                    type="button"
                    onClick={() => setActive(index)}
                    className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
                      active === index
                        ? "border-primary/50 bg-primary/10 text-primary"
                        : "border-border/80 text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {sample.label}
                  </button>
                ))}
              </div>
              <CodeBlock code={SAMPLES[active].code} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle>端点</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="divide-y divide-border/60">
                {ENDPOINTS.map((endpoint) => (
                  <div key={endpoint.path} className="flex items-center gap-3 px-4 py-2 text-[11px]">
                    <Badge tone={endpoint.method === "GET" ? "muted" : endpoint.method === "WS" ? "warning" : "default"} className="w-12 justify-center">
                      {endpoint.method}
                    </Badge>
                    <code className="font-mono text-foreground/85">{endpoint.path}</code>
                    <span className="ml-auto text-right text-muted-foreground">{endpoint.description}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2">
                <KeyRound className="size-3.5" /> API Key
              </CardTitle>
              <CardDescription>
                当前{data?.auth_required ? "已开启强制鉴权" : "为本机免鉴权模式"}。开启「强制鉴权」后，非本机请求必须带 X-API-Key 或
                Bearer Token。
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex gap-2">
                <Input value={keyName} onChange={(event) => setKeyName(event.target.value)} placeholder="密钥名称" className="h-8" />
                <Button size="sm" onClick={() => create.mutate()} disabled={create.isPending}>
                  {create.isPending ? <Spinner /> : <Plus />} 新建
                </Button>
              </div>

              {created ? (
                <div className="space-y-2 rounded-lg border border-primary/30 bg-primary/10 p-2.5">
                  <p className="text-[11px] text-primary">仅显示一次，请立即保存</p>
                  <div className="flex items-center gap-2">
                    <code className="min-w-0 flex-1 truncate font-mono text-[11px]">{created}</code>
                    <Button variant="ghost" size="icon-sm" onClick={() => copyText(created)}>
                      <Copy />
                    </Button>
                  </div>
                </div>
              ) : null}

              <Separator />

              <div className="space-y-1.5">
                {(data?.items ?? []).length === 0 ? (
                  <p className="text-[11px] text-muted-foreground">还没有密钥。本机访问默认免鉴权。</p>
                ) : (
                  data?.items.map((key) => (
                    <div key={key.id} className="flex items-center gap-2 rounded-md border border-border/60 px-2 py-1.5 text-[11px]">
                      <span className="min-w-0 flex-1 truncate">{key.name}</span>
                      <code className="font-mono text-muted-foreground">{key.prefix}…</code>
                      <span className="text-muted-foreground">{formatRelative(key.last_used_at ?? key.created_at)}</span>
                      <Button variant="ghost" size="icon-sm" className="text-destructive" onClick={() => remove.mutate(key.id)}>
                        <Trash2 />
                      </Button>
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle>约定</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-[11px] leading-relaxed text-muted-foreground">
              <p>· 语音语言用英文名：Chinese / English / Japanese…，Auto 为自动判断。</p>
              <p>· 克隆模式必须先有音色（POST /voices），请求里传 voice_id。</p>
              <p>· /tts/stream 返回裸 PCM16LE，响应头 X-Sample-Rate 为采样率。</p>
              <p>· 队列满时返回 429；单卡推理串行，请求会 FIFO 排队。</p>
              <p>· ggml 后端不支持克隆模式下的风格指令，会返回 400。</p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
