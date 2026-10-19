import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { get } from "../lib/api";

interface Peaks {
  samplesPerPeak: number;
  sampleRate: number;
  peaks: number[];
}

/** Canvas waveform with click-to-seek and a live playhead; segment speaker colours along the bottom. */
export function Waveform({
  recordingId,
  durationMs,
  currentMs,
  onSeek,
  bands,
}: {
  recordingId: string;
  durationMs: number;
  currentMs: number;
  onSeek: (ms: number) => void;
  bands: { start: number; end: number; color: string }[];
}) {
  const { data } = useQuery({ queryKey: ["peaks", recordingId], queryFn: () => get<Peaks>(`/api/recordings/${recordingId}/peaks`), staleTime: Infinity, retry: false });
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const h = 72;
    c.width = width * dpr;
    c.height = h * dpr;
    const ctx = c.getContext("2d")!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, h);
    const styles = getComputedStyle(document.documentElement);
    const muted = styles.getPropertyValue("--muted").trim() || "#888";
    const accent = styles.getPropertyValue("--accent").trim() || "#4f46e5";
    const mid = (h - 8) / 2;
    const played = durationMs ? (currentMs / durationMs) * width : 0;
    if (data?.peaks?.length) {
      const n = data.peaks.length / 2;
      for (let x = 0; x < width; x++) {
        const a = Math.floor((x / width) * n);
        const b = Math.max(a + 1, Math.floor(((x + 1) / width) * n));
        let mn = 0;
        let mx = 0;
        for (let i = a; i < b && i < n; i++) {
          mn = Math.min(mn, data.peaks[2 * i]);
          mx = Math.max(mx, data.peaks[2 * i + 1]);
        }
        const top = mid - (mx / 128) * mid;
        const bot = mid - (mn / 128) * mid;
        ctx.fillStyle = x < played ? accent : muted;
        ctx.globalAlpha = x < played ? 0.9 : 0.45;
        ctx.fillRect(x, top, 1, Math.max(1, bot - top));
      }
      ctx.globalAlpha = 1;
    }
    for (const b of bands) {
      const x0 = (b.start / durationMs) * width;
      const x1 = Math.max(x0 + 1, (b.end / durationMs) * width);
      ctx.fillStyle = b.color;
      ctx.fillRect(x0, h - 5, x1 - x0, 5);
    }
    ctx.fillStyle = accent;
    ctx.fillRect(played, 0, 2, h);
  }, [data, width, currentMs, durationMs, bands]);

  const toMs = (clientX: number) => {
    const r = wrap.current!.getBoundingClientRect();
    return Math.max(0, Math.min(durationMs, ((clientX - r.left) / r.width) * durationMs));
  };
  return (
    <div
      ref={wrap}
      className="relative h-[72px] w-full cursor-pointer select-none"
      onClick={(e) => onSeek(toMs(e.clientX))}
      onMouseMove={(e) => setHover(toMs(e.clientX))}
      onMouseLeave={() => setHover(null)}
    >
      <canvas ref={canvas} style={{ width: "100%", height: 72 }} />
      {hover != null && (
        <div className="pointer-events-none absolute -top-6 rounded bg-fg px-1.5 py-0.5 text-[11px] text-bg" style={{ left: `calc(${(hover / durationMs) * 100}% - 20px)` }}>
          {new Date(hover).toISOString().slice(11, 19)}
        </div>
      )}
    </div>
  );
}
