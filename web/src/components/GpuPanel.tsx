import { useQuery } from "@tanstack/react-query";
import { get } from "../lib/api";
import { Badge, Panel, Progress, Spinner } from "./ui";

export function GpuPanel() {
  const { data } = useQuery({ queryKey: ["system", "status"], queryFn: () => get("/api/system/status"), refetchInterval: 5000 });
  if (!data) return <Panel title="GPU">{<Spinner />}</Panel>;
  const role = (uuid: string) => [data.mapping.asrDevice === uuid && "ASR + Alignment", data.mapping.diarDevice === uuid && "Diarization"].filter(Boolean).join(" · ");
  return (
    <Panel title="GPU 與 Workers" actions={data.mockWorker ? <Badge tone="warn">MOCK WORKER</Badge> : null}>
      {data.gpuError && <div className="mb-3 text-sm text-bad">{data.gpuError}</div>}
      <div className="grid gap-4 sm:grid-cols-2">
        {data.gpus.map((g: any) => {
          const used = g.memoryUsedMiB / g.memoryTotalMiB;
          return (
            <div key={g.uuid} className="rounded-md border border-line p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium" title={g.name}>{g.name.replace(/^NVIDIA (GeForce )?/, "")}</div>
                  <div className="truncate text-[11px] text-muted" title={g.uuid}>
                    {role(g.uuid) || "未指派"} · cc {g.computeCap}
                  </div>
                </div>
                <div className="text-right text-xs tabular-nums text-muted">
                  {g.utilization ?? "–"}% · {g.temperature ?? "–"}°C
                </div>
              </div>
              <div className="mt-2 flex items-center gap-2">
                <Progress value={used} tone={used > 0.9 ? "bad" : used > 0.7 ? "warn" : "accent"} />
                <span className="w-24 shrink-0 text-right text-xs tabular-nums">
                  {(g.memoryUsedMiB / 1024).toFixed(1)} / {(g.memoryTotalMiB / 1024).toFixed(1)} GB
                </span>
              </div>
              {g.processes.length > 0 && <div className="mt-1.5 truncate text-[11px] text-muted">{g.processes.map((p: any) => `${p.name} ${p.usedMiB}MiB`).join(" · ")}</div>}
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex flex-wrap gap-2 text-xs">
        {Object.entries(data.workers ?? {}).map(([lane, w]: any) => (
          <Badge key={lane} tone={w.busy ? "accent" : w.running ? "ok" : "neutral"}>
            {lane}: {w.busy ? "執行中" : w.running ? "待命（模型可能已載入）" : "未啟動"}
          </Badge>
        ))}
      </div>
    </Panel>
  );
}
