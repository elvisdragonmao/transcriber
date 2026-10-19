export function clock(ms: number | null | undefined, withHours = true): string {
  if (ms == null || !Number.isFinite(ms)) return "–";
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h || withHours ? `${String(h).padStart(2, "0")}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function duration(ms: number | null | undefined): string {
  if (!ms) return "–";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${s % 60} 秒`;
  return `${Math.floor(m / 60)} 小時 ${m % 60} 分`;
}

export function eta(sec: number | null | undefined): string | null {
  if (sec == null) return null;
  if (sec < 60) return `約 ${Math.max(1, Math.round(sec))} 秒`;
  if (sec < 3600) return `約 ${Math.round(sec / 60)} 分鐘`;
  return `約 ${(sec / 3600).toFixed(1)} 小時`;
}

export function bytes(n: number | null | undefined): string {
  if (n == null) return "–";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return "–";
  const d = new Date(iso);
  return d.toLocaleString("zh-TW", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}

export function relative(iso: string | null | undefined): string {
  if (!iso) return "–";
  const diff = (Date.now() - Date.parse(iso)) / 1000;
  if (diff < 60) return "剛剛";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分鐘前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小時前`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} 天前`;
  return dateTime(iso);
}

export function pct(p: number | null | undefined): string {
  return p == null ? "–" : `${Math.floor(p * 100)}%`;
}

export const STATUS_LABEL: Record<string, string> = {
  queued: "排隊中",
  running: "處理中",
  pausing: "暫停中…",
  paused: "已暫停",
  cancelling: "取消中…",
  cancelled: "已取消",
  completed: "完成",
  failed: "失敗",
  pending: "等待",
  skipped: "略過",
};

export const LANG_LABEL: Record<string, string> = { auto: "自動偵測", zh: "中文", en: "English" };
export const TEMPLATE_LABEL: Record<string, string> = { none: "只要逐字稿", meeting: "逐字稿 + 會議紀錄", class: "逐字稿 + 上課筆記" };

/** 10 speaker colours that read in both themes. */
export const SPEAKER_COLORS = [
  "#4f46e5",
  "#0891b2",
  "#c2410c",
  "#15803d",
  "#be185d",
  "#7c3aed",
  "#a16207",
  "#0f766e",
  "#b91c1c",
  "#475569",
];

export function unitLabel(unit: string | null, done: number | null, total: number | null): string | null {
  if (done == null) return null;
  const n = (v: number) => (v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(v < 10 ? 1 : 0));
  switch (unit) {
    case "bytes":
      return total ? `${bytes(done)} / ${bytes(total)}` : bytes(done);
    case "s":
      return total ? `${clock(done * 1000)} / ${clock(total * 1000)}` : clock(done * 1000);
    case "ms":
      return total ? `${Math.round((done / total) * 100)}%` : null;
    case "segments":
      return total ? `${n(done)} / ${n(total)} 區段` : `${n(done)} 區段`;
    case "spans":
      return total ? `${n(done)} / ${n(total)} 聲紋片段` : null;
    case "files":
      return total ? `${n(done)} / ${n(total)} 檔案` : null;
    default:
      return total ? `${n(done)} / ${n(total)}` : null;
  }
}
