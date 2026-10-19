import { json } from "../lib/util.js";
import type { JobOptions } from "../queue/jobs.js";
import type { StageHandler } from "./types.js";

export const exportStage: StageHandler = async (ctx) => {
  const { app, job } = ctx;
  if (!app.obsidian.backend()) return { kind: "skipped", message: "Obsidian vault not configured; export skipped" };
  const opts = json<JobOptions>(job.options, {});
  const kinds = opts.exportKinds ?? ["transcript", "note"];
  const done: Record<string, unknown> = {};
  const total = kinds.length + 1;
  let step = 0;
  ctx.progress(step, total, "files");

  // the note first, so the transcript can link back to it
  if (kinds.includes("note")) {
    const noteId =
      opts.noteId ??
      (app.db.prepare(
        "SELECT n.id FROM generated_notes n JOIN note_generations g ON g.id = n.generation_id WHERE g.job_id = ? ORDER BY n.created_at DESC LIMIT 1",
      ).get(job.id) as any)?.id;
    if (noteId) {
      const r = await app.obsidian.exportNote(noteId, { overwrite: opts.overwrite });
      done.note = r;
      ctx.log(r.status === "written" ? "info" : "warn", r.status === "written" ? `Note saved to ${r.path}${r.versioned ? " (new version; an edited file with this name already existed)" : ""}` : `Classification uncertain: note placed in ${r.path}; suggested ${r.suggestedPath ?? "no folder"}`);
    }
    ctx.progress(++step, total, "files");
  }
  const hasTranscript = app.db.prepare("SELECT 1 FROM transcripts WHERE recording_id = ? AND status = 'complete'").get(job.recording_id);
  if (hasTranscript && (kinds.includes("transcript") || done.note)) {
    try {
      const r = await app.obsidian.exportTranscript(job.recording_id, { overwrite: opts.overwrite });
      done.transcript = r;
      ctx.log("info", `Transcript saved to ${r.path}${r.versioned ? " (new version; the existing file had been edited)" : ""}`);
    } catch (e: any) {
      if (!kinds.includes("transcript")) ctx.log("warn", `Could not update transcript links: ${e.message}`);
      else throw e;
    }
  }
  ctx.progress(total, total, "files");
  app.events.publish("recording.updated", { id: job.recording_id });
  return { kind: "completed", detail: done };
};
