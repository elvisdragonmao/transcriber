import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface GpuInfo {
  index: number;
  uuid: string;
  name: string;
  memoryTotalMiB: number;
  memoryUsedMiB: number;
  utilization: number | null;
  temperature: number | null;
  computeCap: string;
  driver: string;
  processes: { pid: number; name: string; usedMiB: number }[];
}

let cache: { at: number; data: GpuInfo[]; error: string | null } = { at: 0, data: [], error: null };

export async function queryGpus(maxAgeMs = 3000): Promise<{ gpus: GpuInfo[]; error: string | null }> {
  if (Date.now() - cache.at < maxAgeMs) return { gpus: cache.data, error: cache.error };
  try {
    const { stdout } = await run(
      "nvidia-smi",
      [
        "--query-gpu=index,uuid,name,memory.total,memory.used,utilization.gpu,temperature.gpu,compute_cap,driver_version",
        "--format=csv,noheader,nounits",
      ],
      { timeout: 5000 },
    );
    const gpus: GpuInfo[] = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [index, uuid, name, total, used, util, temp, cc, driver] = l.split(",").map((s) => s.trim());
        const num = (s: string) => (s === "[N/A]" || s === "" ? null : Number(s));
        return {
          index: Number(index),
          uuid,
          name,
          memoryTotalMiB: Number(total),
          memoryUsedMiB: Number(used),
          utilization: num(util),
          temperature: num(temp),
          computeCap: cc,
          driver,
          processes: [],
        };
      });
    try {
      const { stdout: p } = await run(
        "nvidia-smi",
        ["--query-compute-apps=gpu_uuid,pid,process_name,used_memory", "--format=csv,noheader,nounits"],
        { timeout: 5000 },
      );
      for (const line of p.trim().split("\n").filter(Boolean)) {
        const [uuid, pid, name, mem] = line.split(",").map((s) => s.trim());
        gpus.find((g) => g.uuid === uuid)?.processes.push({ pid: Number(pid), name: name.split("/").pop() ?? name, usedMiB: Number(mem) || 0 });
      }
    } catch {
      /* process listing is optional */
    }
    cache = { at: Date.now(), data: gpus, error: null };
  } catch (e: any) {
    cache = { at: Date.now(), data: [], error: e.code === "ENOENT" ? "nvidia-smi not found" : String(e.message ?? e) };
  }
  return { gpus: cache.data, error: cache.error };
}

/** Pick sensible default device mapping by GPU name, falling back to the largest/smallest card. */
export function defaultMapping(gpus: GpuInfo[]): { asrDevice: string; diarDevice: string } {
  if (!gpus.length) return { asrDevice: "", diarDevice: "cpu" };
  const by = (re: RegExp) => gpus.find((g) => re.test(g.name));
  const sorted = [...gpus].sort((a, b) => b.memoryTotalMiB - a.memoryTotalMiB);
  const asr = by(/5060/) ?? sorted[0];
  const diar = by(/3050/) ?? sorted.find((g) => g.uuid !== asr.uuid) ?? asr;
  return { asrDevice: asr.uuid, diarDevice: diar.uuid };
}
