import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, Cpu, Download, HardDrive, RefreshCw, Save, Terminal, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { PageHeader } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Label, Switch } from "@/components/ui/form";
import { Badge, Dialog, Progress, Separator, Spinner } from "@/components/ui/misc";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, streamDownload } from "@/lib/api";
import type { Settings } from "@/lib/types";
import { formatBytes } from "@/lib/utils";

export default function SystemPage() {
  const queryClient = useQueryClient();
  const { data: info, refetch: refetchInfo } = useQuery({ queryKey: ["info"], queryFn: api.info });
  const { data: models, refetch: refetchModels } = useQuery({ queryKey: ["models"], queryFn: api.models });
  const { data: settingsData } = useQuery({ queryKey: ["settings"], queryFn: api.settings });

  const [draft, setDraft] = useState<Settings | null>(null);
  const [loadingModel, setLoadingModel] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<{ key: string; percent: number } | null>(null);
  const [logsOpen, setLogsOpen] = useState(false);
  const [logsText, setLogsText] = useState<string | null>(null);
  const [logsBusy, setLogsBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const logRef = useRef<HTMLPreElement | null>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    if (settingsData?.settings && !draft) setDraft(settingsData.settings);
  }, [settingsData, draft]);

  const refreshAll = async () => {
    await Promise.all([refetchInfo(), refetchModels()]);
    await queryClient.invalidateQueries({ queryKey: ["settings"] });
  };

  const patch = (changes: Partial<Settings>) => setDraft((prev) => (prev ? { ...prev, ...changes } : prev));

  const saveSettings = async () => {
    if (!draft) return;
    try {
      await api.updateSettings(draft);
      toast.success("设置已保存");
      setDraft(null);
      await refreshAll();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存失败");
    }
  };

  const load = async (modelId: string, quant: string) => {
    setLoadingModel(`${modelId}:${quant}`);
    try {
      const result = await api.loadModel(modelId, quant);
      toast.success(`已加载 ${result.model_id.split("/").pop()} · ${result.quant}`);
      await refreshAll();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "加载失败");
    } finally {
      setLoadingModel(null);
    }
  };

  const unload = async () => {
    try {
      await api.unloadModel();
      toast.success("已卸载，内存已释放");
      await refreshAll();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "卸载失败");
    }
  };

  const download = async (modelId: string, quant: string) => {
    const key = `${modelId}:${quant}`;
    setDownloading({ key, percent: 0 });
    try {
      await streamDownload(modelId, quant, (payload) => {
        if (typeof payload.percent === "number") setDownloading({ key, percent: payload.percent });
        if (payload.stage === "error") toast.error(String(payload.message ?? "下载失败"));
      });
      toast.success("下载完成");
      await refreshAll();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "下载失败");
    } finally {
      setDownloading(null);
    }
  };

  const fetchLogs = async (quiet = false) => {
    if (!quiet) setLogsBusy(true);
    try {
      const blob = await api.logs(400);
      setLogsText(await blob.text());
    } catch {
      if (!quiet) toast.error("读取日志失败");
    } finally {
      if (!quiet) setLogsBusy(false);
    }
  };

  const openLogs = () => {
    stickToBottom.current = true;
    setLogsOpen(true);
    void fetchLogs();
  };

  const clearLogs = async () => {
    if (!confirm("清空服务端日志文件？已写入的日志会被删除。")) return;
    try {
      await api.clearLogs();
      stickToBottom.current = true;
      await fetchLogs();
      toast.success("日志已清空");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "清空失败");
    }
  };

  // 弹窗打开时每 4 秒静默刷新一次，方便边生成边看
  useEffect(() => {
    if (!logsOpen) return;
    const timer = window.setInterval(() => void fetchLogs(true), 4000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logsOpen]);

  useEffect(() => {
    const node = logRef.current;
    if (node && stickToBottom.current) node.scrollTop = node.scrollHeight;
  }, [logsText, logsOpen]);

  const onLogScroll = () => {
    const node = logRef.current;
    if (!node) return;
    stickToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 32;
  };

  const selftest = async (mode: string) => {
    setTesting(true);
    try {
      const result = await api.selftest(mode);
      if (result.ok) toast.success(`自检通过：${result.duration_s?.toFixed(2)}s 音频，首包 ${result.ttfa_ms}ms`);
      else toast.error(result.error?.message ?? "自检失败");
      await refreshAll();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "自检失败");
    } finally {
      setTesting(false);
    }
  };

  const runtime = info?.runtime;
  const status = models?.status;

  return (
    <div className="flex flex-col">
      <PageHeader
        title="系统"
        description="模型、后端与默认参数都在这里管理"
        action={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={openLogs}>
              <Terminal /> 日志
            </Button>
            <Button variant="outline" size="sm" onClick={refreshAll}>
              <RefreshCw /> 刷新
            </Button>
          </div>
        }
      />

      <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2">
                <Cpu className="size-3.5" /> 运行环境
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2 sm:grid-cols-2">
              <Info label="推理后端" value={`${runtime?.backend ?? "—"} · ${runtime?.device ?? "—"}`} />
              <Info label="加速硬件" value={runtime?.gpu ?? "—"} />
              <Info label="torch" value={runtime?.torch_version ?? "未安装"} />
              <Info label="qwentts.cpp" value={runtime?.qwentts_version ?? "未安装"} />
              <Info label="Python" value={`${runtime?.python ?? "—"} · ${runtime?.system ?? ""} ${runtime?.machine ?? ""}`} />
              <Info label="进程内存" value={status?.rss_mb ? `${status.rss_mb} MB` : "—"} />
              {(runtime?.warnings ?? []).map((warning) => (
                <p key={warning} className="sm:col-span-2 rounded-md bg-amber-500/10 px-2 py-1 text-[11px] text-amber-300">
                  {warning}
                </p>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex-row items-center justify-between pb-2">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <HardDrive className="size-3.5" /> 模型与量化
                </CardTitle>
                <CardDescription>
                  {status?.status === "ready"
                    ? `已加载 ${status.resident.map((id) => id.split("/").pop()).join(", ")}`
                    : status?.status === "loading"
                      ? `正在加载 ${status.loading?.split("/").pop()}`
                      : "当前无驻留模型"}
                  {status?.load_ms ? ` · 上次加载 ${(status.load_ms / 1000).toFixed(1)}s` : ""}
                </CardDescription>
              </div>
              <Button variant="outline" size="sm" onClick={unload} disabled={!status?.resident.length}>
                卸载
              </Button>
            </CardHeader>
            <CardContent className="space-y-3 p-0">
              {(models?.models ?? []).map((entry) => (
                <div key={entry.model_id} className="border-t border-border/60 px-4 pt-2 first:border-t-0 first:pt-0">
                  <div className="flex items-center gap-2 pb-1.5">
                    <span className="text-[12px] font-medium">{entry.label}</span>
                    <code className="text-[10px] text-muted-foreground">{entry.model_id}</code>
                    {entry.resident ? <Badge tone="success">已驻留</Badge> : null}
                  </div>
                  <div className="grid gap-1.5 pb-2 sm:grid-cols-2">
                    {entry.quants.map((quant) => {
                      const key = `${entry.model_id}:${quant.quant}`;
                      const isDownloading = downloading?.key === key;
                      return (
                        <div
                          key={quant.quant}
                          className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/15 px-2 py-1.5"
                        >
                          <span className="w-14 font-mono text-[11px]">{quant.quant}</span>
                          <span className="flex-1 text-[10px] text-muted-foreground">
                            {quant.cached ? formatBytes(quant.size_bytes) : "未下载"}
                          </span>
                          {quant.cached ? (
                            <Button
                              size="sm"
                              variant={entry.resident && status?.quant === quant.quant ? "ghost" : "outline"}
                              disabled={loadingModel !== null}
                              onClick={() => load(entry.model_id, quant.quant)}
                            >
                              {loadingModel === key ? <Spinner /> : entry.resident && status?.quant === quant.quant ? "已加载" : "加载"}
                            </Button>
                          ) : (
                            <Button size="sm" variant="outline" disabled={Boolean(downloading)} onClick={() => download(entry.model_id, quant.quant)}>
                              {isDownloading ? <Spinner /> : <Download />}
                              {isDownloading ? `${downloading?.percent ?? 0}%` : "下载"}
                            </Button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {downloading?.key.startsWith(entry.model_id) ? <Progress value={downloading.percent} className="mb-2" /> : null}
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2">
                <Activity className="size-3.5" /> 队列与自检
              </CardTitle>
              <CardDescription>
                单卡串行推理：排队 {info?.queue.queued ?? 0} · 运行 {info?.queue.running ?? 0} · 上限 {info?.queue.max_queue ?? 0}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              {["custom", "design", "clone"].map((mode) => (
                <Button key={mode} size="sm" variant="outline" disabled={testing} onClick={() => selftest(mode)}>
                  {testing ? <Spinner /> : <Activity />} {mode} 自检
                </Button>
              ))}
              <span className="self-center text-[10px] text-muted-foreground">自检会真实合成一句短文本并落一条历史</span>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle>默认设置</CardTitle>
              <CardDescription>修改后端或量化会卸载当前模型</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <Field label="后端">
                  <Select value={draft?.backend ?? "auto"} onValueChange={(value) => patch({ backend: value })}>
                    <SelectTrigger className="h-8">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">auto</SelectItem>
                      <SelectItem value="ggml">ggml</SelectItem>
                      <SelectItem value="torch">torch</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="量化">
                  <Select value={draft?.quant ?? "BF16"} onValueChange={(value) => patch({ quant: value })}>
                    <SelectTrigger className="h-8">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(settingsData?.options.quants ?? ["BF16"]).map((quant) => (
                        <SelectItem key={quant} value={quant}>
                          {quant}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <Field label="流式分段（步）">
                  <Input
                    type="number"
                    min={1}
                    max={48}
                    value={draft?.chunk_size ?? 8}
                    onChange={(event) => patch({ chunk_size: Number(event.target.value) })}
                  />
                </Field>
                <Field label="队列上限">
                  <Input
                    type="number"
                    min={1}
                    max={64}
                    value={draft?.max_queue ?? 8}
                    onChange={(event) => patch({ max_queue: Number(event.target.value) })}
                  />
                </Field>
              </div>

              <Field label="长文本阈值（字）" hint="超过后自动按句切分逐句生成">
                <Input
                  type="number"
                  min={120}
                  max={4000}
                  value={draft?.long_text_threshold ?? 600}
                  onChange={(event) => patch({ long_text_threshold: Number(event.target.value) })}
                />
              </Field>

              <Separator />

              <div className="grid grid-cols-2 gap-2">
                <Field label="温度">
                  <Input
                    type="number"
                    step={0.05}
                    value={draft?.temperature ?? 0.9}
                    onChange={(event) => patch({ temperature: Number(event.target.value) })}
                  />
                </Field>
                <Field label="Top-k">
                  <Input
                    type="number"
                    value={draft?.top_k ?? 50}
                    onChange={(event) => patch({ top_k: Number(event.target.value) })}
                  />
                </Field>
                <Field label="Top-p">
                  <Input
                    type="number"
                    step={0.01}
                    value={draft?.top_p ?? 1}
                    onChange={(event) => patch({ top_p: Number(event.target.value) })}
                  />
                </Field>
                <Field label="重复惩罚">
                  <Input
                    type="number"
                    step={0.01}
                    value={draft?.repetition_penalty ?? 1.05}
                    onChange={(event) => patch({ repetition_penalty: Number(event.target.value) })}
                  />
                </Field>
              </div>

              <Separator />

              <ToggleRow
                label="模型常驻"
                hint="关闭后每次请求结束即释放内存"
                checked={draft?.keep_model_loaded ?? true}
                onChange={(value) => patch({ keep_model_loaded: value })}
              />
              <ToggleRow
                label="强制鉴权"
                hint="局域网访问需带 API Key"
                checked={draft?.auth_required ?? false}
                onChange={(value) => patch({ auth_required: value })}
              />
              <ToggleRow
                label="长文本自动分段"
                hint="逐句生成，边生成边播"
                checked={draft?.split_long_text ?? true}
                onChange={(value) => patch({ split_long_text: value })}
              />
              <ToggleRow
                label="参考音频补静音"
                hint="避免克隆开头音素污染"
                checked={draft?.append_silence ?? true}
                onChange={(value) => patch({ append_silence: value })}
              />

              <Button className="w-full" onClick={saveSettings} disabled={!draft}>
                <Save /> 保存设置
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle>数据目录</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-[11px] text-muted-foreground">
              <p className="font-mono break-all">{info?.paths.data}</p>
              <p>音频 {info?.paths.audio}</p>
              <p>音色 {info?.paths.voices}</p>
              <p className="pt-1">队列 worker {info?.queue.worker_alive ? "在线" : "离线"} · 单卡串行推理</p>
            </CardContent>
          </Card>
        </div>
      </div>

      <Dialog
        open={logsOpen}
        onOpenChange={setLogsOpen}
        size="wide"
        title="服务端日志"
        description="末尾 400 行 · 打开时每 4 秒自动刷新，向上翻会自动停住"
        footer={
          <>
            <Button variant="ghost" className="mr-auto text-destructive" onClick={clearLogs} disabled={!logsText?.trim()}>
              <Trash2 /> 清空日志
            </Button>
            <Button variant="outline" onClick={() => void fetchLogs()} disabled={logsBusy}>
              {logsBusy ? <Spinner /> : <RefreshCw />} 刷新
            </Button>
            <Button onClick={() => setLogsOpen(false)}>关闭</Button>
          </>
        }
      >
        <pre
          ref={logRef}
          onScroll={onLogScroll}
          className="max-h-[62vh] min-h-[220px] overflow-auto rounded-lg border border-border/70 bg-background/70 p-3 text-[10.5px] leading-relaxed whitespace-pre-wrap break-words text-muted-foreground"
        >
          {logsText === null ? "读取中…" : logsText.trim() || "(日志为空)"}
        </pre>
      </Dialog>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/15 px-2.5 py-1.5">
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className="truncate text-[12px]" title={value}>
        {value}
      </p>
    </div>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div>
        <Label>{label}</Label>
        <p className="mt-0.5 text-[10px] text-muted-foreground">{hint}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
