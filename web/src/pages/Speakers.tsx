import { useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitMerge, Mic, Plus, Trash2, Users } from "lucide-react";
import { del, get, patch, post, type Speaker } from "../lib/api";
import { dateTime, duration } from "../lib/format";
import { Badge, Button, Empty, ErrorNote, Field, Input, Modal, Panel, Select, Spinner, Textarea, cx } from "../components/ui";

function SpeakerDetail({ id }: { id: string }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const d = useQuery({ queryKey: ["speaker", id], queryFn: () => get(`/api/speakers/${id}`) });
  const all = useQuery({ queryKey: ["speakers"], queryFn: () => get<{ items: Speaker[] }>("/api/speakers") });
  const [name, setName] = useState<string | null>(null);
  const [aliases, setAliases] = useState<string | null>(null);
  const [notes, setNotes] = useState<string | null>(null);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [into, setInto] = useState("");
  const [delOpen, setDelOpen] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["speaker", id] });
    qc.invalidateQueries({ queryKey: ["speakers"] });
  };
  const save = useMutation({
    mutationFn: () =>
      patch(`/api/speakers/${id}`, {
        name: name ?? undefined,
        notes: notes ?? undefined,
        aliases: aliases !== null ? aliases.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean) : undefined,
      }),
    onSuccess: () => {
      setName(null);
      setAliases(null);
      setNotes(null);
      refresh();
    },
  });
  const merge = useMutation({ mutationFn: () => post(`/api/speakers/${id}/merge`, { into }), onSuccess: () => (refresh(), nav(`/speakers/${into}`)) });
  const remove = useMutation({ mutationFn: () => del(`/api/speakers/${id}`), onSuccess: () => (refresh(), nav("/speakers")) });
  const delVp = useMutation({ mutationFn: (vid: string) => del(`/api/voiceprints/${vid}`), onSuccess: refresh });
  const enroll = useMutation({
    mutationFn: async (f: File) => {
      const res = await fetch(`/api/speakers/${id}/enroll-clip`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: f });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.message ?? `HTTP ${res.status}`);
      return j;
    },
    onSuccess: refresh,
  });
  if (d.isLoading) return <Spinner />;
  if (!d.data) return null;
  const s = d.data;
  return (
    <div className="space-y-4">
      <Panel
        title={s.name}
        actions={
          <>
            <Button size="sm" onClick={() => setMergeOpen(true)}>
              <GitMerge className="size-3.5" /> 合併
            </Button>
            <Button size="sm" variant="danger" onClick={() => setDelOpen(true)}>
              <Trash2 className="size-3.5" /> 刪除講者
            </Button>
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="姓名">
            <Input value={name ?? s.name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="別名" hint="逗號分隔；合併時舊名稱會自動加入。">
            <Input value={aliases ?? s.aliases.join(", ")} onChange={(e) => setAliases(e.target.value)} />
          </Field>
          <Field label="備註" className="sm:col-span-2">
            <Textarea rows={2} value={notes ?? s.notes ?? ""} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>
        {(name !== null || aliases !== null || notes !== null) && (
          <Button className="mt-3" variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            儲存
          </Button>
        )}
        <ErrorNote error={save.error} />
      </Panel>

      <Panel
        title={`聲紋（${s.embeddingList.length}）`}
        actions={
          <Button size="sm" onClick={() => file.current?.click()} loading={enroll.isPending}>
            <Mic className="size-3.5" /> 上傳語音片段註冊
          </Button>
        }
        pad={false}
      >
        <input ref={file} type="file" hidden accept="audio/*,.mp3,.wav,.m4a,.flac,.ogg,.opus" onChange={(e) => e.target.files?.[0] && enroll.mutate(e.target.files[0])} />
        <div className="px-4 pt-3 text-xs text-muted">
          聲紋使用 TitaNet-Large（以英文資料訓練），中文的相似度分數可靠度較低，因此自動命名採保守門檻；不確定時保留為未知講者。最好以 10 秒以上、單人、無背景音的片段註冊。
        </div>
        <ErrorNote error={enroll.error} />
        <ul className="divide-y divide-line text-sm">
          {s.embeddingList.map((e: any) => (
            <li key={e.id} className="flex flex-wrap items-center gap-2 px-4 py-2">
              <Badge tone={e.source === "manual" ? "accent" : "neutral"}>{e.source === "clip" ? "語音片段" : e.source === "manual" ? "人工確認" : e.source}</Badge>
              <span className="min-w-0 flex-1 truncate">{e.recordingId ? <Link className="hover:underline" to={`/recordings/${e.recordingId}`}>{e.recordingTitle}</Link> : "上傳的片段"}</span>
              <span className="text-xs text-muted">
                {duration(e.speechMs)} · {e.language ?? "–"} · {dateTime(e.createdAt)}
              </span>
              <Button size="sm" variant="ghost" onClick={() => delVp.mutate(e.id)} aria-label="刪除聲紋">
                <Trash2 className="size-3.5" />
              </Button>
            </li>
          ))}
          {s.embeddingList.length === 0 && <li className="px-4 py-4 text-center text-muted">尚未註冊聲紋，無法自動辨識這位講者。</li>}
        </ul>
      </Panel>

      <Panel title="出現在" pad={false}>
        <ul className="divide-y divide-line text-sm">
          {s.appearances.map((a: any) => (
            <li key={a.id} className="flex items-center gap-2 px-4 py-2">
              <Link className="min-w-0 flex-1 truncate hover:underline" to={`/recordings/${a.recording_id}`}>
                {a.title}
              </Link>
              <Badge tone={a.assignment === "auto" ? "ok" : "accent"}>{a.assignment === "auto" ? `自動 ${a.match_score?.toFixed(2)}` : "人工"}</Badge>
            </li>
          ))}
          {s.appearances.length === 0 && <li className="px-4 py-4 text-center text-muted">沒有紀錄</li>}
        </ul>
      </Panel>

      <Modal
        open={mergeOpen}
        onClose={() => setMergeOpen(false)}
        title={`把「${s.name}」合併到…`}
        footer={
          <>
            <Button onClick={() => setMergeOpen(false)}>取消</Button>
            <Button variant="primary" disabled={!into} loading={merge.isPending} onClick={() => merge.mutate()}>
              合併
            </Button>
          </>
        }
      >
        <p className="mb-3 text-sm text-muted">聲紋、錄音中的身分都會移到目標講者，原名稱成為別名。</p>
        <Select value={into} onChange={(e) => setInto(e.target.value)} options={[{ value: "", label: "選擇目標講者…" }, ...(all.data?.items ?? []).filter((x) => x.id !== id).map((x) => ({ value: x.id, label: x.name }))]} />
        <ErrorNote error={merge.error} />
      </Modal>
      <Modal
        open={delOpen}
        onClose={() => setDelOpen(false)}
        title="刪除講者"
        footer={
          <>
            <Button onClick={() => setDelOpen(false)}>取消</Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>
              刪除
            </Button>
          </>
        }
      >
        <p className="text-sm">會刪除此講者與所有聲紋。錄音中的對應講者會變回 Speaker N，逐字稿內容不變。</p>
      </Modal>
    </div>
  );
}

export function SpeakersPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const nav = useNavigate();
  const list = useQuery({ queryKey: ["speakers"], queryFn: () => get<{ items: Speaker[] }>("/api/speakers") });
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: () => post("/api/speakers", { name }),
    onSuccess: (s: any) => {
      qc.invalidateQueries({ queryKey: ["speakers"] });
      setAdding(false);
      setName("");
      nav(`/speakers/${s.id}`);
    },
  });
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">講者</h1>
        <Button variant="primary" onClick={() => setAdding(true)}>
          <Plus className="size-4" /> 新增講者
        </Button>
      </div>
      <div className="grid gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
        <div className="overflow-hidden rounded-lg border border-line bg-panel">
          {list.isLoading && <Spinner className="m-4" />}
          {list.data?.items.length === 0 && <Empty icon={<Users className="size-8" />} title="還沒有已知講者">在錄音的「講者」分頁命名後就會出現在這裡。</Empty>}
          <ul className="divide-y divide-line">
            {list.data?.items.map((s) => (
              <li key={s.id}>
                <Link to={`/speakers/${s.id}`} className={cx("block px-4 py-2.5 hover:bg-panel-2", id === s.id && "bg-accent/8")}>
                  <div className="font-medium">{s.name}</div>
                  <div className="text-xs text-muted">
                    {s.embeddings} 個聲紋 · {duration(s.enrolledMs)} · {s.recordings} 份錄音
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </div>
        <div>{id ? <SpeakerDetail key={id} id={id} /> : <Empty title="選擇一位講者" />}</div>
      </div>
      <Modal
        open={adding}
        onClose={() => setAdding(false)}
        title="新增講者"
        footer={
          <>
            <Button onClick={() => setAdding(false)}>取消</Button>
            <Button variant="primary" disabled={!name.trim()} loading={create.isPending} onClick={() => create.mutate()}>
              建立
            </Button>
          </>
        }
      >
        <Field label="姓名">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <ErrorNote error={create.error} />
      </Modal>
    </div>
  );
}
