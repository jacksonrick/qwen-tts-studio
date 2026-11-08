import { useQuery } from "@tanstack/react-query";
import { AudioLines, Code2, History, Library, Settings2 } from "lucide-react";
import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";

import { Badge } from "@/components/ui/misc";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/", label: "生成台", icon: AudioLines },
  { to: "/voices", label: "音色库", icon: Library },
  { to: "/history", label: "历史", icon: History },
  { to: "/api", label: "API", icon: Code2 },
  { to: "/system", label: "系统", icon: Settings2 },
];

export function Shell({ children }: { children: ReactNode }) {
  const { data } = useQuery({
    queryKey: ["info"],
    queryFn: api.info,
    refetchInterval: 15000,
    retry: 1,
  });

  const ready = data?.model_status.status === "ready";
  const loading = data?.model_status.status === "loading";

  return (
    <div className="flex h-full min-h-screen bg-background">
      <aside className="flex w-[188px] shrink-0 flex-col border-r border-border bg-card/40 px-3 py-4">
        <div className="mb-6 flex items-center gap-2 px-1">
          <span className="flex size-7 items-center justify-center rounded-md bg-primary/15 text-primary">
            <AudioLines className="size-4" />
          </span>
          <div className="leading-tight">
            <p className="text-[13px] font-medium">Qwen3-TTS</p>
            <p className="text-[10px] text-muted-foreground">Studio</p>
          </div>
        </div>

        <nav className="flex flex-col gap-1">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                  isActive && "bg-accent text-foreground",
                )
              }
            >
              <Icon className="size-4" />
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="mt-auto space-y-2 rounded-lg border border-border/70 bg-muted/30 p-2.5">
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-muted-foreground">后端</span>
            <Badge tone={loading ? "warning" : ready ? "success" : "muted"}>
              {loading ? "加载中" : ready ? "已就绪" : "待机"}
            </Badge>
          </div>
          <div className="space-y-0.5 text-[10px] leading-relaxed text-muted-foreground">
            <p>
              {data?.runtime.backend ?? "—"} · {data?.runtime.device ?? "—"}
            </p>
            <p className="truncate" title={data?.runtime.gpu}>
              {data?.runtime.gpu ?? ""}
            </p>
            <p>量化 {data?.settings.quant ?? "—"}</p>
          </div>
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}

export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <header className="flex items-start justify-between gap-4 border-b border-border/70 px-6 py-4">
      <div>
        <h1 className="text-base font-medium tracking-tight">{title}</h1>
        {description ? <p className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}
      </div>
      {action}
    </header>
  );
}
