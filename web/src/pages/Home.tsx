import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, FileAudio, ListChecks, Pause, Play, RotateCcw, Trash2, UploadCloud, X } from "lucide-react";
import { get, type Job } from "../lib/api";
import { uploads, type UploadItem } from "../lib/upload";
import { resolveUploadOptions, setUploadOptions, useUploadOptions } from "../lib/uploadOptions";
import { bytes, eta, TEMPLATE_LABEL } from "../lib/format";
import { JobCard } from "../components/JobCard";
import { Badge, Button, Empty, Field, Input, Panel, Progress, Select, Spinner, Textarea, Toggle, cx, statusTone } from "../components/ui";

const STATE_LABEL: Record<string, string> = {
  queued: "等待上傳",
  hashing: "計算校驗碼",
  uploading: "上傳中",
  paused: "已暫停",
  verifying: "伺服器驗證中",
  done: "已上傳，已建立轉錄任務",
  error: "錯誤",
  cancelled: "已取消",
};

export function useUploads() {
  return useSyncExternalStore(
    (cb) => uploads.subscribe(cb),
    () => uploads.items,
  );
}

function UploadRow({ it }: { it: UploadItem }) {
  const sent = Math.min(it.size, it.confirmedBytes + it.inflightBytes);
  const p = it.size ? sent / it.size : 0;
  const remaining = it.speedBps ? (it.size - sent) / it.speedBps : null;
  return (
    <div className="rounded-md border border-line bg-panel p-3">
      <div className="flex flex-wrap items-start gap-3">
        <FileAudio className="mt-0.5 size-5 shrink-0 text-muted" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium">{it.file.name}</span>
            <Badge tone={statusTone(it.state)}>{STATE_LABEL[it.state]}</Badge>
            {it.retries > 0 && <Badge tone="warn">重試 {it.retries} 次</Badge>}
          </div>
          <div className="mt-0.5 text-xs tabular-nums text-muted">
            {bytes(sent)} / {bytes(it.size)}
            {it.totalChunks > 0 && ` · ${it.received.size}/${it.totalChunks} 塊（每塊 ${bytes(it.chunkSize)}）`}
            {it.state === "uploading" && it.speedBps && ` · ${bytes(it.speedBps)}/s`}
            {it.state === "uploading" && remaining != null && ` · 剩 ${eta(remaining)}`}
            {" · "}
            {TEMPLATE_LABEL[it.options.noteTemplate]}
          </div>
          <Progress className="mt-2" value={it.state === "verifying" ? null : p} tone={it.state === "error" ? "bad" : it.state === "done" ? "ok" : it.state === "paused" ? "warn" : "accent"} />
          {it.error && <div className="mt-1.5 text-xs text-bad">{it.error}</div>}
        </div>
        <div className="flex gap-1">
          {["uploading", "queued", "hashing"].includes(it.state) && (
            <Button size="sm" onClick={() => uploads.pause(it.key)}>
              <Pause className="size-3.5" /> 暫停
            </Button>
          )}
          {it.state === "paused" && (
            <Button size="sm" variant="primary" onClick={() => uploads.resume(it.key)}>
              <Play className="size-3.5" /> 繼續
            </Button>
          )}
          {it.state === "error" && it.sessionId !== null && (
            <Button size="sm" onClick={() => uploads.resume(it.key)}>
              <RotateCcw className="size-3.5" /> 重試
            </Button>
          )}
          {it.state === "done" && it.recordingId && (
            <Link to={`/recordings/${it.recordingId}`}>
              <Button size="sm">
                <CheckCircle2 className="size-3.5 text-ok" /> 查看
              </Button>
            </Link>
          )}
          {!["done", "cancelled"].includes(it.state) ? (
            <Button size="sm" variant="ghost" onClick={() => uploads.cancel(it.key)} aria-label="取消上傳">
              <X className="size-4" />
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => uploads.remove(it.key)} aria-label="移除">
              <Trash2 className="size-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function OptionsPanel({ title, setTitle, onPick }: { title: string; setTitle: (v: string) => void; onPick: () => void }) {
  const opts = useUploadOptions();
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => get("/api/settings") });
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => get("/api/projects") });
  const obsidian = useQuery({ queryKey: ["obsidian", "status"], queryFn: () => get("/api/obsidian/status") });
  const s = settings.data?.settings;
  const template = opts.noteTemplate ?? s?.llm?.defaultTemplate ?? "none";
  return (
    <Panel title="處理選項">
      <div className="space-y-4">
        <Field label="輸出">
          <Select
            value={template}
            onChange={(e) => setUploadOptions({ noteTemplate: e.target.value as any })}
            options={[
              { value: "none", label: TEMPLATE_LABEL.none },
              { value: "meeting", label: TEMPLATE_LABEL.meeting },
              { value: "class", label: TEMPLATE_LABEL.class },
            ]}
          />
        </Field>
        <Field label="標題（選填）" hint="只套用到下一個單獨選擇的檔案；留空用檔名，產生筆記時 AI 會建議標題。">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：專案討論會議" />
        </Field>
        <Field label="專案（選填）">
          <Select
            value={opts.projectId ?? ""}
            onChange={(e) => setUploadOptions({ projectId: e.target.value || null })}
            options={[{ value: "", label: "交給 AI 判斷 / 不指定" }, ...(projects.data?.items ?? []).map((p: any) => ({ value: p.id, label: p.name }))]}
          />
        </Field>
        {obsidian.data?.configured && (
          <Toggle checked={opts.autoExport ?? s?.obsidian?.autoExport ?? true} onChange={(v) => setUploadOptions({ autoExport: v })} label="完成後存入 Obsidian" />
        )}
        <details className="rounded-md border border-line p-3">
          <summary className="text-sm font-medium">進階選項</summary>
          <div className="mt-3 space-y-3">
            <Field label="語言" hint="預設自動偵測，中英混雜也能處理。中文輸出為台灣繁體。">
              <Select
                value={opts.language}
                onChange={(e) => setUploadOptions({ language: e.target.value as any })}
                options={[
                  { value: "auto", label: "Auto（自動偵測）" },
                  { value: "zh", label: "Chinese" },
                  { value: "en", label: "English" },
                ]}
              />
            </Field>
            <Field label="Vocabulary / Hotwords" hint="逗號或換行分隔，例如人名、專案名、英文術語。">
              <Textarea rows={3} value={opts.vocabulary} onChange={(e) => setUploadOptions({ vocabulary: e.target.value })} placeholder="ICT 創創工坊, Qwen3-ASR, Obsidian" />
            </Field>
          </div>
        </details>
        <Button variant="primary" className="w-full" onClick={onPick}>
          選擇檔案
        </Button>
        <p className="text-xs text-muted">選項會記住，拖放到視窗任何地方的檔案也會使用。錄音只在這台主機的 GPU 上處理。</p>
      </div>
    </Panel>
  );
}

const JOB_TABS = [
  { key: "active", label: "進行中", status: "queued,running,pausing,paused,cancelling" },
  { key: "failed", label: "失敗", status: "failed" },
  { key: "completed", label: "完成", status: "completed" },
  { key: "cancelled", label: "已取消", status: "cancelled" },
  { key: "all", label: "全部", status: "" },
];

function JobsPanel() {
  const [tab, setTab] = useState("active");
  const counts = useQuery({ queryKey: ["system", "status"], queryFn: () => get("/api/system/status"), refetchInterval: 10000 });
  const t = JOB_TABS.find((x) => x.key === tab)!;
  const q = useQuery({
    queryKey: ["jobs", "list", tab],
    queryFn: () => get<{ items: Job[] }>(`/api/jobs?limit=200${t.status ? `&status=${t.status}` : ""}`),
    refetchInterval: 15000,
  });
  const c = counts.data?.jobCounts ?? {};
  const countOf = (status: string) => (status ? status.split(",").reduce((a, k) => a + (c[k] ?? 0), 0) : null);
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-base font-semibold">任務</h2>
        <div className="flex flex-wrap gap-1 rounded-lg border border-line bg-panel p-1 text-sm">
          {JOB_TABS.map((x) => {
            const n = countOf(x.status);
            return (
              <button key={x.key} onClick={() => setTab(x.key)} className={cx("rounded-md px-3 py-1.5", tab === x.key ? "bg-accent text-accent-fg" : "text-muted hover:bg-panel-2")}>
                {x.label}
                {n ? <span className="ml-1.5 tabular-nums opacity-80">{n}</span> : null}
              </button>
            );
          })}
        </div>
      </div>
      {q.isLoading && <Spinner />}
      {q.data?.items.length === 0 && <Empty icon={<ListChecks className="size-8" />} title={tab === "active" ? "目前沒有進行中的任務" : "沒有符合的任務"}>{tab === "active" && "上傳錄音後會自動排入佇列。"}</Empty>}
      <div className="space-y-3">
        {q.data?.items.map((j) => (
          <JobCard key={j.id} job={j} compact={!["running", "pausing", "failed"].includes(j.status)} />
        ))}
      </div>
    </section>
  );
}

export function HomePage() {
  const items = useUploads();
  const input = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState("");
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => get("/api/settings") });
  const remembered = uploads.remembered();
  const pendingResume = Object.entries(remembered).filter(([fp]) => !items.some((i) => `${i.file.name}:${i.file.size}:${i.file.lastModified}` === fp));

  // finished uploads become jobs below; each upload row goes away a moment after it is done
  const scheduled = useRef(new Set<string>());
  useEffect(() => {
    for (const i of items)
      if (i.state === "done" && !scheduled.current.has(i.key)) {
        scheduled.current.add(i.key);
        setTimeout(() => uploads.remove(i.key), 4000);
      }
  }, [items]);

  const addFiles = (list: FileList | null) => {
    if (!list?.length) return;
    const files = [...list];
    uploads.add(files, resolveUploadOptions(settings.data?.settings, files.length === 1 ? title : undefined));
    setTitle("");
  };

  return (
    <div className="space-y-6">
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex flex-col gap-3">
          <button
            type="button"
            onClick={() => input.current?.click()}
            className="flex min-h-56 w-full flex-1 flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-line bg-panel px-6 py-12 text-center transition-colors hover:border-accent/60 focus-visible:outline-2 focus-visible:outline-accent"
          >
            <UploadCloud className="size-9 text-accent" />
            <span className="font-medium">把錄音拖到視窗任何地方，或點這裡選擇</span>
            <span className="text-sm text-muted">MP3、WAV、M4A、FLAC、OGG、OPUS、MP4（擷取音訊）· 可一次多個檔案 · 大檔分塊續傳</span>
          </button>
          <input ref={input} type="file" multiple hidden accept=".mp3,.wav,.m4a,.flac,.ogg,.opus,.mp4,audio/*,video/mp4" onChange={(e) => (addFiles(e.target.files), (e.target.value = ""))} />

          {pendingResume.length > 0 && (
            <div className="rounded-md border border-warn/40 bg-warn/5 p-3 text-sm">
              <div className="mb-1.5 font-medium">未完成的上傳</div>
              <p className="mb-2 text-muted">瀏覽器無法自動重新讀取檔案。再次選擇或拖入同一個檔案，已上傳的部分會直接略過。</p>
              <ul className="space-y-1.5">
                {pendingResume.map(([fp, r]) => (
                  <li key={fp} className="flex items-center justify-between gap-2">
                    <span className="truncate">
                      {r.name} <span className="text-muted">（{bytes(r.size)}）</span>
                    </span>
                    <span className="flex gap-1">
                      <Button size="sm" onClick={() => input.current?.click()}>
                        選擇檔案續傳
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => uploads.forget(fp)}>
                        忽略
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {items.length > 0 && (
            <div className="space-y-2">
              {items.map((it) => (
                <UploadRow key={it.key} it={it} />
              ))}
            </div>
          )}
        </div>
        <OptionsPanel title={title} setTitle={setTitle} onPick={() => input.current?.click()} />
      </div>
      <JobsPanel />
    </div>
  );
}
