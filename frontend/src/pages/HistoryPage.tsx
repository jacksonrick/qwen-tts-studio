import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Download, Eraser, Play, RefreshCw, Save, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { PageHeader } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/form";
import { Badge, Dialog, EmptyState, Spinner } from "@/components/ui/misc";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import type { HistoryRecord, Mode } from "@/lib/types";
import { formatBytes, formatSeconds, formatTime } from "@/lib/utils";

const MODE_LABEL: Record<Mode, string> = { custom: "语音生成", design: "声音设计", clone: "音色克隆" };
const MODE_TONE: Record<Mode, "default" | "success" | "warning"> = { custom: "default", design: "warning", clone: "success" };
const PAGE_SIZE = 12;
const CLEANUP_PRESETS = [
  { value: "7", label: "7 天前" },
  { value: "30", label: "30 天前" },
  { value: "90", label: "90 天前" },
  { value: "365", label: "1 年前" },
  { value: "custom", label: "指定日期" },
];

function todayString() {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export default function HistoryPage() {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [mode, setMode] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [saveTarget, setSaveTarget] = useState<HistoryRecord | null>(null);
  const [voiceName, setVoiceName] = useState("");
  const [busy, setBusy] = useState(false);

  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [cleanupRange, setCleanupRange] = useState("30");
  const [cleanupDate, setCleanupDate] = useState("");
  const [cleaning, setCleaning] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["history", page, mode, query],
    queryFn: () => api.history({ page, page_size: PAGE_SIZE, mode: mode === "all" ? undefined : mode, query }),
  });

  // 清理截止时间：固定成 Unix 秒，预览和实际删除用同一个值
  const cleanupBefore = useMemo(() => {
    if (cleanupRange === "custom") {
      if (!cleanupDate) return null;
      const ts = Math.floor(new Date(`${cleanupDate}T00:00:00`).getTime() / 1000);
      return Number.isFinite(ts) ? ts : null;
    }
    return Math.floor(Date.now() / 1000) - Number(cleanupRange) * 86400;
  }, [cleanupRange, cleanupDate]);

  const { data: cleanupPreview } = useQuery({
    queryKey: ["history-cleanup", cleanupBefore],
    queryFn: () => api.historyPreview(cleanupBefore as number),
    enabled: cleanupOpen && cleanupBefore !== null,
    refetchOnMount: "always",
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["history"] });
    await queryClient.invalidateQueries({ queryKey: ["info"] });
  };

  const regenerate = async (record: HistoryRecord) => {
    toast.promise(
      api.regenerate(record.id).then((blob) => {
        const audio = new Audio(URL.createObjectURL(blob));
        void audio.play();
        void refresh();
      }),
      { loading: "重新生成中…", success: "已用相同参数生成一条新记录", error: (err) => (err instanceof Error ? err.message : "失败") },
    );
  };

  const remove = async (record: HistoryRecord) => {
    if (!confirm("删除这条记录及其音频？")) return;
    try {
      await api.deleteHistory(record.id);
      toast.success("已删除");
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除失败");
    }
  };

  const runCleanup = async () => {
    if (!cleanupBefore) {
      toast.error("请先选择要清理的截止时间");
      return;
    }
    if (!cleanupPreview?.records) return;
    setCleaning(true);
    try {
      const result = await api.cleanupHistory(cleanupBefore);
      toast.success(`已清理 ${result.deleted} 条记录，释放 ${result.freed_bytes ? formatBytes(result.freed_bytes) : "0 B"}`);
      setCleanupOpen(false);
      setPage(1);
      await refresh();
      void queryClient.invalidateQueries({ queryKey: ["history-cleanup"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "清理失败");
    } finally {
      setCleaning(false);
    }
  };

  const saveVoice = async () => {
    if (!saveTarget?.audio_url) return;
    setBusy(true);
    try {
      const blob = await (await fetch(saveTarget.audio_url)).blob();
      const form = new FormData();
      form.append("file", new File([blob], "take.wav", { type: "audio/wav" }));
      form.append("name", voiceName.trim() || `音色 ${saveTarget.id.slice(0, 6)}`);
      form.append("ref_text", saveTarget.text);
      form.append("language", saveTarget.language ?? "Auto");
      form.append("instruct", String((saveTarget.params as { instruct?: string })?.instruct ?? ""));
      form.append("source_history_id", saveTarget.id);
      const result = await api.createVoice(form);
      toast.success(
        result.truncated
          ? "已存入音色库（参考音频截为前 30 秒，参考文本同步截断）"
          : "已存入音色库",
      );
      setSaveTarget(null);
      setVoiceName("");
      await queryClient.invalidateQueries({ queryKey: ["voices"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };

  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="flex flex-col">
      <PageHeader
        title="历史记录"
        description="每次生成都留档：文本、参数、音频、性能指标"
        action={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setCleanupOpen(true)}>
              <Eraser /> 清理
            </Button>
            <Input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(1);
              }}
              placeholder="搜索文本"
              className="h-8 w-40"
            />
            <div className="w-32">
              <Select
                value={mode}
                onValueChange={(value) => {
                  setMode(value);
                  setPage(1);
                }}
              >
                <SelectTrigger className="h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部模式</SelectItem>
                  <SelectItem value="custom">语音生成</SelectItem>
                  <SelectItem value="design">声音设计</SelectItem>
                  <SelectItem value="clone">音色克隆</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        }
      />

      <div className="space-y-3 p-4">
        {isLoading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner /> 加载中
          </div>
        ) : data?.items.length ? (
          <div className="space-y-2">
            {data.items.map((record) => (
              <Card key={record.id} className="overflow-hidden">
                <CardContent className="flex flex-col gap-2 p-3">
                  <div className="flex items-start gap-3">
                    <div className="flex w-[86px] shrink-0 flex-col gap-1">
                      <Badge tone={record.status === "done" ? MODE_TONE[record.mode] : record.status === "error" ? "danger" : "muted"}>
                        {MODE_LABEL[record.mode] ?? record.mode}
                      </Badge>
                      <span className="text-[10px] text-muted-foreground">{formatTime(record.created_at)}</span>
                    </div>
                    <p className="min-w-0 flex-1 text-[13px] leading-relaxed text-foreground/90 line-clamp-2">{record.text}</p>
                    <div className="hidden shrink-0 flex-col items-end gap-0.5 text-[10px] text-muted-foreground sm:flex">
                      <span>{formatSeconds(record.duration_s)}</span>
                      <span>TTFA {record.ttfa_ms ? `${record.ttfa_ms} ms` : "—"}</span>
                      <span>RTF {record.rtf ?? "—"}</span>
                    </div>
                  </div>

                  {record.status === "error" ? (
                    <p className="rounded-md bg-destructive/10 px-2 py-1 text-[11px] text-destructive">{record.error}</p>
                  ) : null}

                  {openId === record.id && record.audio_url ? (
                    <audio key={record.audio_url} controls autoPlay src={record.audio_url} className="w-full" />
                  ) : null}

                  <div className="flex flex-wrap items-center gap-1.5">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setOpenId(openId === record.id ? null : record.id)}
                      disabled={!record.audio_url}
                    >
                      <Play /> 试听
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => regenerate(record)}>
                      <RefreshCw /> 再生成
                    </Button>
                    <Button variant="ghost" size="sm" disabled={!record.audio_url} onClick={() => setSaveTarget(record)}>
                      <Save /> 存为音色
                    </Button>
                    {record.audio_url ? (
                      <Button variant="ghost" size="sm" asChild>
                        <a href={`/api/v1/history/${record.id}/download`} download={`${record.id}.wav`}>
                          <Download /> 下载
                        </a>
                      </Button>
                    ) : null}
                    <span className="ml-auto flex items-center gap-2 text-[10px] text-muted-foreground">
                      <span className="hidden sm:inline">{record.model.split("/").pop()}</span>
                      <span>{record.quant}</span>
                      <Button variant="ghost" size="sm" className="text-destructive" onClick={() => remove(record)}>
                        <Trash2 />
                      </Button>
                    </span>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <EmptyState title="还没有历史记录" description="去生成台合成第一段语音，这里会自动留档。" />
        )}

        <div className="flex items-center justify-between pt-1">
          <span className="text-[11px] text-muted-foreground">
            共 {total} 条 · 第 {page}/{pages} 页
          </span>
          <div className="flex gap-1">
            <Button variant="outline" size="icon-sm" disabled={page <= 1} onClick={() => setPage((prev) => Math.max(1, prev - 1))}>
              <ChevronLeft />
            </Button>
            <Button variant="outline" size="icon-sm" disabled={page >= pages} onClick={() => setPage((prev) => prev + 1)}>
              <ChevronRight />
            </Button>
          </div>
        </div>
      </div>

      <Dialog
        open={Boolean(saveTarget)}
        onOpenChange={(open) => !open && setSaveTarget(null)}
        title="存为音色"
        description="用这条历史结果的音频作为参考音色，参考文本取当时的输入。"
        footer={
          <>
            <Button variant="ghost" onClick={() => setSaveTarget(null)}>
              取消
            </Button>
            <Button onClick={saveVoice} disabled={busy}>
              {busy ? <Spinner /> : <Save />} 保存
            </Button>
          </>
        }
      >
        <Field label="音色名称">
          <Input value={voiceName} onChange={(event) => setVoiceName(event.target.value)} placeholder="例如：广告男声 v2" />
        </Field>
      </Dialog>

      <Dialog
        open={cleanupOpen}
        onOpenChange={(open) => setCleanupOpen(open)}
        title="清理历史记录"
        description="按时间批量删除记录及其音频文件，删除后无法恢复。"
        footer={
          <>
            <Button variant="ghost" onClick={() => setCleanupOpen(false)}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={runCleanup}
              disabled={cleaning || !cleanupPreview?.records}
            >
              {cleaning ? <Spinner /> : <Trash2 />} 清理 {cleanupPreview?.records ?? 0} 条
            </Button>
          </>
        }
      >
        <Field label="清理范围" hint="该时间点之前生成的记录会被全部删除">
          <Select value={cleanupRange} onValueChange={setCleanupRange}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CLEANUP_PRESETS.map((preset) => (
                <SelectItem key={preset.value} value={preset.value}>
                  {preset.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        {cleanupRange === "custom" ? (
          <Field label="截止日期" hint="删除这一天 00:00 之前的记录">
            <Input
              type="date"
              value={cleanupDate}
              max={todayString()}
              onChange={(event) => setCleanupDate(event.target.value)}
            />
          </Field>
        ) : null}

        <div className="rounded-lg border border-border/70 bg-muted/20 px-3 py-2 text-[11px] leading-relaxed">
          {cleanupBefore === null ? (
            <p className="text-muted-foreground">先选一个截止日期。</p>
          ) : cleanupPreview ? (
            cleanupPreview.records ? (
              <div className="space-y-1">
                <p>
                  将删除 <span className="font-medium text-foreground">{cleanupPreview.records}</span> 条记录，含{" "}
                  {cleanupPreview.audio_files} 个音频文件，约释放 {formatBytes(cleanupPreview.audio_bytes)}。
                </p>
                <p className="text-muted-foreground">
                  时间范围：{formatTime(cleanupPreview.oldest)} — {formatTime(cleanupPreview.newest)}
                </p>
              </div>
            ) : (
              <p className="text-muted-foreground">这个时间点之前没有记录。</p>
            )
          ) : (
            <p className="flex items-center gap-1.5 text-muted-foreground">
              <Spinner /> 正在统计…
            </p>
          )}
        </div>

        <p className="text-[11px] leading-relaxed text-destructive">
          音频文件会一并从磁盘删除；最近 1 分钟内的记录不会被清理。
        </p>
      </Dialog>
    </div>
  );
}
