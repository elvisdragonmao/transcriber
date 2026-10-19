import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Download,
  ExternalLink,
  FileText,
  FolderInput,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  Save,
  Search,
  Sparkles,
  Trash2,
  UserCheck,
} from "lucide-react";
import { del, get, patch, post, type ExportItem, type Job, type NoteItem, type Recording, type RecordingSpeaker, type Segment, type Speaker, type Transcript } from "../lib/api";
import { clock, dateTime, duration, LANG_LABEL, SPEAKER_COLORS } from "../lib/format";
import { JobCard } from "../components/JobCard";
import { Waveform } from "../components/Waveform";
import { Markdown, frontmatterOf } from "../components/Markdown";
import { Badge, Button, Empty, ErrorNote, Field, Input, Modal, Panel, Select, Spinner, Textarea, Toggle, cx } from "../components/ui";

const color = (s?: RecordingSpeaker | null) => (s ? SPEAKER_COLORS[s.color % SPEAKER_COLORS.length] : "#94a3b8");

function useRecording(id: string) {
  return useQuery({ queryKey: ["recording", id], queryFn: () => get<Recording>(`/api/recordings/${id}`) });
}

// ---------------------------------------------------------------------------

function Player({
  rec,
  audioRef,
  currentMs,
  bands,
}: {
  rec: Recording;
  audioRef: React.RefObject<HTMLAudioElement | null>;
  currentMs: number;
  bands: { start: number; end: number; color: string }[];
}) {
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const on = () => setPlaying(!a.paused);
    a.addEventListener("play", on);
    a.addEventListener("pause", on);
    return () => {
      a.removeEventListener("play", on);
      a.removeEventListener("pause", on);
    };
  }, [audioRef]);
  if (!rec.hasAudio)
    return <div className="rounded-lg border border-line bg-panel px-4 py-3 text-sm text-muted">原始錄音已於 {dateTime(rec.audioDeletedAt)} 刪除，逐字稿仍保留，但無法播放。</div>;
  const dur = rec.durationMs ?? 0;
  return (
    <div className="rounded-lg border border-line bg-panel p-3">
      <audio ref={audioRef} src={`/api/recordings/${rec.id}/audio`} preload="metadata" />
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" className="size-10 rounded-full p-0" aria-label={playing ? "暫停" : "播放"} onClick={() => (audioRef.current!.paused ? audioRef.current!.play() : audioRef.current!.pause())}>
          {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
        </Button>
        <span className="text-sm tabular-nums">
          {clock(currentMs)} <span className="text-muted">/ {clock(dur)}</span>
        </span>
        <div className="ml-auto flex items-center gap-1 text-sm">
          {[0.75, 1, 1.25, 1.5, 2].map((r) => (
            <button
              key={r}
              className={cx("rounded px-2 py-1 tabular-nums", rate === r ? "bg-accent text-accent-fg" : "text-muted hover:bg-panel-2")}
              onClick={() => {
                setRate(r);
                audioRef.current!.playbackRate = r;
              }}
            >
              {r}×
            </button>
          ))}
        </div>
      </div>
      {dur > 0 && (
        <div className="mt-3">
          <Waveform
            recordingId={rec.id}
            durationMs={dur}
            currentMs={currentMs}
            bands={bands}
            onSeek={(ms) => {
              audioRef.current!.currentTime = ms / 1000;
            }}
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function SegmentEditor({ seg, speakers, onClose }: { seg: Segment; speakers: RecordingSpeaker[]; onClose: () => void }) {
  const qc = useQueryClient();
  const { id } = useParams();
  const [text, setText] = useState(seg.text);
  const [speaker, setSpeaker] = useState(seg.speakerId ?? "");
  const m = useMutation({
    mutationFn: () => patch(`/api/segments/${seg.id}`, { text: text !== seg.text ? text : undefined, recordingSpeakerId: speaker !== (seg.speakerId ?? "") ? speaker || null : undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["transcript", id] });
      onClose();
    },
  });
  return (
    <div className="mt-1 space-y-2">
      <Textarea rows={Math.min(8, Math.max(2, Math.ceil(text.length / 60)))} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
      <div className="flex flex-wrap items-center gap-2">
        <Select className="w-auto" value={speaker} onChange={(e) => setSpeaker(e.target.value)} options={[{ value: "", label: "Unknown Speaker" }, ...speakers.map((s) => ({ value: s.id, label: s.name }))]} />
        <Button size="sm" variant="primary" loading={m.isPending} onClick={() => m.mutate()}>
          <Save className="size-3.5" /> 儲存
        </Button>
        <Button size="sm" onClick={onClose}>
          取消
        </Button>
        {seg.edited && <span className="text-xs text-muted">原始模型輸出：{seg.textOriginal}</span>}
      </div>
      <ErrorNote error={m.error} />
    </div>
  );
}

/** The playing segment: original text (punctuation kept) with the current word highlighted. */
function ActiveText({ text, words, currentMs, seek }: { text: string; words: NonNullable<Segment["words"]>; currentMs: number; seek: (ms: number) => void }) {
  const parts: React.ReactNode[] = [];
  const lower = text.toLowerCase();
  let cursor = 0;
  words.forEach((w, wi) => {
    let i = text.indexOf(w.t, cursor);
    if (i < 0) i = lower.indexOf(w.t.toLowerCase(), cursor);
    if (i < 0 || i - cursor > 40) return;
    if (i > cursor) parts.push(text.slice(cursor, i));
    const on = currentMs >= w.s && currentMs < w.e + 120;
    parts.push(
      <span key={wi} onClick={(e) => (e.stopPropagation(), seek(w.s))} className={cx("rounded", on && "bg-accent/25")}>
        {text.slice(i, i + w.t.length)}
      </span>,
    );
    cursor = i + w.t.length;
  });
  parts.push(text.slice(cursor));
  return <>{parts}</>;
}

function TranscriptView({ t, currentMs, seek, follow }: { t: Transcript; currentMs: number; seek: (ms: number) => void; follow: boolean }) {
  const [query, setQuery] = useState("");
  const [hit, setHit] = useState(0);
  const [editing, setEditing] = useState<number | null>(null);
  const byId = useMemo(() => new Map(t.speakers.map((s) => [s.id, s])), [t.speakers]);
  const matches = useMemo(() => {
    if (!query.trim()) return [] as number[];
    const q = query.toLowerCase();
    return t.segments.flatMap((s, i) => (s.text.toLowerCase().includes(q) ? [i] : []));
  }, [query, t.segments]);
  const active = useMemo(() => {
    let lo = 0;
    let hi = t.segments.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (t.segments[mid].start <= currentMs) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans >= 0 && currentMs <= t.segments[ans].end + 1500 ? ans : -1;
  }, [currentMs, t.segments]);
  const rows = useRef<Map<number, HTMLDivElement>>(new Map());
  useEffect(() => {
    if (follow && active >= 0) rows.current.get(active)?.scrollIntoView({ block: "center", behavior: "smooth" }); // center keeps it clear of the pinned player
  }, [active, follow]);
  useEffect(() => {
    if (matches.length) rows.current.get(matches[Math.min(hit, matches.length - 1)])?.scrollIntoView({ block: "center" });
  }, [hit, matches]);

  const mark = (text: string) => {
    if (!query.trim()) return text;
    const parts = text.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"));
    return parts.map((p, i) => (i % 2 ? <mark key={i} className="rounded bg-warn/30 text-fg">{p}</mark> : p));
  };

  return (
    <div>
      <div className="mb-2 flex items-center gap-2 py-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted" />
          <Input className="pl-8" placeholder="搜尋逐字稿" value={query} onChange={(e) => (setQuery(e.target.value), setHit(0))} />
        </div>
        {query && (
          <div className="flex items-center gap-1 text-xs tabular-nums text-muted">
            {matches.length ? `${Math.min(hit, matches.length - 1) + 1}/${matches.length}` : "0"}
            <Button size="sm" variant="ghost" onClick={() => setHit((h) => (h - 1 + matches.length) % Math.max(1, matches.length))} aria-label="上一個">
              <ChevronUp className="size-4" />
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setHit((h) => (h + 1) % Math.max(1, matches.length))} aria-label="下一個">
              <ChevronDown className="size-4" />
            </Button>
          </div>
        )}
      </div>
      <div className="space-y-0.5">
        {t.segments.map((s, i) => {
          const sp = s.speakerId ? byId.get(s.speakerId) : null;
          const prev = i > 0 ? t.segments[i - 1] : null;
          const newBlock = !prev || prev.speakerId !== s.speakerId || prev.status !== s.status || s.start - prev.end > 6000;
          const overlapNames = s.overlapSpeakers.map((x) => byId.get(x)?.name ?? "?").join(" / ");
          return (
            <div
              key={s.id}
              ref={(el) => {
                if (el) rows.current.set(i, el);
                else rows.current.delete(i);
              }}
              className={cx("seg-row group relative rounded-md border-l-[3px] py-1.5 pl-3 pr-2", i === active ? "bg-accent/8" : "hover:bg-panel-2", newBlock && "mt-3")}
              style={{ borderLeftColor: color(sp) }}
            >
              {newBlock && (
                <div className="mb-0.5 flex flex-wrap items-center gap-2 text-[13px]">
                  <span className="font-semibold" style={{ color: color(sp) }}>
                    {s.status === "overlap" && overlapNames ? overlapNames : sp?.name ?? "Unknown Speaker"}
                  </span>
                  {s.status === "overlap" && <Badge tone="warn">重疊發言</Badge>}
                  {s.status === "uncertain" && <Badge tone="warn">講者未確定</Badge>}
                  {s.status === "manual" && <Badge>人工指定</Badge>}
                </div>
              )}
              <div className="flex gap-3">
                <button className="shrink-0 pt-0.5 text-xs tabular-nums text-muted hover:text-accent" onClick={() => seek(s.start)} title="跳到這裡">
                  {clock(s.start)}
                </button>
                <div className="min-w-0 flex-1">
                  {editing === s.id ? (
                    <SegmentEditor seg={s} speakers={t.speakers} onClose={() => setEditing(null)} />
                  ) : (
                    <p className="cursor-pointer leading-relaxed" onClick={() => seek(s.start)}>
                      {s.words && s.words.length && i === active && !query ? <ActiveText text={s.text} words={s.words} currentMs={currentMs} seek={seek} /> : mark(s.text)}
                      {s.edited && <span className="ml-1.5 align-middle text-[10px] text-muted">（已編輯）</span>}
                    </p>
                  )}
                </div>
                {editing !== s.id && (
                  <button className="h-6 shrink-0 rounded p-1 text-muted opacity-0 hover:bg-panel-2 hover:text-fg focus:opacity-100 group-hover:opacity-100" onClick={() => setEditing(s.id)} aria-label="編輯">
                    <Pencil className="size-3.5" />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function SpeakersPanel({ t, recordingId, seek }: { t: Transcript; recordingId: string; seek: (ms: number) => void }) {
  const qc = useQueryClient();
  const known = useQuery({ queryKey: ["speakers"], queryFn: () => get<{ items: Speaker[] }>("/api/speakers") });
  const [edit, setEdit] = useState<RecordingSpeaker | null>(null);
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [pick, setPick] = useState("");
  const [name, setName] = useState("");
  const [enroll, setEnroll] = useState(true);
  const save = useMutation({
    mutationFn: (body: any) => patch(`/api/recording-speakers/${body.id}`, body.payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["transcript", recordingId] });
      qc.invalidateQueries({ queryKey: ["speakers"] });
      setEdit(null);
    },
  });
  const firstSeg = (sid: string) => t.segments.find((s) => s.speakerId === sid);
  return (
    <div className="space-y-2">
      {t.speakers.map((s) => (
        <div key={s.id} className="flex flex-wrap items-center gap-3 rounded-md border border-line p-3">
          <span className="size-3 shrink-0 rounded-full" style={{ background: color(s) }} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{s.name}</span>
              {s.speakerId && s.name !== s.label && <span className="text-xs text-muted">({s.label})</span>}
              {s.assignment === "auto" && <Badge tone="ok">聲紋自動辨識 {s.matchScore?.toFixed(2)}</Badge>}
              {s.assignment === "manual" && <Badge tone="accent">人工命名</Badge>}
              {s.assignment === "suggested" && <Badge tone="warn">可能是 {s.suggestedName}（{s.matchScore?.toFixed(2)}）</Badge>}
              {s.assignment === "unknown" && <Badge>未辨識</Badge>}
            </div>
            <div className="text-xs text-muted">
              說話時間 {duration(s.speechMs)} · 可用於聲紋的乾淨語音 {duration(s.cleanSpeechMs)}
              {!s.hasEmbedding && " · 乾淨語音不足，未建立聲紋"}
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {firstSeg(s.id) && (
              <Button size="sm" variant="ghost" onClick={() => seek(firstSeg(s.id)!.start)}>
                <Play className="size-3.5" /> 試聽
              </Button>
            )}
            {s.assignment === "suggested" && s.suggestedSpeakerId && (
              <Button size="sm" onClick={() => save.mutate({ id: s.id, payload: { speakerId: s.suggestedSpeakerId, enroll: true } })}>
                <UserCheck className="size-3.5" /> 確認是 {s.suggestedName}
              </Button>
            )}
            <Button
              size="sm"
              onClick={() => {
                setEdit(s);
                setMode(known.data?.items.length ? "existing" : "new");
                setPick(s.speakerId ?? "");
                setName("");
                setEnroll(s.hasEmbedding);
              }}
            >
              <Pencil className="size-3.5" /> 命名
            </Button>
          </div>
        </div>
      ))}
      <Modal
        open={!!edit}
        onClose={() => setEdit(null)}
        title={`命名 ${edit?.label}`}
        footer={
          <>
            {edit?.speakerId && (
              <Button variant="ghost" onClick={() => save.mutate({ id: edit.id, payload: { speakerId: null } })}>
                改回未知
              </Button>
            )}
            <Button onClick={() => setEdit(null)}>取消</Button>
            <Button
              variant="primary"
              loading={save.isPending}
              disabled={mode === "existing" ? !pick : !name.trim()}
              onClick={() => save.mutate({ id: edit!.id, payload: mode === "existing" ? { speakerId: pick, enroll } : { newName: name.trim(), enroll } })}
            >
              儲存
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="flex gap-1 rounded-md border border-line p-1 text-sm">
            {(["existing", "new"] as const).map((m) => (
              <button key={m} className={cx("flex-1 rounded px-2 py-1", mode === m ? "bg-accent text-accent-fg" : "text-muted")} onClick={() => setMode(m)}>
                {m === "existing" ? "已知講者" : "新講者"}
              </button>
            ))}
          </div>
          {mode === "existing" ? (
            <Select value={pick} onChange={(e) => setPick(e.target.value)} options={[{ value: "", label: "選擇講者…" }, ...(known.data?.items ?? []).map((k) => ({ value: k.id, label: `${k.name}（${k.embeddings} 個聲紋）` }))]} />
          ) : (
            <Input placeholder="姓名" value={name} onChange={(e) => setName(e.target.value)} />
          )}
          <Toggle checked={enroll} disabled={!edit?.hasEmbedding} onChange={setEnroll} label="用這段錄音的聲音註冊／更新聲紋（改善之後的自動辨識）" />
          {!edit?.hasEmbedding && <p className="text-xs text-muted">這位講者在本錄音中沒有足夠長、未重疊的語音，無法建立可靠的聲紋；仍可只修改名稱。</p>}
          <ErrorNote error={save.error} />
        </div>
      </Modal>
    </div>
  );
}

// ---------------------------------------------------------------------------

function NotesPanel({ rec, exports }: { rec: Recording; exports: ExportItem[] }) {
  const qc = useQueryClient();
  const notes = useQuery({ queryKey: ["notes", rec.id], queryFn: () => get<{ items: NoteItem[] }>(`/api/recordings/${rec.id}/notes`) });
  const llm = useQuery({ queryKey: ["llm", "status"], queryFn: () => get("/api/llm/status") });
  const folders = useQuery({ queryKey: ["obsidian", "folders"], queryFn: () => get("/api/obsidian/folders"), retry: false });
  const [template, setTemplate] = useState<"meeting" | "class">(rec.noteTemplate === "class" ? "class" : "meeting");
  const [provider, setProvider] = useState<"claude" | "codex" | "">("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [moving, setMoving] = useState<NoteItem | null>(null);
  const [folder, setFolder] = useState("");
  const [deleting, setDeleting] = useState<NoteItem | null>(null);
  const [delVault, setDelVault] = useState(false);
  const cfg = llm.data?.settings;
  const prov = (provider || cfg?.provider || "claude") as "claude" | "codex";
  const pstatus = llm.data?.providers?.find((p: any) => p.provider === prov);
  const gen = useMutation({
    mutationFn: () => post(`/api/recordings/${rec.id}/notes`, { template, provider: prov, model: model || undefined, effort: effort || undefined }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["jobs"] }),
  });
  const save = useMutation({
    mutationFn: (args: { noteId: string; folder?: string; overwrite?: boolean }) => post(`/api/notes/${args.noteId}/obsidian`, { folder: args.folder, overwrite: args.overwrite }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["exports", rec.id] });
      setMoving(null);
    },
  });
  const remove = useMutation({
    mutationFn: (n: NoteItem) => del(`/api/notes/${n.id}`, delVault ? { deleteObsidianFile: true, confirm: "DELETE OBSIDIAN FILE" } : {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["notes", rec.id] });
      qc.invalidateQueries({ queryKey: ["exports", rec.id] });
      setDeleting(null);
    },
  });
  const active = rec.activeJobs.find((j) => j.type === "notes");
  return (
    <div className="space-y-4">
      <Panel title={<span className="flex items-center gap-1.5"><Sparkles className="size-4" /> 生成筆記</span>}>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="類型">
            <Select value={template} onChange={(e) => setTemplate(e.target.value as any)} options={[{ value: "meeting", label: "會議紀錄" }, { value: "class", label: "上課筆記" }]} />
          </Field>
          <Field label="Provider">
            <Select value={prov} onChange={(e) => (setProvider(e.target.value as any), setModel(""), setEffort(""))} options={(llm.data?.providers ?? []).map((p: any) => ({ value: p.provider, label: `${p.provider === "claude" ? "Claude Code" : "Codex"}${p.installed ? (p.loggedIn ? "" : "（未登入）") : "（未安裝）"}` }))} />
          </Field>
          <Field label="Model">
            <Select value={model || cfg?.[prov]?.model || ""} onChange={(e) => setModel(e.target.value)} options={[...new Set([cfg?.[prov]?.model, ...(cfg?.[prov]?.models ?? [])].filter(Boolean))].map((m: any) => ({ value: m, label: m }))} />
          </Field>
          <Field label="Thinking / Effort">
            <Select value={effort || cfg?.[prov]?.effort || ""} onChange={(e) => setEffort(e.target.value)} options={(pstatus?.efforts ?? []).map((x: string) => ({ value: x, label: x }))} />
          </Field>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button variant="primary" loading={gen.isPending} disabled={!rec.transcript || rec.transcript.status !== "complete" || !!active || !pstatus?.loggedIn} onClick={() => gen.mutate()}>
            <Sparkles className="size-4" /> {notes.data?.items.length ? "重新生成" : "生成"}
          </Button>
          {pstatus && !pstatus.loggedIn && <span className="text-sm text-warn">{pstatus.detail}</span>}
          <span className="text-xs text-muted">逐字稿文字會交給這台主機上已登入的 CLI 處理（可能使用其遠端模型服務），錄音檔不會被上傳。</span>
        </div>
        <ErrorNote error={gen.error} />
      </Panel>

      {notes.isLoading && <Spinner />}
      {notes.data?.items.length === 0 && !active && <Empty icon={<FileText className="size-8" />} title="還沒有筆記" />}
      {notes.data?.items.map((n) => {
        const exp = exports.find((e) => e.noteId === n.id && ["written", "pending_review"].includes(e.status));
        const c = n.classification?.classification;
        const fm = frontmatterOf(n.markdown);
        return (
          <Panel
            key={n.id}
            title={
              <span className="flex flex-wrap items-center gap-2">
                {n.title}
                <Badge>{n.template === "meeting" ? "會議紀錄" : "上課筆記"}</Badge>
              </span>
            }
            actions={
              <>
                {exp && (
                  <a href={exp.uri}>
                    <Button size="sm">
                      <ExternalLink className="size-3.5" /> Open in Obsidian
                    </Button>
                  </a>
                )}
                <Button size="sm" onClick={() => save.mutate({ noteId: n.id })} loading={save.isPending && save.variables?.noteId === n.id && !save.variables.folder}>
                  <Save className="size-3.5" /> {exp ? "重新存入" : "Save to Obsidian"}
                </Button>
                <Button size="sm" onClick={() => (setMoving(n), setFolder(exp?.suggestedPath?.split("/").slice(0, -1).join("/") ?? c?.suggested_folder ?? ""))}>
                  <FolderInput className="size-3.5" /> 移動
                </Button>
                <Button size="sm" variant="ghost" onClick={() => (setDeleting(n), setDelVault(false))} aria-label="刪除筆記">
                  <Trash2 className="size-3.5" />
                </Button>
              </>
            }
          >
            <div className="mb-3 grid gap-2 rounded-md bg-panel-2 p-3 text-[13px] sm:grid-cols-2">
              <div>
                <span className="text-muted">AI 分類：</span>
                {c?.document_type ?? "–"} · 信心 {c ? Math.round(c.classification_confidence * 100) : "–"}%
              </div>
              <div className="truncate">
                <span className="text-muted">Obsidian：</span>
                {exp ? (
                  <>
                    {exp.path}
                    {exp.status === "pending_review" && <Badge tone="warn" className="ml-1">待整理</Badge>}
                  </>
                ) : (
                  "尚未存入"
                )}
              </div>
              {exp?.status === "pending_review" && (
                <div className="sm:col-span-2 text-warn">
                  分類不確定，已先放在待整理位置。建議路徑：{exp.suggestedPath ?? "（無）"}
                  {exp.suggestedPath && (
                    <Button size="sm" className="ml-2" onClick={() => save.mutate({ noteId: n.id, folder: exp.suggestedPath!.split("/").slice(0, -1).join("/") })}>
                      <Check className="size-3.5" /> 採用建議
                    </Button>
                  )}
                </div>
              )}
              {c?.classification_reason && <div className="sm:col-span-2 text-muted">理由：{c.classification_reason}</div>}
              <div className="sm:col-span-2 text-xs text-muted">
                {n.provider}:{n.model} · effort {n.effort}
                {n.costUsd != null && ` · $${n.costUsd.toFixed(3)}`} · {dateTime(n.createdAt)} {fm.date && `· date ${fm.date}`}
              </div>
            </div>
            <Markdown source={n.markdown} />
          </Panel>
        );
      })}
      <ErrorNote error={save.error} />

      <Modal
        open={!!moving}
        onClose={() => setMoving(null)}
        title="移動到其他專案資料夾"
        footer={
          <>
            <Button onClick={() => setMoving(null)}>取消</Button>
            <Button variant="primary" disabled={!folder.trim()} loading={save.isPending} onClick={() => save.mutate({ noteId: moving!.id, folder: folder.trim() })}>
              移動
            </Button>
          </>
        }
      >
        <Field label="Vault 資料夾" hint="只能放在授權的資料夾內；不存在的資料夾會由伺服器驗證後建立。">
          <Input list="vault-folders" value={folder} onChange={(e) => setFolder(e.target.value)} />
          <datalist id="vault-folders">
            {(folders.data?.items ?? []).map((f: string) => (
              <option key={f} value={f} />
            ))}
          </datalist>
        </Field>
        <ErrorNote error={save.error} />
      </Modal>
      <Modal
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title="刪除筆記"
        footer={
          <>
            <Button onClick={() => setDeleting(null)}>取消</Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate(deleting!)}>
              刪除
            </Button>
          </>
        }
      >
        <p className="mb-3 text-sm">預設只刪除本系統中的筆記，已存入 Obsidian 的檔案會保留。</p>
        <Toggle checked={delVault} onChange={setDelVault} label={<span className={delVault ? "text-bad" : ""}>同時刪除 Obsidian 中由本系統建立的這份檔案</span>} />
        <ErrorNote error={remove.error} />
      </Modal>
    </div>
  );
}

// ---------------------------------------------------------------------------

function ObsidianPanel({ rec, exports }: { rec: Recording; exports: ExportItem[] }) {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["obsidian", "status"], queryFn: () => get("/api/obsidian/status") });
  const [preview, setPreview] = useState<ExportItem | null>(null);
  const content = useQuery({ queryKey: ["export-content", preview?.id], queryFn: () => get(`/api/obsidian/exports/${preview!.id}`), enabled: !!preview });
  const [overwrite, setOverwrite] = useState(false);
  const save = useMutation({
    mutationFn: () => post(`/api/recordings/${rec.id}/obsidian`, { overwrite }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["exports", rec.id] }),
  });
  const transcript = exports.find((e) => e.kind === "transcript" && e.status === "written");
  if (status.data && !status.data.configured)
    return (
      <Empty title="Obsidian 尚未設定">
        Vault 必須在這台主機上（filesystem）或透過 LiveSync MCP 存取。請到「設定 → Obsidian」設定。{status.data.detail}
      </Empty>
    );
  return (
    <div className="space-y-4">
      <Panel title="逐字稿">
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1 text-sm">{transcript ? <span className="break-all">{transcript.path}</span> : <span className="text-muted">尚未存入 Obsidian</span>}</div>
          {transcript && (
            <a href={transcript.uri}>
              <Button size="sm">
                <ExternalLink className="size-3.5" /> Open in Obsidian
              </Button>
            </a>
          )}
          {transcript && (
            <Button size="sm" onClick={() => setPreview(transcript)}>
              預覽 / 比較
            </Button>
          )}
          <Button size="sm" variant="primary" loading={save.isPending} disabled={rec.transcript?.status !== "complete"} onClick={() => save.mutate()}>
            <Save className="size-3.5" /> Save to Obsidian
          </Button>
        </div>
        <div className="mt-2">
          <Toggle checked={overwrite} onChange={setOverwrite} label="若 Obsidian 中的檔案已被手動修改，仍然覆蓋（否則會另存新版本）" />
        </div>
        {save.data && <div className="mt-2 text-sm text-ok">已存到 {save.data.path}{save.data.versioned && "（因既有檔案被修改過，另存為新版本）"}</div>}
        <ErrorNote error={save.error} />
      </Panel>
      <Panel title="匯出紀錄" pad={false}>
        <ul className="divide-y divide-line text-sm">
          {exports.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center gap-2 px-4 py-2">
              <Badge>{e.kind === "note" ? "筆記" : "逐字稿"}</Badge>
              <span className="min-w-0 flex-1 break-all">{e.path}</span>
              <Badge tone={e.status === "written" ? "ok" : e.status === "pending_review" ? "warn" : "neutral"}>{e.status}</Badge>
              <span className="text-xs text-muted">{dateTime(e.createdAt)}</span>
            </li>
          ))}
          {exports.length === 0 && <li className="px-4 py-4 text-center text-muted">沒有紀錄</li>}
        </ul>
      </Panel>
      <Modal open={!!preview} onClose={() => setPreview(null)} title={preview?.path} wide>
        {content.isLoading && <Spinner />}
        {content.data && (
          <>
            {content.data.modifiedByUser && <div className="mb-2 rounded-md bg-warn/15 px-3 py-2 text-sm text-warn">這份檔案在 Obsidian 中被修改過。再次存入時預設會另存新版本，不會覆蓋你的修改。</div>}
            {content.data.content === null ? <div className="text-sm text-muted">檔案已不存在於 vault。</div> : <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded bg-panel-2 p-3 text-xs">{content.data.content}</pre>}
          </>
        )}
      </Modal>
    </div>
  );
}

// ---------------------------------------------------------------------------

function DeleteModal({ rec, open, onClose }: { rec: Recording; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [what, setWhat] = useState<"audio" | "transcript" | "all">("audio");
  const [vault, setVault] = useState(false);
  const [typed, setTyped] = useState("");
  const m = useMutation({
    mutationFn: () =>
      what === "audio"
        ? del(`/api/recordings/${rec.id}/audio`)
        : what === "transcript"
          ? del(`/api/recordings/${rec.id}/transcript`)
          : del(`/api/recordings/${rec.id}`, vault ? { deleteObsidianFiles: true, confirm: "DELETE OBSIDIAN FILES" } : {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["recordings"] });
      onClose();
      if (what === "all") nav("/recordings");
      else qc.invalidateQueries({ queryKey: ["recording", rec.id] });
    },
  });
  const options = [
    { k: "audio", t: "只刪除原始錄音", d: "刪除原始檔與轉換後的音訊、中間結果。逐字稿、筆記、講者保留，但無法再播放或重新轉錄。" },
    { k: "transcript", t: "刪除逐字稿與處理紀錄", d: "刪除逐字稿、講者標記、轉錄任務紀錄與中間結果。錄音與筆記保留，可重新轉錄。" },
    { k: "all", t: "刪除整筆錄音", d: "刪除本系統中這筆錄音的所有資料（錄音、逐字稿、筆記、任務）。" },
  ] as const;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="刪除"
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="danger" loading={m.isPending} disabled={what === "all" && vault && typed !== "刪除"} onClick={() => m.mutate()}>
            確認刪除
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        {options.map((o) => (
          <label key={o.k} className={cx("block cursor-pointer rounded-md border p-3", what === o.k ? "border-bad/50 bg-bad/5" : "border-line")}>
            <input type="radio" className="mr-2" checked={what === o.k} onChange={() => setWhat(o.k)} disabled={o.k === "audio" && !rec.hasAudio} />
            <span className="font-medium">{o.t}</span>
            <div className="ml-5 text-xs text-muted">{o.d}</div>
          </label>
        ))}
        <p className="text-xs text-muted">已存入 Obsidian 的 Markdown 預設不會被刪除。</p>
        {what === "all" && (
          <div className="rounded-md border border-line p-3">
            <Toggle checked={vault} onChange={setVault} label={<span className={vault ? "text-bad" : ""}>也刪除本系統寫入 Obsidian 的檔案</span>} />
            {vault && (
              <Field className="mt-2" label="請輸入「刪除」確認刪除 Obsidian 中的檔案">
                <Input value={typed} onChange={(e) => setTyped(e.target.value)} />
              </Field>
            )}
          </div>
        )}
        <ErrorNote error={m.error} />
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

export function RecordingDetail() {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const rec = useRecording(id);
  const tr = useQuery({ queryKey: ["transcript", id], queryFn: () => get<Transcript>(`/api/recordings/${id}/transcript?words=1`), enabled: !!rec.data?.transcript, retry: false });
  const jobs = useQuery({ queryKey: ["jobs", "rec", id], queryFn: () => get<{ items: Job[] }>(`/api/jobs?recordingId=${id}&limit=20`) });
  const exports = useQuery({ queryKey: ["exports", id], queryFn: () => get<{ items: ExportItem[] }>(`/api/recordings/${id}/exports`) });
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => get("/api/projects") });
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [currentMs, setCurrentMs] = useState(0);
  const [tab, setTab] = useState<"transcript" | "speakers" | "notes" | "obsidian" | "info">("transcript");
  const [follow, setFollow] = useState(true);
  const [editTitle, setEditTitle] = useState<string | null>(null);
  const [delOpen, setDelOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const a = audioRef.current;
      if (a) setCurrentMs(a.currentTime * 1000);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  const seek = useCallback((ms: number) => {
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = ms / 1000;
    void a.play().catch(() => undefined);
  }, []);

  const update = useMutation({
    mutationFn: (body: any) => patch(`/api/recordings/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["recording", id] }),
  });
  const retranscribe = useMutation({ mutationFn: () => post(`/api/recordings/${id}/retranscribe`, { noteTemplate: "none" }), onSuccess: () => qc.invalidateQueries({ queryKey: ["jobs"] }) });

  const bands = useMemo(() => {
    const byId = new Map((tr.data?.speakers ?? []).map((s) => [s.id, s]));
    return (tr.data?.segments ?? []).map((s) => ({ start: s.start, end: s.end, color: s.status === "overlap" || s.status === "uncertain" ? "#94a3b8" : color(s.speakerId ? byId.get(s.speakerId) : null) }));
  }, [tr.data]);

  if (rec.isLoading) return <Spinner />;
  if (rec.isError || !rec.data) return <Empty title="找不到這筆錄音" />;
  const r = rec.data;
  const activeJobs = (jobs.data?.items ?? []).filter((j) => ["queued", "running", "pausing", "paused", "cancelling"].includes(j.status));
  const lastFailed = (jobs.data?.items ?? []).find((j) => j.status === "failed");
  const exp = exports.data?.items ?? [];
  const tabs = [
    ["transcript", "逐字稿"],
    ["speakers", `講者${tr.data ? `（${tr.data.speakers.length}）` : ""}`],
    ["notes", `筆記${r.noteCount ? `（${r.noteCount}）` : ""}`],
    ["obsidian", "Obsidian"],
    ["info", "資訊"],
  ] as const;

  return (
    <div className="space-y-4">
      {/* own stacking layer so the export menu opens above the pinned player (z-20) */}
      <div className="relative z-30 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {editTitle === null ? (
            <h1 className="flex items-center gap-2 text-xl font-semibold">
              <span className="truncate">{r.title}</span>
              <button className="rounded p-1 text-muted hover:bg-panel-2" onClick={() => setEditTitle(r.title)} aria-label="修改標題">
                <Pencil className="size-4" />
              </button>
            </h1>
          ) : (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                update.mutate({ title: editTitle });
                setEditTitle(null);
              }}
            >
              <Input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} autoFocus />
              <Button type="submit" variant="primary">
                儲存
              </Button>
              <Button type="button" onClick={() => setEditTitle(null)}>
                取消
              </Button>
            </form>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
            <span>{duration(r.durationMs)}</span>
            <span>{dateTime(r.recordedAt ?? r.createdAt)}</span>
            <span>{LANG_LABEL[r.languageHint]}{tr.data?.language ? ` → ${tr.data.language}` : ""}</span>
            <select
              className="rounded border border-line bg-panel px-1.5 py-0.5 text-sm text-fg"
              value={r.project?.id ?? ""}
              onChange={(e) => update.mutate({ projectId: e.target.value || null })}
              aria-label="專案"
            >
              <option value="">（未指定專案）</option>
              {(projects.data?.items ?? []).map((p: any) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <div className="relative">
            <Button onClick={() => setExportOpen(!exportOpen)} disabled={!tr.data}>
              <Download className="size-4" /> 匯出
            </Button>
            {exportOpen && (
              <div className="absolute right-0 z-40 mt-1 w-40 rounded-md border border-line bg-panel py-1 shadow-lg" onMouseLeave={() => setExportOpen(false)}>
                {["txt", "md", "json", "srt", "vtt"].map((f) => (
                  <a key={f} className="block px-3 py-1.5 text-sm hover:bg-panel-2" href={`/api/recordings/${id}/export?format=${f}`} onClick={() => setExportOpen(false)}>
                    {f.toUpperCase()}
                  </a>
                ))}
              </div>
            )}
          </div>
          {exp.find((e) => e.kind === "transcript" && e.status === "written") && (
            <a href={exp.find((e) => e.kind === "transcript" && e.status === "written")!.uri}>
              <Button>
                <ExternalLink className="size-4" /> Open in Obsidian
              </Button>
            </a>
          )}
          {r.hasAudio && !activeJobs.length && (
            <Button onClick={() => retranscribe.mutate()} loading={retranscribe.isPending}>
              <RefreshCw className="size-4" /> 重新轉錄
            </Button>
          )}
          <Button variant="danger" onClick={() => setDelOpen(true)}>
            <Trash2 className="size-4" /> 刪除
          </Button>
        </div>
      </div>

      {activeJobs.map((j) => (
        <JobCard key={j.id} job={j} showTitle={false} />
      ))}
      {!activeJobs.length && lastFailed && !r.transcript && <JobCard job={lastFailed} showTitle={false} />}

      {/* stays pinned while scrolling through a long transcript */}
      <div className="sticky top-[53px] z-20 -mx-4 bg-bg/95 px-4 py-2 backdrop-blur sm:-mx-6 sm:px-6 lg:top-0">
        <Player rec={r} audioRef={audioRef} currentMs={currentMs} bands={bands} />
      </div>

      <div className="flex gap-1 overflow-x-auto border-b border-line">
        {tabs.map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} className={cx("whitespace-nowrap border-b-2 px-3 py-2 text-sm", tab === k ? "border-accent font-medium text-fg" : "border-transparent text-muted hover:text-fg")}>
            {label}
          </button>
        ))}
        {tab === "transcript" && (
          <div className="ml-auto hidden items-center sm:flex">
            <Toggle checked={follow} onChange={setFollow} label={<span className="text-xs text-muted">播放時自動捲動</span>} />
          </div>
        )}
      </div>

      {tab === "transcript" &&
        (tr.data ? (
          tr.data.segments.length ? (
            <TranscriptView t={tr.data} currentMs={currentMs} seek={seek} follow={follow} />
          ) : (
            <Empty title="逐字稿是空的">這段錄音中沒有偵測到語音。</Empty>
          )
        ) : (
          <Empty title="逐字稿尚未完成">{activeJobs.length ? "轉錄進行中，完成後會自動顯示。" : "這筆錄音還沒有逐字稿。"}</Empty>
        ))}
      {tab === "speakers" && (tr.data ? <SpeakersPanel t={tr.data} recordingId={id} seek={seek} /> : <Empty title="逐字稿完成後才能編輯講者" />)}
      {tab === "notes" && <NotesPanel rec={r} exports={exp} />}
      {tab === "obsidian" && <ObsidianPanel rec={r} exports={exp} />}
      {tab === "info" && (
        <Panel title="錄音資訊">
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[160px_minmax(0,1fr)]">
            <dt className="text-muted">原始檔名</dt>
            <dd className="break-all">{r.originalFilename}</dd>
            <dt className="text-muted">大小 / 格式</dt>
            <dd>
              {(r.sizeBytes / 1024 / 1024).toFixed(1)} MB · {r.codec ?? "–"}
            </dd>
            <dt className="text-muted">Vocabulary</dt>
            <dd>
              <VocabEditor rec={r} />
            </dd>
            <dt className="text-muted">模型</dt>
            <dd className="space-y-0.5 text-xs">
              {Object.entries(tr.data?.modelInfo ?? {}).map(([k, v]) => (
                <div key={k}>
                  <span className="text-muted">{k}:</span> {v}
                </div>
              ))}
            </dd>
            <dt className="text-muted">語言分布</dt>
            <dd className="text-xs">
              {Object.entries(tr.data?.languages ?? {})
                .map(([k, v]) => `${k} ${duration(v)}`)
                .join(" · ") || "–"}
            </dd>
            <dt className="text-muted">建立時間</dt>
            <dd>{dateTime(r.createdAt)}</dd>
          </dl>
        </Panel>
      )}
      <DeleteModal rec={r} open={delOpen} onClose={() => setDelOpen(false)} />
    </div>
  );
}

function VocabEditor({ rec }: { rec: Recording }) {
  const qc = useQueryClient();
  const [v, setV] = useState(rec.vocabulary);
  const m = useMutation({ mutationFn: () => patch(`/api/recordings/${rec.id}`, { vocabulary: v }), onSuccess: () => qc.invalidateQueries({ queryKey: ["recording", rec.id] }) });
  return (
    <div className="space-y-1.5">
      <Textarea rows={2} value={v} onChange={(e) => setV(e.target.value)} placeholder="重新轉錄時使用的專有名詞" />
      {v !== rec.vocabulary && (
        <Button size="sm" onClick={() => m.mutate()} loading={m.isPending}>
          儲存（下次重新轉錄生效）
        </Button>
      )}
    </div>
  );
}
