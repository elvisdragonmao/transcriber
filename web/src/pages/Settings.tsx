import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, RefreshCw, XCircle } from "lucide-react";
import { get, patch, post } from "../lib/api";
import { bytes, dateTime } from "../lib/format";
import { Badge, Button, ErrorNote, Field, Input, Panel, Select, Spinner, Textarea, Toggle, cx } from "../components/ui";

type S = any;

function useSettings() {
  return useQuery({ queryKey: ["settings"], queryFn: () => get<{ settings: S }>("/api/settings") });
}

function SectionForm({ section, render }: { section: string; render: (v: any, set: (k: string, val: any) => void) => ReactNode }) {
  const qc = useQueryClient();
  const s = useSettings();
  const [draft, setDraft] = useState<any>(null);
  useEffect(() => {
    if (s.data && !draft) setDraft(structuredClone(s.data.settings[section]));
  }, [s.data, draft, section]);
  const save = useMutation({
    mutationFn: () => patch("/api/settings", { [section]: draft }),
    onSuccess: (r: any) => {
      qc.setQueryData(["settings"], r);
      setDraft(structuredClone(r.settings[section]));
      qc.invalidateQueries({ queryKey: ["llm"] });
      qc.invalidateQueries({ queryKey: ["obsidian"] });
      qc.invalidateQueries({ queryKey: ["system"] });
    },
  });
  if (!draft) return <Spinner />;
  const dirty = JSON.stringify(draft) !== JSON.stringify(s.data?.settings[section]);
  return (
    <div className="space-y-4">
      {render(draft, (k, val) => setDraft({ ...draft, [k]: val }))}
      <div className="flex items-center gap-2">
        <Button variant="primary" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>
          儲存
        </Button>
        {dirty && (
          <Button variant="ghost" onClick={() => setDraft(structuredClone(s.data!.settings[section]))}>
            還原
          </Button>
        )}
        {save.isSuccess && !dirty && <span className="text-sm text-ok">已儲存</span>}
      </div>
      <ErrorNote error={save.error} />
    </div>
  );
}

const num = (v: string) => (v === "" ? 0 : Number(v));

function GpuSection() {
  const gpus = useQuery({ queryKey: ["system", "gpus"], queryFn: () => get("/api/system/gpus") });
  const diag = useMutation({ mutationFn: () => post("/api/system/diagnostics") });
  const opts = [...(gpus.data?.gpus ?? []).map((g: any) => ({ value: g.uuid, label: `${g.name}（${(g.memoryTotalMiB / 1024).toFixed(0)} GB · ${g.uuid.slice(0, 12)}…）` }))];
  return (
    <SectionForm
      section="gpu"
      render={(v, set) => (
        <>
          <p className="text-sm text-muted">裝置以 GPU UUID 指定，而不是 cuda:0 這類編號（編號會因 PCIe 順序改變）。每個 worker 透過 CUDA_VISIBLE_DEVICES 只看得到自己的 GPU，兩張卡的 VRAM 不會合併使用。</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="ASR + Forced Alignment GPU" hint="建議 RTX 5060 8GB">
              <Select value={v.asrDevice} onChange={(e) => set("asrDevice", e.target.value)} options={[{ value: "", label: "（未設定）" }, ...opts]} />
            </Field>
            <Field label="Speaker Diarization 裝置" hint="建議 RTX 3050 6GB">
              <Select value={v.diarDevice} onChange={(e) => set("diarDevice", e.target.value)} options={[...opts, { value: "cpu", label: "CPU（較慢）" }]} />
            </Field>
            <Field label="Diarization GPU 失敗時" hint="OOM 或架構不支援時">
              <Select value={v.diarFallback} onChange={(e) => set("diarFallback", e.target.value)} options={[{ value: "cpu", label: "改用 CPU 執行（UI 會標示較慢）" }, { value: "fail", label: "直接失敗並顯示診斷" }]} />
            </Field>
            <Field label="ASR 與 Aligner 共存" hint="實測兩者常駐約 5.7 GB；auto 會在 OOM 時改為依序載入">
              <Select value={v.coResident} onChange={(e) => set("coResident", e.target.value)} options={[{ value: "auto", label: "auto" }, { value: "always", label: "always" }, { value: "never", label: "never（依序載入）" }]} />
            </Field>
            <Field label="閒置多久卸載模型（秒）">
              <Input type="number" value={v.idleUnloadSec} onChange={(e) => set("idleUnloadSec", num(e.target.value))} />
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => diag.mutate()} loading={diag.isPending}>
              執行 GPU worker 診斷
            </Button>
            {gpus.data?.suggested && (
              <span className="text-xs text-muted">
                偵測建議：ASR → {gpus.data.suggested.asrDevice.slice(0, 12)}…，Diarization → {gpus.data.suggested.diarDevice.slice(0, 12)}…
              </span>
            )}
          </div>
          {diag.data && <pre className="max-h-80 overflow-auto rounded bg-panel-2 p-3 text-xs">{JSON.stringify(diag.data, null, 2)}</pre>}
        </>
      )}
    />
  );
}

function ModelsSection() {
  return (
    <div className="space-y-6">
      <SectionForm
        section="asr"
        render={(v, set) => (
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="ASR 模型">
              <Input value={v.model} disabled />
            </Field>
            <Field label="Forced Aligner 模型">
              <Input value={v.alignerModel} disabled />
            </Field>
            <Field label="預設語言">
              <Select value={v.defaultLanguage} onChange={(e) => set("defaultLanguage", e.target.value)} options={[{ value: "auto", label: "Auto" }, { value: "zh", label: "Chinese" }, { value: "en", label: "English" }]} />
            </Field>
            <Field label="中文輸出" hint="OpenCC；英文與自訂詞彙不受影響">
              <Select value={v.chineseScript} onChange={(e) => set("chineseScript", e.target.value)} options={[{ value: "s2twp", label: "台灣繁體（含用語）" }, { value: "s2tw", label: "台灣繁體（只轉字）" }, { value: "none", label: "不轉換" }]} />
            </Field>
            <Field label="ASR 區段上限（秒）" hint="VAD 依停頓切段；超過時在最安靜處切">
              <Input type="number" value={v.maxSegmentSec} onChange={(e) => set("maxSegmentSec", num(e.target.value))} />
            </Field>
            <Field label="前文上下文字數" hint="把上一段文字作為提示，避免句子斷裂">
              <Input type="number" value={v.contextChars} onChange={(e) => set("contextChars", num(e.target.value))} />
            </Field>
            <div className="sm:col-span-3">
              <Toggle checked={v.normalize} onChange={(x) => set("normalize", x)} label="VAD / ASR 使用音量正規化的副本（小聲、遠距離講者較不會漏字）" />
            </div>
          </div>
        )}
      />
      <hr className="border-line" />
      <SectionForm
        section="vad"
        render={(v, set) => (
          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="Silero VAD threshold">
              <Input type="number" step="0.05" value={v.threshold} onChange={(e) => set("threshold", num(e.target.value))} />
            </Field>
            <Field label="Minimum speech (ms)">
              <Input type="number" value={v.minSpeechMs} onChange={(e) => set("minSpeechMs", num(e.target.value))} />
            </Field>
            <Field label="Minimum silence (ms)">
              <Input type="number" value={v.minSilenceMs} onChange={(e) => set("minSilenceMs", num(e.target.value))} />
            </Field>
            <Field label="Speech padding (ms)">
              <Input type="number" value={v.speechPadMs} onChange={(e) => set("speechPadMs", num(e.target.value))} />
            </Field>
          </div>
        )}
      />
      <hr className="border-line" />
      <SectionForm
        section="identify"
        render={(v, set) => (
          <>
            <p className="text-sm text-muted">TitaNet 以英文資料訓練，中文分數可靠度較低，所以中文門檻預設較高。只有分數超過門檻、且與第二名差距足夠時才自動命名，否則保留 Unknown（可能顯示建議）。請用「講者 → 校準」資料調整。</p>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="英文門檻">
                <Input type="number" step="0.01" value={v.thresholdEn} onChange={(e) => set("thresholdEn", num(e.target.value))} />
              </Field>
              <Field label="中文門檻">
                <Input type="number" step="0.01" value={v.thresholdZh} onChange={(e) => set("thresholdZh", num(e.target.value))} />
              </Field>
              <Field label="其他語言門檻">
                <Input type="number" step="0.01" value={v.thresholdOther} onChange={(e) => set("thresholdOther", num(e.target.value))} />
              </Field>
              <Field label="與第二名的最小差距">
                <Input type="number" step="0.01" value={v.minMargin} onChange={(e) => set("minMargin", num(e.target.value))} />
              </Field>
              <Field label="最少乾淨語音（秒）">
                <Input type="number" value={v.minTotalCleanSec} onChange={(e) => set("minTotalCleanSec", num(e.target.value))} />
              </Field>
              <Field label="單段最短（秒）">
                <Input type="number" step="0.5" value={v.minCleanSegmentSec} onChange={(e) => set("minCleanSegmentSec", num(e.target.value))} />
              </Field>
            </div>
            <Toggle checked={v.enabled} onChange={(x) => set("enabled", x)} label="啟用跨錄音聲紋辨識" />
          </>
        )}
      />
      <hr className="border-line" />
      <SectionForm
        section="diar"
        render={(v, set) => (
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Diarization 模型">
              <Input value={v.model} disabled />
            </Field>
            <Field label="Chunk / right context（80ms frames）" hint="預設為模型卡的 offline 設定 340 / 40（30.4 秒）">
              <div className="flex gap-2">
                <Input type="number" value={v.chunkLen} onChange={(e) => set("chunkLen", num(e.target.value))} />
                <Input type="number" value={v.rightContext} onChange={(e) => set("rightContext", num(e.target.value))} />
              </div>
            </Field>
            <Field label="最多講者">
              <Input type="number" value={v.maxSpeakers} onChange={(e) => set("maxSpeakers", num(e.target.value))} />
            </Field>
          </div>
        )}
      />
    </div>
  );
}

function LlmSection() {
  const qc = useQueryClient();
  const st = useQuery({ queryKey: ["llm", "status"], queryFn: () => get("/api/llm/status") });
  const usage = useQuery({ queryKey: ["llm", "usage"], queryFn: () => get("/api/llm/usage") });
  const test = useMutation({ mutationFn: (b: any) => post("/api/llm/test", b), onSuccess: () => qc.invalidateQueries({ queryKey: ["settings"] }) });
  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2">
        {(st.data?.providers ?? []).map((p: any) => (
          <div key={p.provider} className="rounded-md border border-line p-3 text-sm">
            <div className="flex items-center gap-2 font-medium">
              {p.installed && p.loggedIn ? <CheckCircle2 className="size-4 text-ok" /> : <XCircle className="size-4 text-bad" />}
              {p.provider === "claude" ? "Claude Code CLI" : "OpenAI Codex CLI"}
            </div>
            <div className="mt-1 text-xs text-muted">
              {p.installed ? `版本 ${p.version}` : "未安裝"} · {p.loggedIn ? `已登入 ${p.account ?? ""}` : "未登入"}
            </div>
            <div className="mt-1 text-xs text-muted">{p.detail}</div>
          </div>
        ))}
      </div>
      <Button size="sm" variant="ghost" onClick={() => qc.fetchQuery({ queryKey: ["llm", "status"], queryFn: () => get("/api/llm/status?refresh=1") }).then((d) => qc.setQueryData(["llm", "status"], d))}>
        <RefreshCw className="size-3.5" /> 重新檢查 CLI 狀態
      </Button>
      <SectionForm
        section="llm"
        render={(v, set) => {
          const prov = v.provider as "claude" | "codex";
          const efforts = st.data?.providers?.find((p: any) => p.provider === prov)?.efforts ?? [];
          const verified = (m: string) => v.verifiedModels?.[`${prov}:${m}`];
          return (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="預設 Provider">
                  <Select value={v.provider} onChange={(e) => set("provider", e.target.value)} options={[{ value: "claude", label: "Claude Code" }, { value: "codex", label: "Codex" }]} />
                </Field>
                <Field label="Model" hint={prov === "claude" ? "別名（sonnet / opus / fable / haiku）會解析為目前最新版本" : "留空使用 Codex 帳號預設模型"}>
                  <Select value={v[prov].model} onChange={(e) => set(prov, { ...v[prov], model: e.target.value })} options={[{ value: "", label: "（CLI 預設）" }, ...v[prov].models.map((m: string) => ({ value: m, label: `${m}${verified(m) ? " ✓" : ""}` }))]} />
                </Field>
                <Field label="Thinking / Reasoning effort">
                  <Select value={v[prov].effort} onChange={(e) => set(prov, { ...v[prov], effort: e.target.value })} options={efforts.map((x: string) => ({ value: x, label: x }))} />
                </Field>
                <Field label={`${prov} 可選模型（每行一個）`} className="sm:col-span-2" hint="清單由你維護；用「測試」實際呼叫一次 CLI 驗證後會標記 ✓">
                  <Textarea rows={3} value={v[prov].models.join("\n")} onChange={(e) => set(prov, { ...v[prov], models: e.target.value.split("\n").map((s: string) => s.trim()).filter(Boolean) })} />
                </Field>
                <div className="flex items-end">
                  <Button onClick={() => test.mutate({ provider: prov, model: v[prov].model, effort: v[prov].effort })} loading={test.isPending}>
                    測試執行
                  </Button>
                </div>
                <Field label="預設筆記模板">
                  <Select value={v.defaultTemplate} onChange={(e) => set("defaultTemplate", e.target.value)} options={[{ value: "none", label: "只要逐字稿" }, { value: "meeting", label: "會議紀錄" }, { value: "class", label: "上課筆記" }]} />
                </Field>
                <Field label="預設生成語言">
                  <Input value={v.language} onChange={(e) => set("language", e.target.value)} />
                </Field>
                <Field label="逾時（秒）">
                  <Input type="number" value={v.timeoutSec} onChange={(e) => set("timeoutSec", num(e.target.value))} />
                </Field>
                <Field label="單次預算上限（USD，Claude）">
                  <Input type="number" step="0.1" value={v.maxBudgetUsd} onChange={(e) => set("maxBudgetUsd", num(e.target.value))} />
                </Field>
                <Field label="每日呼叫上限" hint={`今天已呼叫 ${st.data?.callsToday ?? "–"} 次`}>
                  <Input type="number" value={v.dailyCallLimit} onChange={(e) => set("dailyCallLimit", num(e.target.value))} />
                </Field>
              </div>
              {test.data && <div className="text-sm text-ok">測試成功：{test.data.resolvedModel ?? ""} {test.data.costUsd != null && `($${test.data.costUsd.toFixed(4)})`}</div>}
              <ErrorNote error={test.error} />
              <p className="text-xs text-muted">CLI 以非互動模式執行：Claude 關閉所有工具與 MCP、不載入使用者設定（--tools "" --strict-mcp-config --safe-mode）；Codex 使用 read-only sandbox、ephemeral、忽略使用者設定。逐字稿一律視為不可信資料。</p>
            </>
          );
        }}
      />
      <Panel title="近 30 天用量" pad={false}>
        <table className="w-full text-sm">
          <tbody className="divide-y divide-line">
            {(usage.data?.items ?? []).map((u: any) => (
              <tr key={u.day + u.provider}>
                <td className="px-4 py-1.5">{u.day}</td>
                <td className="px-3">{u.provider}</td>
                <td className="px-3 tabular-nums">
                  {u.ok}/{u.calls} 成功
                </td>
                <td className="px-3 text-right tabular-nums">${u.cost_usd}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}

function ObsidianSection() {
  const st = useQuery({ queryKey: ["obsidian", "status"], queryFn: () => get("/api/obsidian/status") });
  const det = useQuery({ queryKey: ["obsidian", "detect"], queryFn: () => get("/api/obsidian/detect") });
  return (
    <div className="space-y-4">
      {st.data && (
        <div className={cx("rounded-md border p-3 text-sm", st.data.ok ? "border-ok/40 bg-ok/5" : "border-warn/40 bg-warn/5")}>
          <div className="font-medium">
            {st.data.ok ? "Vault 可存取" : "Vault 無法使用"} {st.data.writable && <Badge tone="ok">可寫入</Badge>}
          </div>
          <div className="text-muted">{st.data.detail}</div>
          {st.data.ok && (
            <div className="mt-1 text-xs">
              Trans 根資料夾：{st.data.transRootExists ? "找到" : "不存在（寫入時會建立）"} · 逐字稿資料夾：{st.data.transcriptFolderExists ? "找到" : "不存在（寫入時會建立）"}
              {st.data.semantic && " · 語意搜尋可用"}
            </div>
          )}
        </div>
      )}
      <SectionForm
        section="obsidian"
        render={(v, set) => (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Vault 存取方式" hint="Vault 不在這台主機時，需掛載目錄或使用 LiveSync MCP；系統不會假設可以跨機器寫檔。">
                <Select
                  value={v.backend}
                  onChange={(e) => set("backend", e.target.value)}
                  options={[
                    { value: "none", label: "未設定" },
                    { value: "filesystem", label: "本機檔案系統（vault 在這台主機或已掛載）" },
                    { value: "livesync-mcp", label: `LiveSync（obsidian-sync-mcp）${det.data?.livesyncAvailable ? "" : "— 伺服器未設定 token"}` },
                  ]}
                />
              </Field>
              <Field label="Vault 名稱（Obsidian URI 用）" hint="必須和你裝置上 Obsidian 顯示的 vault 名稱相同">
                <Input value={v.vaultName} onChange={(e) => set("vaultName", e.target.value)} />
              </Field>
              {v.backend === "filesystem" && (
                <Field label="Vault Root（絕對路徑）" className="sm:col-span-2" hint={det.data?.local?.length ? `偵測到：${det.data.local.join("、")}` : "這台主機上沒有偵測到含 .obsidian 的資料夾"}>
                  <Input value={v.vaultRoot} onChange={(e) => set("vaultRoot", e.target.value)} placeholder="/home/em/vault" />
                </Field>
              )}
              <Field label="Trans 根資料夾（相對 vault）">
                <Input value={v.transRoot} onChange={(e) => set("transRoot", e.target.value)} />
              </Field>
              <Field label="逐字稿資料夾">
                <Input value={v.transcriptFolder} onChange={(e) => set("transcriptFolder", e.target.value)} />
              </Field>
              <Field label="待整理位置（分類不確定時）">
                <Input value={v.pendingFolder} onChange={(e) => set("pendingFolder", e.target.value)} />
              </Field>
              <Field label="自動歸檔信心門檻">
                <Input type="number" step="0.05" value={v.autoFileConfidence} onChange={(e) => set("autoFileConfidence", num(e.target.value))} />
              </Field>
              <Field label="允許寫入的資料夾（每行一個）" hint="所有寫入、移動都只能在這些資料夾內">
                <Textarea rows={2} value={v.allowedRoots.join("\n")} onChange={(e) => set("allowedRoots", e.target.value.split("\n").map((s: string) => s.trim()).filter(Boolean))} />
              </Field>
              <Field label="掃描專案的資料夾（唯讀，每行一個）">
                <Textarea rows={2} value={v.scanRoots.join("\n")} onChange={(e) => set("scanRoots", e.target.value.split("\n").map((s: string) => s.trim()).filter(Boolean))} />
              </Field>
              <Field label="逐字稿檔名" hint="{yymmdd} {yyyy-mm-dd} {title}">
                <Input value={v.transcriptName} onChange={(e) => set("transcriptName", e.target.value)} />
              </Field>
              <Field label="會議紀錄 / 上課筆記檔名">
                <div className="flex gap-2">
                  <Input value={v.meetingName} onChange={(e) => set("meetingName", e.target.value)} />
                  <Input value={v.className} onChange={(e) => set("className", e.target.value)} />
                </div>
              </Field>
            </div>
            <div className="flex flex-wrap gap-4">
              <Toggle checked={v.autoExport} onChange={(x) => set("autoExport", x)} label="轉錄完成後自動存入 Obsidian" />
              <Toggle checked={v.useSemanticSearch} onChange={(x) => set("useSemanticSearch", x)} label="歸檔時使用 obsidian-kb 語意搜尋" />
            </div>
          </>
        )}
      />
    </div>
  );
}

function UploadQueueSection() {
  return (
    <div className="space-y-6">
      <SectionForm
        section="upload"
        render={(v, set) => (
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="單檔上限（GB）">
              <Input type="number" value={v.maxFileBytes / 1024 ** 3} onChange={(e) => set("maxFileBytes", Math.round(num(e.target.value) * 1024 ** 3))} />
            </Field>
            <Field label="同一檔案並行 chunk 數">
              <Input type="number" value={v.concurrency} onChange={(e) => set("concurrency", num(e.target.value))} />
            </Field>
            <Field label="未完成上傳保留（小時）">
              <Input type="number" value={v.sessionTtlHours} onChange={(e) => set("sessionTtlHours", num(e.target.value))} />
            </Field>
            <Field label="小 / 中 / 大檔 chunk（MiB）" hint="每個請求固定 < 100 MB">
              <div className="flex gap-2">
                {["smallChunk", "mediumChunk", "largeChunk"].map((k) => (
                  <Input key={k} type="number" value={v[k] / 1024 ** 2} onChange={(e) => set(k, Math.round(num(e.target.value) * 1024 ** 2))} />
                ))}
              </div>
            </Field>
            <Field label="中 / 大檔門檻（MiB）">
              <div className="flex gap-2">
                <Input type="number" value={v.mediumThreshold / 1024 ** 2} onChange={(e) => set("mediumThreshold", Math.round(num(e.target.value) * 1024 ** 2))} />
                <Input type="number" value={v.largeThreshold / 1024 ** 2} onChange={(e) => set("largeThreshold", Math.round(num(e.target.value) * 1024 ** 2))} />
              </div>
            </Field>
          </div>
        )}
      />
      <hr className="border-line" />
      <SectionForm
        section="queue"
        render={(v, set) => (
          <>
            <p className="text-sm text-muted">每張 GPU 同時只執行一個重型階段；這裡調整的是 CPU 前處理與 LLM 的並行數，以及總進度的階段權重。</p>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="ffmpeg 前處理並行數">
                <Input type="number" value={v.cpuConcurrency} onChange={(e) => set("cpuConcurrency", num(e.target.value))} />
              </Field>
              <Field label="LLM 並行數">
                <Input type="number" value={v.llmConcurrency} onChange={(e) => set("llmConcurrency", num(e.target.value))} />
              </Field>
              <Field label="無進度逾時（秒）">
                <Input type="number" value={v.stallTimeoutSec} onChange={(e) => set("stallTimeoutSec", num(e.target.value))} />
              </Field>
            </div>
            <Field label="階段權重">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-6">
                {Object.entries(v.weights).map(([k, w]: any) => (
                  <label key={k} className="text-xs">
                    <span className="text-muted">{k}</span>
                    <Input type="number" value={w} onChange={(e) => set("weights", { ...v.weights, [k]: num(e.target.value) })} />
                  </label>
                ))}
              </div>
            </Field>
          </>
        )}
      />
    </div>
  );
}

function StorageSection() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["system", "status"], queryFn: () => get("/api/system/status") });
  const clean = useMutation({ mutationFn: (b: any) => post("/api/system/cleanup", b), onSuccess: () => qc.invalidateQueries({ queryKey: ["system"] }) });
  const st = status.data?.storage;
  return (
    <div className="space-y-5">
      {st && (
        <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          {[
            ["原始錄音", st.sourceAudioBytes],
            ["轉換後音訊", st.derivedAudioBytes],
            ["模型中間結果", st.intermediateBytes],
            ["上傳暫存", st.uploadChunkBytes],
            ["資料庫", st.databaseBytes],
            ["可用空間", st.freeBytes],
          ].map(([k, v]) => (
            <div key={k as string} className="rounded-md border border-line p-2">
              <dt className="text-xs text-muted">{k}</dt>
              <dd className="font-semibold tabular-nums">{bytes(v as number)}</dd>
            </div>
          ))}
          <div className="col-span-2 rounded-md border border-line p-2 text-xs text-muted">資料目錄：{st.dataDir}</div>
        </dl>
      )}
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => clean.mutate({ uploads: true })} loading={clean.isPending}>
          清理失敗 / 過期的上傳暫存
        </Button>
        <Button onClick={() => clean.mutate({ uploads: false, intermediates: true, olderThanDays: 0 })} loading={clean.isPending}>
          清理已完成錄音的中間結果
        </Button>
      </div>
      {clean.data && <pre className="rounded bg-panel-2 p-2 text-xs">{JSON.stringify(clean.data)}</pre>}
      <SectionForm
        section="storage"
        render={(v, set) => (
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="自動清理中間結果（天）" hint="逐字稿已存在 SQLite，中間檔只用於重跑">
              <Input type="number" value={v.cleanupIntermediatesDays} onChange={(e) => set("cleanupIntermediatesDays", num(e.target.value))} />
            </Field>
            <Field label="失敗上傳暫存保留（小時）">
              <Input type="number" value={v.cleanupFailedUploadsHours} onChange={(e) => set("cleanupFailedUploadsHours", num(e.target.value))} />
            </Field>
            <Field label="保留的最少磁碟空間（GB）">
              <Input type="number" value={v.minFreeBytes / 1024 ** 3} onChange={(e) => set("minFreeBytes", Math.round(num(e.target.value) * 1024 ** 3))} />
            </Field>
          </div>
        )}
      />
    </div>
  );
}

function LogsSection() {
  const [name, setName] = useState("server");
  const logs = useQuery({ queryKey: ["logs", name], queryFn: () => get(`/api/system/logs?name=${name}&lines=400`), refetchInterval: 5000 });
  return (
    <div className="space-y-3">
      <Select className="w-auto" value={name} onChange={(e) => setName(e.target.value)} options={["server", "worker-gpu-asr", "worker-gpu-diar", "worker-cpu"].map((x) => ({ value: x, label: x }))} />
      <pre className="max-h-[60vh] overflow-auto rounded-md bg-panel-2 p-3 text-[11px] leading-snug">{(logs.data?.lines ?? []).join("\n") || "（沒有紀錄）"}</pre>
      <p className="text-xs text-muted">日誌不記錄錄音內容、逐字稿或筆記文字。</p>
    </div>
  );
}

function DiagnosticsSection() {
  const status = useQuery({ queryKey: ["system", "status"], queryFn: () => get("/api/system/status"), refetchInterval: 5000 });
  const restart = useMutation({ mutationFn: () => post("/api/system/workers/restart") });
  const [pw, setPw] = useState({ current: "", next: "" });
  const change = useMutation({ mutationFn: () => post("/api/auth/password", pw) });
  return (
    <div className="space-y-5">
      <pre className="max-h-[50vh] overflow-auto rounded-md bg-panel-2 p-3 text-xs">{status.data ? JSON.stringify({ ...status.data, storage: undefined }, null, 2) : "…"}</pre>
      <Button onClick={() => restart.mutate()} loading={restart.isPending}>
        重新啟動 AI workers（卸載所有模型）
      </Button>
      <ErrorNote error={restart.error} />
      <Panel title="變更密碼">
        <div className="grid gap-3 sm:grid-cols-3">
          <Input type="password" placeholder="目前密碼" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
          <Input type="password" placeholder="新密碼（至少 10 字）" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
          <Button onClick={() => change.mutate()} loading={change.isPending}>
            變更
          </Button>
        </div>
        {change.isSuccess && <div className="mt-2 text-sm text-ok">已變更，其他登入工作階段已登出。</div>}
        <ErrorNote error={change.error} />
      </Panel>
      <p className="text-xs text-muted">現在時間 {dateTime(new Date().toISOString())}</p>
    </div>
  );
}

const TABS = [
  ["gpu", "GPU Device Mapping", GpuSection],
  ["models", "AI 模型", ModelsSection],
  ["llm", "Claude Code / Codex", LlmSection],
  ["obsidian", "Obsidian Vault", ObsidianSection],
  ["upload", "上傳與並行", UploadQueueSection],
  ["storage", "Storage", StorageSection],
  ["logs", "Logs", LogsSection],
  ["diag", "System Diagnostics", DiagnosticsSection],
] as const;

export function SettingsPage() {
  const [tab, setTab] = useState<string>("gpu");
  const T = TABS.find((t) => t[0] === tab)!;
  const C = T[2];
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">設定</h1>
      <div className="grid gap-5 lg:grid-cols-[220px_minmax(0,1fr)]">
        <nav className="flex gap-1 overflow-x-auto lg:flex-col">
          {TABS.map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)} className={cx("whitespace-nowrap rounded-md px-3 py-2 text-left text-sm", tab === k ? "bg-accent/10 font-medium text-accent" : "text-muted hover:bg-panel-2")}>
              {label}
            </button>
          ))}
        </nav>
        <Panel title={T[1]}>
          <C />
        </Panel>
      </div>
    </div>
  );
}
