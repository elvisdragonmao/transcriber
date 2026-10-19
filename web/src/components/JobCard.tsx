import { useState } from "react";
import { Link } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Pause, Play, RotateCcw, Square } from "lucide-react";
import { post, type Job, type Stage } from "../lib/api";
import { STATUS_LABEL, eta, pct, relative, unitLabel, dateTime } from "../lib/format";
import { Badge, Button, Modal, Progress, Toggle, cx, statusTone } from "./ui";

const LANE_LABEL: Record<string, string> = { "gpu-asr": "RTX 5060", "gpu-diar": "RTX 3050", cpu: "CPU", ffmpeg: "CPU", llm: "LLM CLI", node: "Server", none: "Browser" };

function stageTone(s: Stage) {
  return s.status === "failed" ? "bad" : s.status === "completed" ? "ok" : s.status === "cancelled" || s.status === "skipped" ? "muted" : "accent";
}

export function StageRow({ s, jobStatus }: { s: Stage; jobStatus: string }) {
  const running = s.status === "running";
  const value = s.status === "completed" ? 1 : s.status === "skipped" ? 0 : running ? s.progress : s.progress ?? 0;
  const detail = unitLabel(s.unit, s.done, s.total);
  const lane = s.status === "running" || s.status === "completed" ? LANE_LABEL[s.lane] ?? s.lane : null;
  return (
    <div className={cx("grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 py-1.5", s.status === "skipped" && "opacity-50")}>
      <div className="flex min-w-0 items-center gap-2 text-[13px]">
        <span className={cx("truncate", running && "font-medium")}>{s.label}</span>
        {lane && <span className="hidden text-[11px] text-muted sm:inline">{lane}</span>}
        {s.retryCount > 0 && <Badge tone="warn">重試 {s.retryCount}</Badge>}
        {s.status === "pending" && s.nextAttemptAt && <span className="text-[11px] text-warn">稍後重試</span>}
      </div>
      <div className="flex items-center gap-2 text-[12px] tabular-nums text-muted">
        {running && detail && <span>{detail}</span>}
        {running && s.etaSeconds != null && <span>剩 {eta(s.etaSeconds)}</span>}
        {s.status !== "running" && (
          <span>{s.status === "pending" && (s.progress ?? 0) > 0 ? `已完成 ${pct(s.progress)}，${jobStatus === "paused" ? "已暫停" : "等待繼續"}` : STATUS_LABEL[s.status]}</span>
        )}
        {running && s.progress != null && <span className="w-9 text-right">{pct(s.progress)}</span>}
      </div>
      <Progress className="col-span-2" size="sm" value={running && s.progress == null ? null : value} tone={stageTone(s)} />
      {s.error && s.status !== "completed" && <div className="col-span-2 break-words text-[12px] text-bad">{s.errorCode ? `[${s.errorCode}] ` : ""}{s.error}</div>}
      {s.detail?.device === "cpu" && s.name === "diarize" && <div className="col-span-2 text-[12px] text-warn">在 CPU 執行（GPU 無法使用），速度會明顯較慢</div>}
    </div>
  );
}

export function JobActions({ job, size = "sm" }: { job: Job; size?: "sm" | "md" }) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const [keep, setKeep] = useState(true);
  const act = useMutation({
    mutationFn: ({ action, body }: { action: string; body?: unknown }) => post(`/api/jobs/${job.id}/${action}`, body ?? {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["jobs"] }),
  });
  const s = job.status;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {["queued", "running"].includes(s) && (
        <Button size={size} onClick={() => act.mutate({ action: "pause" })} loading={act.isPending && act.variables?.action === "pause"}>
          <Pause className="size-3.5" /> 暫停
        </Button>
      )}
      {["paused", "pausing"].includes(s) && (
        <Button size={size} variant="primary" onClick={() => act.mutate({ action: "resume" })}>
          <Play className="size-3.5" /> 繼續
        </Button>
      )}
      {["failed", "cancelled"].includes(s) && (
        <Button size={size} onClick={() => act.mutate({ action: "retry" })}>
          <RotateCcw className="size-3.5" /> 重試
        </Button>
      )}
      {["queued", "running", "pausing", "paused"].includes(s) && (
        <Button size={size} variant="danger" onClick={() => setConfirm(true)}>
          <Square className="size-3.5" /> 取消
        </Button>
      )}
      {act.error && <span className="text-xs text-bad">{(act.error as Error).message}</span>}
      <Modal
        open={confirm}
        onClose={() => setConfirm(false)}
        title="取消任務"
        footer={
          <>
            <Button onClick={() => setConfirm(false)}>返回</Button>
            <Button
              variant="danger"
              onClick={() => {
                act.mutate({ action: "cancel", body: { keepPartial: keep } });
                setConfirm(false);
              }}
            >
              確認取消
            </Button>
          </>
        }
      >
        <p className="mb-3 text-sm">正在執行的模型會在安全的區段邊界停止，必要時強制結束 worker 以釋放 GPU。</p>
        <Toggle checked={keep} onChange={setKeep} label="保留已完成的中間結果（之後重試可從中斷處繼續）" />
      </Modal>
    </div>
  );
}

export function JobCard({ job, compact = false, showTitle = true }: { job: Job; compact?: boolean; showTitle?: boolean }) {
  const [open, setOpen] = useState(!compact);
  const current = job.stages.find((s) => s.status === "running");
  const runningStages = job.stages.filter((s) => s.status === "running");
  const shown = job.stages.filter((s) => s.name !== "upload" || job.type === "transcription");
  const tone = job.status === "failed" ? "bad" : job.status === "completed" ? "ok" : ["paused", "pausing"].includes(job.status) ? "warn" : "accent";
  return (
    <div className="rounded-lg border border-line bg-panel">
      <div className="flex flex-wrap items-start gap-3 p-3.5">
        <button className="mt-0.5 text-muted" onClick={() => setOpen(!open)} aria-label={open ? "收合" : "展開"}>
          {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {showTitle && (
              <Link to={`/recordings/${job.recordingId}`} className="truncate font-medium hover:underline">
                {job.recordingTitle ?? "錄音"}
              </Link>
            )}
            <Badge tone={statusTone(job.status)}>{STATUS_LABEL[job.status]}</Badge>
            <Badge>{job.type === "transcription" ? "轉錄" : job.type === "notes" ? "筆記生成" : "匯出"}</Badge>
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted">
            <span>{relative(job.createdAt)}</span>
            {runningStages.length > 0 && <span>目前：{runningStages.map((s) => s.label).join("、")}</span>}
            {job.etaSeconds != null && ["running", "queued"].includes(job.status) && <span>預估剩餘 {eta(job.etaSeconds)}</span>}
            {job.finishedAt && <span>完成於 {dateTime(job.finishedAt)}</span>}
          </div>
          <div className="mt-2 flex items-center gap-3">
            <Progress value={job.progress} tone={tone} />
            <span className="w-10 text-right text-sm tabular-nums">{pct(job.progress)}</span>
          </div>
          {job.error && job.status === "failed" && <div className="mt-2 break-words text-[13px] text-bad">{job.error}</div>}
          {!open && current && <div className="mt-1 text-xs text-muted">{current.label} {unitLabel(current.unit, current.done, current.total) ?? ""}</div>}
        </div>
        <JobActions job={job} />
      </div>
      {open && (
        <div className="border-t border-line px-4 pb-3 pt-1.5 sm:pl-10">
          {shown.map((s) => (
            <StageRow key={s.name} s={s} jobStatus={job.status} />
          ))}
        </div>
      )}
    </div>
  );
}
