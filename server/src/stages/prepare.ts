import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { CancelledError, FatalStageError } from "../lib/errors.js";
import { freeBytes, writeFileAtomic, nowIso } from "../lib/util.js";
import { workDir } from "../queue/jobs.js";
import type { StageHandler } from "./types.js";
import type { StageSignal } from "../workers/pool.js";

export interface ProbeResult {
  durationMs: number;
  codec: string | null;
  sampleRate: number | null;
  channels: number | null;
  container: string | null;
  creationTime: string | null;
}

export async function ffprobe(bin: string, file: string): Promise<ProbeResult> {
  const out = await new Promise<string>((resolve, reject) => {
    const p = spawn(bin, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", "-select_streams", "a", file]);
    let buf = "";
    let err = "";
    p.stdout.on("data", (d) => (buf += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(buf) : reject(new FatalStageError("BAD_INPUT", `ffprobe could not read the file: ${err.slice(0, 300)}`))));
  });
  const j = JSON.parse(out);
  const a = (j.streams ?? [])[0];
  if (!a) throw new FatalStageError("BAD_INPUT", "The file contains no audio stream");
  const duration = Number(j.format?.duration ?? a.duration ?? 0);
  if (!(duration > 0.3)) throw new FatalStageError("BAD_INPUT", "Audio is empty or too short");
  const ct = j.format?.tags?.creation_time ?? a.tags?.creation_time ?? null;
  return {
    durationMs: Math.round(duration * 1000),
    codec: a.codec_name ?? null,
    sampleRate: a.sample_rate ? Number(a.sample_rate) : null,
    channels: a.channels ?? null,
    container: j.format?.format_name ?? null,
    creationTime: ct && !Number.isNaN(Date.parse(ct)) && !ct.startsWith("1970") ? new Date(ct).toISOString() : null,
  };
}

/** Run ffmpeg with an argument array (never a shell string), reporting progress by out_time. */
export function runFfmpeg(bin: string, args: string[], durationMs: number, signal: StageSignal, onProgress: (ms: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, ["-hide_banner", "-nostdin", "-nostats", "-progress", "pipe:1", ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => {
      err = (err + d).slice(-4000);
    });
    readline.createInterface({ input: p.stdout }).on("line", (line) => {
      const m = line.match(/^out_time_us=(\d+)/);
      if (m) onProgress(Math.min(durationMs, Number(m[1]) / 1000));
    });
    const onSig = () => p.kill("SIGTERM");
    signal.on(onSig);
    p.on("error", reject);
    p.on("close", (code) => {
      if (signal.reason) return reject(signal.reason === "cancel" ? new CancelledError() : Object.assign(new Error("paused"), { paused: true }));
      if (code === 0) resolve();
      else if (/No space left/i.test(err)) reject(Object.assign(new Error("Disk full while converting audio"), { code: "ENOSPC" }));
      else reject(new FatalStageError("BAD_INPUT", `ffmpeg failed (${code}): ${err.split("\n").filter(Boolean).slice(-3).join(" | ")}`));
    });
  });
}

/** Min/max peaks (int8 pairs) for the waveform, computed by streaming the 16 kHz PCM file. */
export async function computePeaks(wav: string, out: string, durationMs: number) {
  const buckets = Math.min(20000, Math.max(400, Math.round(durationMs / 50)));
  const totalSamples = Math.round((durationMs / 1000) * 16000);
  const per = Math.max(1, Math.ceil(totalSamples / buckets));
  const peaks: number[] = [];
  let mn = 0;
  let mx = 0;
  let n = 0;
  let headerSkipped = false;
  let carry: Buffer | null = null;
  for await (const chunk0 of fs.createReadStream(wav, { highWaterMark: 1 << 20 })) {
    let chunk = chunk0 as Buffer;
    if (!headerSkipped) {
      const dataIdx = chunk.indexOf("data");
      chunk = chunk.subarray(dataIdx >= 0 ? dataIdx + 8 : 44);
      headerSkipped = true;
    }
    if (carry) {
      chunk = Buffer.concat([carry, chunk]);
      carry = null;
    }
    if (chunk.length % 2) {
      carry = chunk.subarray(chunk.length - 1);
      chunk = chunk.subarray(0, chunk.length - 1);
    }
    for (let i = 0; i < chunk.length; i += 2) {
      const v = chunk.readInt16LE(i);
      if (v < mn) mn = v;
      if (v > mx) mx = v;
      if (++n === per) {
        peaks.push(Math.round(mn / 256), Math.round(mx / 256));
        mn = mx = n = 0;
      }
    }
  }
  if (n) peaks.push(Math.round(mn / 256), Math.round(mx / 256));
  await writeFileAtomic(out, JSON.stringify({ version: 1, samplesPerPeak: per, sampleRate: 16000, peaks }));
}

export function audioPaths(recordingsDir: string, recordingId: string) {
  const dir = workDir(recordingsDir, recordingId);
  return { raw: path.join(path.dirname(dir), "audio16k.wav"), norm: path.join(dir, "asr16k.wav") };
}

/** The file VAD / ASR / alignment read: the normalised copy when it exists. */
export function asrAudioPath(recordingsDir: string, recordingId: string) {
  const p = audioPaths(recordingsDir, recordingId);
  return fs.existsSync(p.norm) ? p.norm : p.raw;
}

export const prepare: StageHandler = async ({ app, job, signal, progress, log }) => {
  const rec = app.db.prepare("SELECT * FROM recordings WHERE id = ?").get(job.recording_id) as any;
  if (!rec.source_path || !fs.existsSync(rec.source_path)) throw new FatalStageError("BAD_INPUT", "Original audio file is missing");
  const dir = workDir(app.paths.recordings, rec.id);
  await fsp.mkdir(dir, { recursive: true });
  progress(0, null, "ms", { step: "probe" });
  const probe = await ffprobe(app.config.ffprobe, rec.source_path);

  const needed = (probe.durationMs / 1000) * 16000 * 2 * 2 + app.settings.get().storage.minFreeBytes;
  const free = await freeBytes(dir);
  if (free < needed) throw new FatalStageError("NO_SPACE", `Not enough disk space to prepare audio (need ${(needed / 1e9).toFixed(1)} GB, free ${(free / 1e9).toFixed(1)} GB)`);

  const { raw, norm } = audioPaths(app.paths.recordings, rec.id);
  await fsp.rm(norm, { force: true });
  const total = probe.durationMs * 2; // two passes
  try {
    await runFfmpeg(
      app.config.ffmpeg,
      ["-y", "-i", rec.source_path, "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "wav", `${raw}.part`],
      probe.durationMs,
      signal,
      (ms) => progress(ms, total, "ms", { step: "decode" }),
    );
    await fsp.rename(`${raw}.part`, raw);
    if (app.settings.get().asr.normalize) {
      // Loudness-normalised copy for VAD + ASR only: quiet, far-field speakers are otherwise missed.
      await runFfmpeg(
        app.config.ffmpeg,
        ["-y", "-i", raw, "-af", "speechnorm=e=12.5:r=0.0001:l=1", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "wav", `${norm}.part`],
        probe.durationMs,
        signal,
        (ms) => progress(probe.durationMs + ms, total, "ms", { step: "normalize" }),
      );
      await fsp.rename(`${norm}.part`, norm);
    }
  } catch (e: any) {
    await fsp.rm(`${raw}.part`, { force: true });
    await fsp.rm(`${norm}.part`, { force: true });
    if (e?.paused) return { kind: "paused" };
    throw e;
  }
  const peaksPath = path.join(path.dirname(dir), "peaks.json");
  await computePeaks(raw, peaksPath, probe.durationMs);
  app.db
    .prepare(
      `UPDATE recordings SET duration_ms = ?, codec = ?, sample_rate = ?, channels = ?, container = ?, audio_path = ?, peaks_path = ?,
         recorded_at = COALESCE(recorded_at, ?), updated_at = ? WHERE id = ?`,
    )
    .run(probe.durationMs, probe.codec, probe.sampleRate, probe.channels, probe.container, raw, peaksPath, probe.creationTime, nowIso(), rec.id);
  app.events.publish("recording.updated", { id: rec.id });
  log("info", `Audio ${Math.round(probe.durationMs / 1000)} s, ${probe.codec}, ${probe.sampleRate} Hz, ${probe.channels} ch`);
  progress(total, total, "ms");
  return { kind: "completed", outputPath: raw, detail: { durationMs: probe.durationMs, codec: probe.codec } };
};
