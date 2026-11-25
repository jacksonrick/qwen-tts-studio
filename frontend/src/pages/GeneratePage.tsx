import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ChevronDown,
  Download,
  Mic2,
  Save,
  Sparkles,
  Square,
  Wand2,
  Waves,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { PageHeader } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Label, Slider, Switch, Textarea } from "@/components/ui/form";
import { Badge, Dialog, Progress, Spinner } from "@/components/ui/misc";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useTts } from "@/hooks/use-tts";
import { api } from "@/lib/api";
import type { Mode, SpeechRequest } from "@/lib/types";
import { cn, formatSeconds } from "@/lib/utils";

const MODES: { value: Mode; label: string; hint: string; icon: typeof Mic2 }[] = [
  { value: "design", label: "声音设计", hint: "用一句话描述，造出一个新音色", icon: Wand2 },
  { value: "clone", label: "音色克隆", hint: "用参考音频复刻说话人的音色", icon: Mic2 },
  { value: "custom", label: "语音生成", hint: "内置说话人，可直接加风格指令", icon: Waves },
];

const DESIGN_PRESETS = [
  { label: "温暖男声", text: "温暖沉稳的男声旁白，语速偏慢，娓娓道来" },
  { label: "清亮女声", text: "清亮的年轻女声，轻快活泼，带一点笑意" },
  { label: "沙哑老者", text: "沙哑沧桑的老者，气息感强，语速缓慢" },
  { label: "电台主播", text: "电台主播，中低音，字正腔圆，专业克制" },
  { label: "纪录片", text: "纪录片解说，克制而正式，句尾下沉" },
];

const STATUS_LABEL: Record<string, string> = {
  idle: "空闲",
  connecting: "连接中",
  queued: "排队中",
  loading: "加载模型",
  streaming: "生成中",
  done: "已完成",
  error: "出错",
  cancelled: "已取消",
};

export default function GeneratePage() {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode>("design");
  const [text, setText] = useState(() => localStorage.getItem("qts_draft") ?? "");
  const [language, setLanguage] = useState(() => localStorage.getItem("qts_language") ?? "Auto");
  const [speaker, setSpeaker] = useState("");
  const [instruct, setInstruct] = useState("");
  const [voiceId, setVoiceId] = useState<string>("");
  const [xvecOnly, setXvecOnly] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [voiceName, setVoiceName] = useState("");
  const [saving, setSaving] = useState(false);

  const [temperature, setTemperature] = useState(0.9);
  const [topK, setTopK] = useState(50);
  const [topP, setTopP] = useState(1);
  const [repetitionPenalty, setRepetitionPenalty] = useState(1.05);
  const [chunkSize, setChunkSize] = useState(8);
  const [appendSilence, setAppendSilence] = useState(true);

  const tts = useTts();

  const { data: info } = useQuery({ queryKey: ["info"], queryFn: api.info });
  const { data: speakers } = useQuery({ queryKey: ["speakers"], queryFn: () => api.speakers(), staleTime: 60000 });
  const { data: voices } = useQuery({ queryKey: ["voices"], queryFn: () => api.voices() });

  useEffect(() => {
    localStorage.setItem("qts_draft", text);
  }, [text]);
  useEffect(() => {
    localStorage.setItem("qts_language", language);
  }, [language]);

  // info 是全局 query，窗口重新聚焦会 refetch。高级参数只在首次拿到设置时初始化一次，
  // 否则用户手动改过的值会被后台刷新悄悄重置。
  const settingsApplied = useRef(false);
  useEffect(() => {
    if (!info || settingsApplied.current) return;
    settingsApplied.current = true;
    setChunkSize(info.settings.chunk_size);
    setTemperature(info.settings.temperature);
    setTopK(info.settings.top_k);
    setTopP(info.settings.top_p);
    setRepetitionPenalty(info.settings.repetition_penalty);
    setAppendSilence(info.settings.append_silence);
  }, [info]);

  useEffect(() => {
    if (!speaker && speakers?.speakers.length) setSpeaker(speakers.speakers[0]);
  }, [speaker, speakers]);

  const capabilities = info?.capabilities;
  const cloneInstructDisabled = mode === "clone" && capabilities ? !capabilities.supports_instruct_clone : false;
  const languages = info?.options.languages ?? ["Auto"];

  const canRun = useMemo(() => {
    if (!text.trim()) return false;
    if (mode === "clone" && !voiceId) return false;
    if (mode === "design" && !instruct.trim()) return false;
    return true;
  }, [text, mode, voiceId, instruct]);

  const buildRequest = (): SpeechRequest => ({
    mode,
    text: text.trim(),
    language,
    speaker: mode === "custom" ? speaker : undefined,
    // ggml 后端的克隆模式不接受风格指令，禁用时不要把它带上去
    instruct: mode === "clone" && cloneInstructDisabled ? "" : instruct.trim(),
    voice_id: mode === "clone" ? voiceId : null,
    xvec_only: xvecOnly,
    temperature,
    top_k: topK,
    top_p: topP,
    repetition_penalty: repetitionPenalty,
    chunk_size: chunkSize,
    append_silence: appendSilence,
  });

  const guard = () => {
    if (!text.trim()) {
      toast.error("请先输入要合成的文本");
      return false;
    }
    if (mode === "clone" && !voiceId) {
      toast.error("请先在音色库准备一个参考音色");
      return false;
    }
    if (mode === "design" && !instruct.trim()) {
      toast.error("声音设计需要一段音色描述");
      return false;
    }
    return true;
  };

  const run = (streaming: boolean) => {
    if (!guard()) return;
    void tts.start(buildRequest(), { streaming });
  };

  const saveAsVoice = async () => {
    if (!tts.result?.audioUrl) return;
    setSaving(true);
    try {
      const response = await fetch(tts.result.audioUrl);
      const blob = await response.blob();
      const form = new FormData();
      form.append("file", new File([blob], "take.wav", { type: "audio/wav" }));
      form.append("name", voiceName.trim() || `音色 ${new Date().toLocaleTimeString()}`);
      form.append("ref_text", text.trim());
      form.append("language", language);
      form.append("instruct", instruct.trim());
      form.append("xvec_only", String(xvecOnly));
      form.append("source_history_id", tts.result.recordId ?? "");
      const result = await api.createVoice(form);
      if (result.instruct_ignored) {
        toast.warning("已存入音色库（ggml 后端克隆不支持风格指令，已忽略）");
      } else {
        toast.success(
          result.truncated ? "已存入音色库（参考音频截为前 30 秒，参考文本同步截断）" : "已存入音色库",
        );
      }
      setSaveOpen(false);
      setVoiceName("");
      await queryClient.invalidateQueries({ queryKey: ["voices"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col xl:h-full">
      <PageHeader
        title="生成台"
        description="语气、音色、文本一次调好，边生成边听"
        action={
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <Badge tone={tts.status === "error" ? "danger" : tts.status === "done" ? "success" : tts.isBusy ? "warning" : "muted"}>
              {tts.isBusy && <Spinner className="size-2.5" />}
              {STATUS_LABEL[tts.status]}
            </Badge>
            {info ? <span>{info.settings.quant} · {info.runtime.backend}</span> : null}
          </div>
        }
      />

      <div className="grid gap-4 p-4 xl:min-h-0 xl:flex-1 xl:grid-cols-[minmax(320px,380px)_minmax(0,1fr)]">
        <div className="space-y-3">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle>工作模式</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Tabs value={mode} onValueChange={(value) => setMode(value as Mode)}>
                <TabsList className="grid w-full grid-cols-3">
                  {MODES.map(({ value, label }) => (
                    <TabsTrigger key={value} value={value}>
                      {label}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {MODES.find((item) => item.value === mode)?.hint}
              </p>

              {mode === "custom" ? (
                <Field label="内置说话人" hint={speakers?.loaded ? "来自已加载模型" : "模型加载后会自动校正"}>
                  <Select value={speaker} onValueChange={setSpeaker}>
                    <SelectTrigger>
                      <SelectValue placeholder="选择说话人" />
                    </SelectTrigger>
                    <SelectContent>
                      {(speakers?.speakers ?? []).map((name) => (
                        <SelectItem key={name} value={name}>
                          {name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              ) : null}

              {mode === "clone" ? (
                <Field
                  label="参考音色"
                  hint={voices?.items.length ? "来自音色库，建议同时提供参考文本" : "音色库还是空的，先去上传一段参考音频"}
                >
                  <Select value={voiceId} onValueChange={setVoiceId}>
                    <SelectTrigger>
                      <SelectValue placeholder={voices?.items.length ? "选择音色" : "暂无音色"} />
                    </SelectTrigger>
                    <SelectContent>
                      {(voices?.items ?? []).map((voice) => (
                        <SelectItem key={voice.id} value={voice.id}>
                          {voice.name} · {voice.language ?? "Auto"}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              ) : null}

              {mode === "design" ? (
                <Field label="音色描述" hint="描述越具体，结果越稳定：性别、年龄、音质、语速、情绪">
                  <Textarea
                    value={instruct}
                    onChange={(event) => setInstruct(event.target.value)}
                    placeholder="例如：温暖沉稳的男声旁白，语速偏慢，略带沙哑"
                    className="min-h-20"
                  />
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {DESIGN_PRESETS.map((preset) => (
                      <button
                        key={preset.label}
                        type="button"
                        onClick={() => setInstruct(preset.text)}
                        className="rounded-full border border-border/80 px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary"
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </Field>
              ) : null}

              {mode !== "design" ? (
                <Field
                  label={
                    <span className="flex items-center gap-1.5">
                      风格指令
                      <span className="text-[10px] font-normal text-muted-foreground/70">可选</span>
                    </span>
                  }
                  hint={
                    cloneInstructDisabled ? "当前为 ggml 后端，克隆模式不支持风格指令" : "补充情绪、语速、场景等要求"
                  }
                >
                  <Textarea
                    value={instruct}
                    onChange={(event) => setInstruct(event.target.value)}
                    disabled={cloneInstructDisabled}
                    placeholder="例如：语速稍快，带一点兴奋"
                    className="min-h-16"
                  />
                </Field>
              ) : null}

              {mode === "clone" ? (
                <div className="flex items-center justify-between rounded-lg border border-border/70 bg-muted/20 px-3 py-2">
                  <div>
                    <Label>仅用说话人特征</Label>
                    <p className="mt-0.5 text-[10px] text-muted-foreground">
                      x-vector 模式，不依赖参考文本，跨语言更干净，也不会复读参考内容
                    </p>
                  </div>
                  <Switch checked={xvecOnly} onCheckedChange={setXvecOnly} />
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <button
              type="button"
              onClick={() => setAdvanced((prev) => !prev)}
              className="flex w-full items-center justify-between px-4 py-3 text-xs font-medium"
            >
              高级参数
              <ChevronDown className={cn("size-3.5 text-muted-foreground transition-transform", advanced && "rotate-180")} />
            </button>
            {advanced ? (
              <CardContent className="space-y-3 border-t border-border/70 pt-3">
                <SliderRow label="温度" value={temperature} min={0} max={1.5} step={0.05} onChange={setTemperature} />
                <SliderRow label="Top-k" value={topK} min={0} max={200} step={1} onChange={setTopK} />
                <SliderRow label="Top-p" value={topP} min={0.1} max={1} step={0.01} onChange={setTopP} />
                <SliderRow
                  label="重复惩罚"
                  value={repetitionPenalty}
                  min={0.8}
                  max={1.5}
                  step={0.01}
                  onChange={setRepetitionPenalty}
                />
                <SliderRow
                  label="流式分段（步）"
                  value={chunkSize}
                  min={1}
                  max={32}
                  step={1}
                  onChange={setChunkSize}
                  hint={`约 ${Math.round((chunkSize / 12) * 1000)}ms 音频/包`}
                />
                <div className="flex items-center justify-between pt-1">
                  <div>
                    <Label>参考音频尾部补静音</Label>
                    <p className="mt-0.5 text-[10px] text-muted-foreground">避免 ICL 克隆时开头音素被污染</p>
                  </div>
                  <Switch checked={appendSilence} onCheckedChange={setAppendSilence} />
                </div>
              </CardContent>
            ) : null}
          </Card>
        </div>

        <div className="flex min-w-0 flex-col gap-3 xl:min-h-0">
          <Card className="flex min-h-[280px] flex-col xl:h-[400px] xl:shrink-0">
            <CardHeader className="flex-row items-center justify-between pb-2">
              <div>
                <CardTitle>要说的内容</CardTitle>
                <CardDescription>{text.length} 字 · 超过 {info?.settings.long_text_threshold ?? 600} 字会自动分段</CardDescription>
              </div>
              <div className="flex items-center gap-1.5">
                <Button variant="ghost" size="sm" onClick={() => setText("")} disabled={!text}>
                  清空
                </Button>
              </div>
            </CardHeader>
            <CardContent className="flex min-h-0 flex-1 flex-col gap-3">
              <Textarea
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder="输入或粘贴要合成的文本。中文、英文都可以，长文会自动按句切分，逐句生成并连续播放。"
                className="min-h-40 flex-1 resize-none text-[13px]"
              />
              <div className="flex flex-wrap items-center gap-2">
                <div className="w-[132px]">
                  <Select value={language} onValueChange={setLanguage}>
                    <SelectTrigger className="h-8">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {languages.map((item) => (
                        <SelectItem key={item} value={item}>
                          {item}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="ml-auto flex items-center gap-2">
                  {tts.isBusy ? (
                    <Button variant="destructive" onClick={tts.stop}>
                      <Square /> 停止
                    </Button>
                  ) : null}
                  <Button variant="outline" onClick={() => run(false)} disabled={!canRun || tts.isBusy}>
                    <Download /> 生成完整音频
                  </Button>
                  <Button onClick={() => run(true)} disabled={!canRun || tts.isBusy}>
                    <Zap /> 流式播放
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="flex flex-col xl:min-h-[200px] xl:flex-1 xl:overflow-hidden">
            <CardHeader className="shrink-0 pb-2">
              <CardTitle className="flex items-center gap-2">
                运行状态
                {tts.segments && tts.segments.total > 1 ? (
                  <Badge tone="muted">
                    第 {tts.segments.index + 1}/{tts.segments.total} 段
                  </Badge>
                ) : null}
              </CardTitle>
            </CardHeader>
            <CardContent className="min-h-0 flex-1 space-y-3 xl:overflow-y-auto">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Metric label="首包延迟" value={tts.metrics.ttfaMs ? `${Math.round(tts.metrics.ttfaMs)} ms` : "—"} />
                <Metric label="RTF" value={tts.metrics.rtf ? tts.metrics.rtf.toFixed(2) : "—"} />
                <Metric label="音频时长" value={tts.metrics.audioSeconds ? formatSeconds(tts.metrics.audioSeconds) : "—"} />
                <Metric label="数据包" value={tts.metrics.chunks ? String(tts.metrics.chunks) : "—"} />
              </div>

              {tts.isBusy && tts.status === "streaming" ? (
                <Progress value={Math.min(96, (tts.metrics.audioSeconds / Math.max(2, text.length / 5)) * 100)} />
              ) : null}

              {["connecting", "queued", "loading"].includes(tts.status) ? (
                <p className="rounded-md border border-border/60 bg-muted/20 px-2.5 py-2 text-[11px] text-muted-foreground">
                  {tts.status === "loading"
                    ? "正在加载模型，首次使用需要把权重读入内存（约 5–10 秒），之后同一模型会常驻复用。"
                    : tts.status === "queued"
                      ? `排队中，前面还有 ${tts.metrics.queuePosition ?? 0} 个任务。`
                      : "正在建立连接…"}
                </p>
              ) : null}

              {tts.error ? (
                <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-destructive" />
                  <div>
                    <p className="font-medium text-destructive">{tts.error.message}</p>
                    {tts.error.hint ? <p className="mt-0.5 text-muted-foreground">{tts.error.hint}</p> : null}
                  </div>
                </div>
              ) : null}

              {tts.result?.audioUrl ? (
                <div className="space-y-2 rounded-lg border border-border/70 bg-muted/20 p-3">
                  <audio key={tts.result.audioUrl} controls src={tts.result.audioUrl} className="w-full" />
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[11px] text-muted-foreground">
                      {tts.result.durationS ? formatSeconds(tts.result.durationS) : ""}
                      {tts.result.recordId ? ` · ${tts.result.recordId.slice(0, 8)}` : ""}
                    </span>
                    <div className="ml-auto flex gap-2">
                      <Button variant="ghost" size="sm" asChild>
                        <a href={tts.result.audioUrl} download>
                          <Download /> 下载
                        </a>
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => setSaveOpen(true)}>
                        <Save /> 存为音色
                      </Button>
                    </div>
                  </div>
                </div>
              ) : null}

              {!tts.result?.audioUrl && !tts.isBusy && !tts.error ? (
                <p className="rounded-lg border border-dashed border-border/70 px-3 py-5 text-center text-[11px] leading-relaxed text-muted-foreground">
                  还没有生成结果 · 「流式播放」边生成边听，「生成完整音频」拿整段 WAV
                </p>
              ) : null}
            </CardContent>
          </Card>
        </div>
      </div>

      <Dialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        title="存为音色"
        description="把这次生成结果作为参考音频存入音色库，之后可以直接复用它的音色。"
        footer={
          <>
            <Button variant="ghost" onClick={() => setSaveOpen(false)}>
              取消
            </Button>
            <Button onClick={saveAsVoice} disabled={saving}>
              {saving ? <Spinner /> : <Sparkles />} 保存
            </Button>
          </>
        }
      >
        <Field label="音色名称">
          <Input value={voiceName} onChange={(event) => setVoiceName(event.target.value)} placeholder="例如：纪录片男声 v1" />
        </Field>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          参考文本取当前输入的全文。生成音频超过 30 秒时会截取前 30 秒，参考文本自动收敛到这段音频对应的长度，
          保证文本与音频严格对应（ICL 克隆对不齐就会复读参考内容）。
        </p>
      </Dialog>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border/70 bg-muted/20 px-3 py-2">
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-sm font-medium tabular-nums">{value}</p>
    </div>
  );
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  onChange,
  hint,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  hint?: string;
}) {
  return (
    <div>
      <div className="flex items-center justify-between">
        <Label>{label}</Label>
        <span className="text-[11px] tabular-nums text-muted-foreground">{value}</span>
      </div>
      <Slider value={[value]} min={min} max={max} step={step} onValueChange={([next]) => onChange(next)} />
      {hint ? <p className="-mt-1 text-[10px] text-muted-foreground/80">{hint}</p> : null}
    </div>
  );
}
