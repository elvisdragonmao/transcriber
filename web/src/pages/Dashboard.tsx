import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Cpu, HardDrive, Upload } from "lucide-react";
import { get, type Job, type Recording } from "../lib/api";
import { bytes, duration, relative, STATUS_LABEL } from "../lib/format";
import { JobCard } from "../components/JobCard";
import { Badge, Button, Empty, Panel, Progress, Spinner, Stat, statusTone } from "../components/ui";

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

export function Dashboard() {
  const jobs = useQuery({ queryKey: ["jobs", "list", "dash"], queryFn: () => get<{ items: Job[] }>("/api/jobs?limit=60"), refetchInterval: 20000 });
  const recs = useQuery({ queryKey: ["recordings", "recent"], queryFn: () => get<{ items: Recording[]; total: number }>("/api/recordings?limit=8") });
  const status = useQuery({ queryKey: ["system", "status"], queryFn: () => get("/api/system/status"), refetchInterval: 5000 });
  const items = jobs.data?.items ?? [];
  const active = items.filter((j) => ["running", "pausing", "cancelling"].includes(j.status));
  const queued = items.filter((j) => ["queued", "paused"].includes(j.status));
  const failed = items.filter((j) => j.status === "failed");
  const counts = status.data?.jobCounts ?? {};
  const st = status.data?.storage;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Dashboard</h1>
        <Link to="/upload">
          <Button variant="primary">
            <Upload className="size-4" /> 上傳錄音
          </Button>
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-3 rounded-lg border border-line bg-panel p-4 sm:grid-cols-5">
        <Stat label="處理中" value={(counts.running ?? 0) + (counts.pausing ?? 0)} />
        <Stat label="排隊 / 暫停" value={(counts.queued ?? 0) + (counts.paused ?? 0)} />
        <Stat label="完成" value={counts.completed ?? 0} />
        <Stat label="失敗" value={<span className={counts.failed ? "text-bad" : ""}>{counts.failed ?? 0}</span>} />
        <Stat label="錄音" value={recs.data?.total ?? "–"} sub={st ? `可用空間 ${bytes(st.freeBytes)}` : undefined} />
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="space-y-5">
          <Panel title="正在處理" pad={false}>
            <div className="space-y-3 p-3">
              {active.length === 0 && <Empty title="目前沒有正在執行的任務">上傳錄音後會自動排入佇列。</Empty>}
              {active.map((j) => (
                <JobCard key={j.id} job={j} />
              ))}
            </div>
          </Panel>
          {queued.length > 0 && (
            <Panel title={`排隊中（${queued.length}）`} pad={false}>
              <div className="space-y-2 p-3">
                {queued.map((j) => (
                  <JobCard key={j.id} job={j} compact />
                ))}
              </div>
            </Panel>
          )}
          {failed.length > 0 && (
            <Panel title={<span className="flex items-center gap-1.5 text-bad"><AlertTriangle className="size-4" /> 失敗（{failed.length}）</span>} pad={false}>
              <div className="space-y-2 p-3">
                {failed.slice(0, 5).map((j) => (
                  <JobCard key={j.id} job={j} compact />
                ))}
              </div>
            </Panel>
          )}
        </div>
        <div className="space-y-5">
          <GpuPanel />
          <Panel title="最近錄音" actions={<Link className="text-xs text-accent" to="/recordings">全部</Link>} pad={false}>
            <ul className="divide-y divide-line">
              {(recs.data?.items ?? []).map((r) => (
                <li key={r.id}>
                  <Link to={`/recordings/${r.id}`} className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-panel-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{r.title}</div>
                      <div className="text-xs text-muted">
                        {duration(r.durationMs)} · {relative(r.createdAt)}
                      </div>
                    </div>
                    {r.activeJobs[0] ? (
                      <Badge tone={statusTone(r.activeJobs[0].status)}>{Math.floor(r.activeJobs[0].progress * 100)}%</Badge>
                    ) : r.lastJob ? (
                      <Badge tone={statusTone(r.lastJob.status)}>{STATUS_LABEL[r.lastJob.status]}</Badge>
                    ) : null}
                  </Link>
                </li>
              ))}
              {recs.data?.items.length === 0 && <li className="px-4 py-6 text-center text-sm text-muted">還沒有錄音</li>}
            </ul>
          </Panel>
          {st && (
            <Panel title={<span className="flex items-center gap-1.5"><HardDrive className="size-4" /> 儲存空間</span>}>
              <dl className="grid grid-cols-2 gap-y-1.5 text-sm">
                <dt className="text-muted">原始錄音</dt>
                <dd className="text-right tabular-nums">{bytes(st.sourceAudioBytes)}</dd>
                <dt className="text-muted">轉換後音訊</dt>
                <dd className="text-right tabular-nums">{bytes(st.derivedAudioBytes)}</dd>
                <dt className="text-muted">中間結果</dt>
                <dd className="text-right tabular-nums">{bytes(st.intermediateBytes)}</dd>
                <dt className="text-muted">上傳暫存</dt>
                <dd className="text-right tabular-nums">{bytes(st.uploadChunkBytes)}</dd>
                <dt className="text-muted">資料庫</dt>
                <dd className="text-right tabular-nums">{bytes(st.databaseBytes)}</dd>
                <dt className="text-muted">磁碟可用</dt>
                <dd className="text-right tabular-nums">{bytes(st.freeBytes)}</dd>
              </dl>
            </Panel>
          )}
          {status.data && (
            <Panel title={<span className="flex items-center gap-1.5"><Cpu className="size-4" /> 系統</span>}>
              <div className="text-sm text-muted">
                Node {status.data.node} · schema v{status.data.schemaVersion} · 已執行 {Math.round(status.data.uptimeSec / 60)} 分鐘 · load {status.data.loadavg.map((x: number) => x.toFixed(1)).join(" ")}
              </div>
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}
