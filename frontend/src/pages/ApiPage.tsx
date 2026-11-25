import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronRight, Copy, ExternalLink, KeyRound, Plus, Search, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { PageHeader } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/form";
import { Badge, Separator, Spinner } from "@/components/ui/misc";
import {
  API_BASE,
  API_GROUPS,
  CURL_NOTES,
  ERROR_CODES,
  SAMPLES,
  buildCurl,
  paramLocation,
  type ApiEndpoint,
  type HttpMethod,
  type ParamLocation,
} from "@/lib/api-reference";
import { api } from "@/lib/api";
import { cn, copyText, formatRelative } from "@/lib/utils";

const METHOD_TONE: Record<HttpMethod, "default" | "muted" | "warning" | "danger" | "success"> = {
  GET: "muted",
  POST: "default",
  PUT: "warning",
  PATCH: "warning",
  DELETE: "danger",
  WS: "success",
};

const LOCATION_LABEL: Record<ParamLocation, string> = {
  path: "路径",
  query: "Query",
  body: "Body",
  form: "Form",
  frame: "帧",
};

function CodeBlock({ code, className }: { code: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={cn("group relative rounded-lg border border-border/70 bg-background/70", className)}>
      <pre className="overflow-x-auto p-3 text-[11px] leading-relaxed text-foreground/85">
        <code>{code}</code>
      </pre>
      <Button
        variant="ghost"
        size="icon-sm"
        className="absolute right-1.5 top-1.5 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
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

function ParamTable({ endpoint }: { endpoint: ApiEndpoint }) {
  const params = endpoint.params ?? [];
  if (params.length === 0) {
    return <p className="text-[11px] text-muted-foreground">无请求参数。</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[600px] border-collapse text-[11px]">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wide text-muted-foreground/70">
            <th className="pb-1.5 pr-3 font-medium">参数</th>
            <th className="pb-1.5 pr-3 font-medium">位置</th>
            <th className="pb-1.5 pr-3 font-medium">类型</th>
            <th className="pb-1.5 pr-3 font-medium">必填</th>
            <th className="pb-1.5 pr-3 font-medium">默认</th>
            <th className="pb-1.5 font-medium">说明</th>
          </tr>
        </thead>
        <tbody className="align-top">
          {params.map((param) => (
            <tr key={param.name} className="border-t border-border/40">
              <td className="whitespace-nowrap py-1.5 pr-3 font-mono text-foreground/90">{param.name}</td>
              <td className="whitespace-nowrap py-1.5 pr-3 text-[10px] text-muted-foreground/80">
                {LOCATION_LABEL[paramLocation(endpoint, param)]}
              </td>
              <td className="whitespace-nowrap py-1.5 pr-3 font-mono text-muted-foreground">{param.type}</td>
              <td className="whitespace-nowrap py-1.5 pr-3">
                {param.required ? <span className="text-amber-300">必填</span> : <span className="text-muted-foreground/60">可选</span>}
              </td>
              <td className="whitespace-nowrap py-1.5 pr-3 font-mono text-muted-foreground/80">{param.default ?? "—"}</td>
              <td className="py-1.5 leading-relaxed text-muted-foreground">{param.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EndpointRow({ endpoint, open, onToggle }: { endpoint: ApiEndpoint; open: boolean; onToggle: () => void }) {
  return (
    <div className={cn("transition-colors", open && "bg-muted/10")}>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-muted/30"
      >
        <Badge tone={METHOD_TONE[endpoint.method]} className="w-11 shrink-0 justify-center font-mono">
          {endpoint.method}
        </Badge>
        <code className="shrink-0 font-mono text-[11px] text-foreground/90">{endpoint.path}</code>
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{endpoint.summary}</span>
        {endpoint.auth === false ? (
          <span className="hidden shrink-0 text-[10px] text-muted-foreground/60 sm:inline">免鉴权</span>
        ) : null}
        {endpoint.params?.length ? (
          <span className="hidden shrink-0 text-[10px] text-muted-foreground/60 md:inline">{endpoint.params.length} 个参数</span>
        ) : null}
        <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
      </button>

      {open ? (
        <div className="space-y-3 border-t border-border/40 px-3 py-3">
          {endpoint.notes?.length ? (
            <ul className="space-y-1 text-[11px] leading-relaxed text-muted-foreground">
              {endpoint.notes.map((note) => (
                <li key={note} className="flex gap-1.5">
                  <span className="mt-[5px] size-1 shrink-0 rounded-full bg-muted-foreground/40" />
                  <span>{note}</span>
                </li>
              ))}
            </ul>
          ) : null}

          <div>
            <p className="mb-1.5 text-[10px] uppercase tracking-wide text-muted-foreground/70">请求参数</p>
            <ParamTable endpoint={endpoint} />
          </div>

          {endpoint.returns?.length ? (
            <div>
              <p className="mb-1.5 text-[10px] uppercase tracking-wide text-muted-foreground/70">响应</p>
              <ul className="space-y-1 text-[11px] leading-relaxed text-muted-foreground">
                {endpoint.returns.map((item) => (
                  <li key={item} className="font-mono text-[10.5px]">
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div>
            <p className="mb-1.5 text-[10px] uppercase tracking-wide text-muted-foreground/70">
              {endpoint.method === "WS" ? "客户端示例" : "curl 示例"}
            </p>
            <CodeBlock code={buildCurl(endpoint)} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function ApiPage() {
  const queryClient = useQueryClient();
  const [keyName, setKeyName] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const [activeSample, setActiveSample] = useState(0);
  const [search, setSearch] = useState("");
  const [openIds, setOpenIds] = useState<Set<string>>(() => new Set(["tts"]));

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

  const keyword = search.trim().toLowerCase();
  const groups = useMemo(() => {
    if (!keyword) return API_GROUPS;
    return API_GROUPS.map((group) => {
      const groupHit = group.title.toLowerCase().includes(keyword);
      const endpoints = groupHit
        ? group.endpoints
        : group.endpoints.filter((endpoint) => {
            const haystack = [
              endpoint.path,
              endpoint.summary,
              ...(endpoint.notes ?? []),
              ...(endpoint.params ?? []).flatMap((param) => [param.name, param.description]),
            ]
              .join(" ")
              .toLowerCase();
            return haystack.includes(keyword);
          });
      return { ...group, endpoints };
    }).filter((group) => group.endpoints.length > 0);
  }, [keyword]);

  const total = useMemo(() => groups.reduce((sum, group) => sum + group.endpoints.length, 0), [groups]);
  const allCount = useMemo(() => API_GROUPS.reduce((sum, group) => sum + group.endpoints.length, 0), []);
  const allOpen = groups.length > 0 && groups.every((group) => group.endpoints.every((endpoint) => openIds.has(endpoint.id)));

  const toggle = (id: string) => {
    setOpenIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setOpenIds((previous) => {
      const next = new Set(previous);
      const ids = groups.flatMap((group) => group.endpoints.map((endpoint) => endpoint.id));
      if (allOpen) ids.forEach((id) => next.delete(id));
      else ids.forEach((id) => next.add(id));
      return next;
    });
  };

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
        <div className="min-w-0 space-y-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle>请求示例</CardTitle>
              <CardDescription>
                Base URL：<code className="font-mono text-foreground/80">{API_BASE}</code> · 音频统一 24kHz 单声道
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-1.5">
                {SAMPLES.map((sample, index) => (
                  <button
                    key={sample.label}
                    type="button"
                    onClick={() => setActiveSample(index)}
                    className={cn(
                      "rounded-full border px-2.5 py-1 text-[11px] transition-colors",
                      activeSample === index
                        ? "border-primary/50 bg-primary/10 text-primary"
                        : "border-border/80 text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {sample.label}
                  </button>
                ))}
              </div>
              <CodeBlock code={SAMPLES[activeSample].code} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="space-y-2 pb-2">
              <div className="flex items-center gap-2">
                <CardTitle>端点</CardTitle>
                <Badge tone="muted">{total} / {allCount}</Badge>
                <div className="ml-auto flex items-center gap-2">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/70" />
                    <Input
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder="搜索路径、参数或说明"
                      className="h-7 w-52 pl-7 text-[11px]"
                    />
                  </div>
                  <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" onClick={toggleAll}>
                    {allOpen ? "全部收起" : "全部展开"}
                  </Button>
                </div>
              </div>
              <CardDescription>点击任意端点查看参数、响应与可复制的调用示例。</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 p-0 px-3 pb-3">
              {groups.length === 0 ? (
                <p className="py-6 text-center text-[11px] text-muted-foreground">没有匹配的端点，换个关键词试试。</p>
              ) : (
                groups.map((group) => (
                  <section key={group.id} className="space-y-1.5">
                    <div className="flex items-baseline gap-2 px-1">
                      <h3 className="text-xs font-medium">{group.title}</h3>
                      <span className="text-[10px] text-muted-foreground/70">{group.endpoints.length} 个</span>
                      <p className="ml-2 min-w-0 flex-1 truncate text-[10px] text-muted-foreground/70">{group.description}</p>
                    </div>
                    <div className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/70 bg-card/40">
                      {group.endpoints.map((endpoint) => (
                        <EndpointRow
                          key={endpoint.id}
                          endpoint={endpoint}
                          open={openIds.has(endpoint.id)}
                          onToggle={() => toggle(endpoint.id)}
                        />
                      ))}
                    </div>
                  </section>
                ))
              )}
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
              <CardTitle>错误码</CardTitle>
              <CardDescription>错误响应统一带 code，便于客户端分支处理</CardDescription>
            </CardHeader>
            <CardContent className="space-y-0.5">
              {ERROR_CODES.map((item) => (
                <div key={`${item.status}-${item.code}`} className="rounded-md px-1 py-1.5 hover:bg-muted/30">
                  <div className="flex items-baseline gap-2">
                    <code className="break-all font-mono text-[10.5px] text-foreground/85">{item.code}</code>
                    <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground/70">{item.status}</span>
                  </div>
                  <p className="mt-0.5 text-[10.5px] leading-relaxed text-muted-foreground">{item.meaning}</p>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle>约定</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5 text-[11px] leading-relaxed text-muted-foreground">
              {CURL_NOTES.map((note) => (
                <p key={note} className="flex gap-1.5">
                  <span className="mt-[5px] size-1 shrink-0 rounded-full bg-muted-foreground/40" />
                  <span>{note}</span>
                </p>
              ))}
              <p className="flex gap-1.5">
                <span className="mt-[5px] size-1 shrink-0 rounded-full bg-muted-foreground/40" />
                <span>单卡推理串行，请求按 FIFO 排队；取消用 POST /tts/cancel/{"{job_id}"}。</span>
              </p>
              <p className="flex gap-1.5">
                <span className="mt-[5px] size-1 shrink-0 rounded-full bg-muted-foreground/40" />
                <span>语言用英文名：Chinese / English / Japanese…，Auto 为自动判断。</span>
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
