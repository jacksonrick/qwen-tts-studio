import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Loader2, Mic, Play, Sparkles, Trash2, Upload, Wand2 } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { PageHeader } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Label, Switch, Textarea } from "@/components/ui/form";
import { Badge, Dialog, EmptyState, Spinner } from "@/components/ui/misc";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import type { Voice } from "@/lib/types";
import { formatRelative } from "@/lib/utils";
import { recordedBlobToWav } from "@/lib/wav";

export default function VoicesPage() {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [name, setName] = useState("");
  const [refText, setRefText] = useState("");
  const [language, setLanguage] = useState("Auto");
  const [xvecOnly, setXvecOnly] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState<string | null>(null);
  const [preparing, setPreparing] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const { data, isLoading } = useQuery({ queryKey: ["voices", query], queryFn: () => api.voices({ query }) });
  const { data: info } = useQuery({ queryKey: ["info"], queryFn: api.info });
  const languages = info?.options.languages ?? ["Auto"];

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["voices"] });
  };

  const pickFile = (picked: File | null) => {
    if (!picked) return;
    if (!picked.type.startsWith("audio") && !/\.(wav|mp3|flac|m4a|ogg|opus|webm)$/i.test(picked.name)) {
      toast.error("请选择音频文件");
      return;
    }
    setFile(picked);
    if (!name) setName(picked.name.replace(/\.[^.]+$/, ""));
  };

  const toggleRecording = async () => {
    if (recording) {
      recorderRef.current?.stop();
      setRecording(false);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunksRef.current.push(event.data);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        const raw = new Blob(chunksRef.current, { type: recorder.mimeType });
        try {
          const wav = await recordedBlobToWav(raw);
          setFile(new File([wav], "recording.wav", { type: "audio/wav" }));
          if (!name) setName(`录音 ${new Date().toLocaleTimeString()}`);
          toast.success("录音完成，已转换为 WAV");
        } catch {
          toast.error("录音转换失败");
        }
      };
      recorder.start();
      recorderRef.current = recorder;
      setRecording(true);
    } catch {
      toast.error("无法访问麦克风");
    }
  };

  const submitUpload = async () => {
    if (!file) {
      toast.error("请先选择或录制一段音频");
      return;
    }
    setBusy(true);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("name", name.trim() || "未命名音色");
      form.append("ref_text", refText.trim());
      form.append("language", language);
      form.append("xvec_only", String(xvecOnly));
      const result = await api.createVoice(form);
      toast.success(`已保存（参考音频 ${result.duration_s}s）`);
      setUploadOpen(false);
      setFile(null);
      setName("");
      setRefText("");
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };

  const playSample = async (voice: Voice) => {
    setPlaying(voice.id);
    try {
      const blob = await api.sampleVoice(voice.id, "你好，这是我的声音，很高兴认识你。", voice.language ?? "Auto");
      const audio = new Audio(URL.createObjectURL(blob));
      audio.onended = () => setPlaying(null);
      await audio.play();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "试音失败");
      setPlaying(null);
    }
  };

  const prepare = async (voice: Voice) => {
    if (preparing) return;
    setPreparing(voice.id);
    try {
      const result = await api.prepareVoice(voice.id);
      if (result.prepared?.saved) toast.success("音色特征已提取，克隆首包会更快");
      else toast.message(result.prepared?.reason ?? "当前后端不支持预提取，生成时会自动处理");
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "提取失败");
    } finally {
      setPreparing(null);
    }
  };

  const remove = async (voice: Voice) => {
    if (!confirm(`删除音色「${voice.name}」？`)) return;
    try {
      await api.deleteVoice(voice.id);
      toast.success("已删除");
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除失败");
    }
  };

  return (
    <div className="flex flex-col">
      <PageHeader
        title="音色库"
        description="参考音频、设计成品都在这里；克隆时直接选用"
        action={<Button onClick={() => setUploadOpen(true)}>
          <Upload /> 添加音色
        </Button>}
      />

      <div className="space-y-4 p-4">
        <div className="flex items-center gap-2">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索名称、标签或参考文本"
            className="max-w-sm"
          />
          <span className="text-[11px] text-muted-foreground">{data?.total ?? 0} 个音色</span>
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner /> 加载中
          </div>
        ) : data?.items.length ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {data.items.map((voice) => (
              <Card key={voice.id} className="flex flex-col">
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <CardTitle className="truncate">{voice.name}</CardTitle>
                      <CardDescription>
                        {voice.language ?? "Auto"} · {voice.ref_text ? `${voice.ref_text.slice(0, 18)}…` : "无参考文本"}
                      </CardDescription>
                    </div>
                    <Badge tone={voice.has_ref_spk ? "success" : "muted"}>{voice.has_ref_spk ? "已提特征" : "参考音频"}</Badge>
                  </div>
                </CardHeader>
                <CardContent className="flex flex-1 flex-col gap-2">
                  {voice.audio_url ? <audio controls src={voice.audio_url} className="w-full" preload="none" /> : null}
                  <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
                    <Button variant="ghost" size="sm" onClick={() => playSample(voice)} disabled={playing === voice.id}>
                      {playing === voice.id ? <Loader2 className="animate-spin" /> : <Play />} 试音
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => prepare(voice)}
                      disabled={preparing !== null}
                      aria-busy={preparing === voice.id}
                      title={voice.has_ref_spk ? "重新提取参考特征" : "预提取 ggml 参考特征，克隆首包更快"}
                    >
                      {preparing === voice.id ? <Loader2 className="animate-spin" /> : <Wand2 />}
                      {preparing === voice.id ? "提取中" : "提特征"}
                    </Button>
                    <Button variant="ghost" size="sm" asChild>
                      <a href={api.voiceExportUrl(voice.id)} download>
                        <Download /> 导出
                      </a>
                    </Button>
                    <Button variant="ghost" size="sm" className="ml-auto text-destructive" onClick={() => remove(voice)}>
                      <Trash2 />
                    </Button>
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    使用 {voice.use_count} 次 · {formatRelative(voice.created_at)}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <EmptyState
            title="音色库还是空的"
            description="上传一段 5–20 秒干净人声，或直接在生成台把生成结果存为音色。参考文本与音频内容越吻合，克隆越像。"
            action={
              <Button className="mt-2" onClick={() => setUploadOpen(true)}>
                <Upload /> 添加第一个音色
              </Button>
            }
          />
        )}
      </div>

      <Dialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        title="添加参考音色"
        description="支持 wav / mp3 / flac / m4a，建议 5–20 秒、单人、无背景音乐。"
        footer={
          <>
            <Button variant="ghost" onClick={() => setUploadOpen(false)}>
              取消
            </Button>
            <Button onClick={submitUpload} disabled={busy || !file}>
              {busy ? <Spinner /> : <Sparkles />} 保存到音色库
            </Button>
          </>
        }
      >
        <div
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            pickFile(event.dataTransfer.files?.[0] ?? null);
          }}
          className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-muted/20 px-4 py-6 text-center"
        >
          <input
            ref={inputRef}
            type="file"
            accept="audio/*"
            className="hidden"
            onChange={(event) => pickFile(event.target.files?.[0] ?? null)}
          />
          <Mic className="size-5 text-muted-foreground" />
          <p className="text-xs text-muted-foreground">{file ? file.name : "拖入音频文件，或使用下面的按钮"}</p>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => inputRef.current?.click()}>
              <Upload /> 选择文件
            </Button>
            <Button size="sm" variant={recording ? "destructive" : "secondary"} onClick={toggleRecording}>
              <Mic /> {recording ? "停止录音" : "录音"}
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="音色名称">
            <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：我的声音" />
          </Field>
          <Field label="语言">
            <Select value={language} onValueChange={setLanguage}>
              <SelectTrigger>
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
          </Field>
        </div>

        <Field label="参考文本（强烈建议填）" hint="音频里说的原话，逐字一致。填了走 ICL 克隆，音色更像。">
          <Textarea
            value={refText}
            onChange={(event) => setRefText(event.target.value)}
            placeholder="例如：今天天气不错，我们出去走走吧。"
            className="min-h-16"
          />
        </Field>

        <div className="flex items-center justify-between rounded-lg border border-border/70 px-3 py-2">
          <div>
            <Label>没有参考文本</Label>
            <p className="mt-0.5 text-[10px] text-muted-foreground">改用 x-vector 模式，只用说话人特征</p>
          </div>
          <Switch checked={xvecOnly} onCheckedChange={setXvecOnly} />
        </div>
      </Dialog>
    </div>
  );
}
