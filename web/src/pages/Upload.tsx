import { useRef, useState, useSyncExternalStore } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, FileAudio, Pause, Play, RotateCcw, Trash2, UploadCloud, X } from "lucide-react";
import { get } from "../lib/api";
import { uploads, type UploadItem, type UploadOptions } from "../lib/upload";
import { bytes, eta, TEMPLATE_LABEL } from "../lib/format";
import { Badge, Button, Field, Input, Panel, Progress, Select, Textarea, Toggle, cx, statusTone } from "../components/ui";

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

function useUploads() {
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
    <div className="rounded-md border border-line p-3">
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

export function UploadPage() {
  const items = useUploads();
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => get("/api/settings") });
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => get("/api/projects") });
  const obsidian = useQuery({ queryKey: ["obsidian", "status"], queryFn: () => get("/api/obsidian/status") });
  const llmDefault = settings.data?.settings?.llm?.defaultTemplate ?? "none";
  const [opts, setOpts] = useState<UploadOptions & { touched?: boolean }>({ language: "auto", vocabulary: "", noteTemplate: "none" });
  const effective: UploadOptions = { ...opts, noteTemplate: opts.touched ? opts.noteTemplate : llmDefault };
  const [title, setTitle] = useState("");
  const remembered = uploads.remembered();
  const pendingResume = Object.entries(remembered).filter(([fp]) => !items.some((i) => `${i.file.name}:${i.file.size}:${i.file.lastModified}` === fp));

  const addFiles = (list: FileList | null) => {
    if (!list?.length) return;
    const files = [...list];
    uploads.add(files, { ...effective, title: files.length === 1 && title.trim() ? title.trim() : undefined });
    setTitle("");
  };

  return (
    <div className="space-y-5">
      <h1 className="text-xl font-semibold">上傳錄音</h1>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-4">
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              addFiles(e.dataTransfer.files);
            }}
            onClick={() => input.current?.click()}
            className={cx(
              "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-6 py-12 text-center transition-colors",
              drag ? "border-accent bg-accent/5" : "border-line bg-panel hover:border-accent/50",
            )}
          >
            <UploadCloud className="size-9 text-accent" />
            <div className="font-medium">拖放錄音檔到這裡，或點擊選擇</div>
            <div className="text-sm text-muted">MP3、WAV、M4A、FLAC、OGG、OPUS、MP4（擷取音訊）· 可一次多個檔案 · 大檔分塊續傳</div>
            <input ref={input} type="file" multiple hidden accept=".mp3,.wav,.m4a,.flac,.ogg,.opus,.mp4,audio/*,video/mp4" onChange={(e) => (addFiles(e.target.files), (e.target.value = ""))} />
          </div>

          {pendingResume.length > 0 && (
            <Panel title="未完成的上傳">
              <p className="mb-2 text-sm text-muted">瀏覽器無法自動重新讀取檔案。請再次選擇同一個檔案，已上傳的部分會直接略過。</p>
              <ul className="space-y-1.5 text-sm">
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
            </Panel>
          )}

          <div className="space-y-2">
            {items.map((it) => (
              <UploadRow key={it.key} it={it} />
            ))}
          </div>
        </div>

        <Panel title="處理選項（套用到接下來加入的檔案）">
          <div className="space-y-4">
            <Field label="標題（選填，單一檔案時使用）" hint="留空會用檔名；產生筆記時 AI 會建議更好的標題。">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：專案討論會議" />
            </Field>
            <Field label="輸出">
              <Select
                value={effective.noteTemplate}
                onChange={(e) => setOpts({ ...opts, noteTemplate: e.target.value as any, touched: true })}
                options={[
                  { value: "none", label: TEMPLATE_LABEL.none },
                  { value: "meeting", label: TEMPLATE_LABEL.meeting },
                  { value: "class", label: TEMPLATE_LABEL.class },
                ]}
              />
            </Field>
            <Field label="專案（選填）">
              <Select
                value={opts.projectId ?? ""}
                onChange={(e) => setOpts({ ...opts, projectId: e.target.value || null })}
                options={[{ value: "", label: "交給 AI 判斷 / 不指定" }, ...(projects.data?.items ?? []).map((p: any) => ({ value: p.id, label: p.name }))]}
              />
            </Field>
            {obsidian.data?.configured && (
              <Toggle checked={opts.autoExport ?? settings.data?.settings?.obsidian?.autoExport ?? true} onChange={(v) => setOpts({ ...opts, autoExport: v })} label="完成後存入 Obsidian" />
            )}
            <details className="rounded-md border border-line p-3">
              <summary className="cursor-pointer text-sm font-medium">進階選項</summary>
              <div className="mt-3 space-y-3">
                <Field label="語言" hint="預設自動偵測，中英混雜也能處理。中文輸出為台灣繁體。">
                  <Select
                    value={opts.language}
                    onChange={(e) => setOpts({ ...opts, language: e.target.value as any })}
                    options={[
                      { value: "auto", label: "Auto（自動偵測）" },
                      { value: "zh", label: "Chinese" },
                      { value: "en", label: "English" },
                    ]}
                  />
                </Field>
                <Field label="Vocabulary / Hotwords" hint="逗號或換行分隔，例如人名、專案名、英文術語。">
                  <Textarea rows={3} value={opts.vocabulary} onChange={(e) => setOpts({ ...opts, vocabulary: e.target.value })} placeholder="ICT 創創工坊, Qwen3-ASR, Obsidian" />
                </Field>
              </div>
            </details>
            <Button variant="primary" className="w-full" onClick={() => input.current?.click()}>
              選擇檔案並開始上傳
            </Button>
            <p className="text-xs text-muted">上傳完成後伺服器會驗證完整性，再建立轉錄任務。錄音只在這台主機的 GPU 上處理，不會上傳到外部服務。</p>
          </div>
        </Panel>
      </div>
    </div>
  );
}
