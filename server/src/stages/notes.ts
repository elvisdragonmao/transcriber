import { FatalStageError } from "../lib/errors.js";
import { json, msToClock, nowIso, uuid } from "../lib/util.js";
import { buildExportDoc } from "../transcript/store.js";
import { paragraphs } from "../transcript/exporters.js";
import { renderNote, schemas, systemPrompt, userPrompt, type Template } from "../llm/prompts.js";
import { stemOf } from "../obsidian/paths.js";
import type { Classification } from "../obsidian/service.js";
import type { StageHandler } from "./types.js";
import type { JobOptions } from "../queue/jobs.js";
import { CliError } from "../llm/cli.js";

const VALID_TYPES = ["meeting", "class", "project_discussion", "interview", "general"];

export const notes: StageHandler = async (ctx) => {
  const { app, job } = ctx;
  const opts = json<JobOptions>(job.options, {});
  const template = (opts.noteTemplate ?? "none") as Template | "none";
  if (template === "none") return { kind: "skipped", message: "No note requested" };
  const rec = app.db.prepare("SELECT * FROM recordings WHERE id = ?").get(job.recording_id) as any;
  const doc = buildExportDoc(app.db, rec.id);
  if (!doc.segments.length) throw new FatalStageError("EMPTY_TRANSCRIPT", "Transcript is empty; nothing to summarise");
  const s = app.settings.get();
  const { provider, model, effort } = app.llm.resolve({ provider: opts.provider, model: opts.model, effort: opts.effort });
  const language = opts.noteLanguage ?? s.llm.language;

  ctx.progress(0, null, "steps", { step: "vault-scan" });
  const lines = paragraphs(doc.segments).map((p) => `[${msToClock(p.start)}] ${p.speaker}${p.status === "overlap" ? " (overlapping)" : p.status === "uncertain" ? " (speaker uncertain)" : ""}: ${p.text}`);
  let transcriptChars = lines.reduce((a, l) => a + l.length, 0);
  if (transcriptChars > s.llm.maxTranscriptChars) {
    // keep a contiguous prefix; flag the truncation inside the prompt and the note
    let n = 0;
    const kept: string[] = [];
    for (const l of lines) {
      if (n + l.length > s.llm.maxTranscriptChars) break;
      kept.push(l);
      n += l.length;
    }
    kept.push(`[...] (transcript truncated after ${kept.length} of ${lines.length} paragraphs because of the configured size limit)`);
    lines.splice(0, lines.length, ...kept);
    transcriptChars = n;
    ctx.log("warn", "Transcript exceeded the LLM size limit and was truncated");
  }
  const vault = await app.obsidian.scanContext(lines.slice(0, 40).join("\n").slice(0, 1500)).catch((e) => {
    ctx.log("warn", `Vault scan failed, continuing without filing context: ${e.message}`);
    return { candidates: [], knownProjects: [], related: [] };
  });

  ctx.progress(0, null, "steps", { step: "llm", provider, model, effort, chars: transcriptChars });
  const genId = uuid();
  app.db
    .prepare("INSERT INTO note_generations (id, recording_id, job_id, template, provider, model, effort, language, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)")
    .run(genId, rec.id, job.id, template, provider, model, effort, language, nowIso());
  let result;
  try {
    result = await app.llm.generate(
      provider,
      {
        system: systemPrompt(template, language),
        prompt: userPrompt({
          title: rec.title,
          date: doc.date,
          durationLabel: doc.durationMs ? msToClock(doc.durationMs) : null,
          speakers: doc.speakers,
          transcriptLines: lines,
          candidates: vault.candidates,
          related: vault.related,
          knownProjects: vault.knownProjects,
        }),
        schema: schemas[template],
        model,
        effort,
        signal: ctx.signal,
      },
      `notes:${template}`,
    );
  } catch (e: any) {
    app.db.prepare("UPDATE note_generations SET status = ?, error = ?, finished_at = ? WHERE id = ?").run(ctx.signal.reason ? "cancelled" : "failed", String(e.message).slice(0, 1000), nowIso(), genId);
    if (e instanceof CliError && !e.retryable) throw new FatalStageError(e.code, e.message);
    throw e;
  }

  const out = result.output;
  const c: Classification = out.classification ?? {};
  // Treat model output as untrusted: coerce and bound every field the backend relies on.
  c.document_type = VALID_TYPES.includes(c.document_type) ? c.document_type : template === "class" ? "class" : "meeting";
  c.classification_confidence = Math.max(0, Math.min(1, Number(c.classification_confidence) || 0));
  c.suggested_folder = typeof c.suggested_folder === "string" && vault.candidates.some((x) => x.folder === c.suggested_folder) ? c.suggested_folder : null;
  c.new_folder_name = typeof c.new_folder_name === "string" ? c.new_folder_name.slice(0, 80) : null;
  c.suggested_title = String(c.suggested_title ?? out.title ?? "").slice(0, 80);
  c.evidence = Array.isArray(c.evidence) ? c.evidence.slice(0, 10).map((x) => String(x).slice(0, 300)) : [];

  // Adopt the AI title only when the user never set one (filename-derived title).
  if (rec.title_source === "filename" && c.suggested_title.trim()) {
    app.db.prepare("UPDATE recordings SET title = ?, title_source = 'ai', updated_at = ? WHERE id = ?").run(c.suggested_title.trim(), nowIso(), rec.id);
  }
  app.db.prepare("UPDATE recordings SET document_type = ?, updated_at = ? WHERE id = ?").run(c.document_type, nowIso(), rec.id);

  const transcriptStem = stemOf(app.obsidian.currentExport(rec.id, "transcript")?.vault_path ?? app.obsidian.transcriptPath(rec.id));
  const project = c.suggested_folder ? c.suggested_folder.split("/").pop()! : c.detected_project;
  const rendered = renderNote(template, out, { transcriptStem, date: doc.date, recordingId: rec.id, project, provider, model: result.resolvedModel ?? model, created: nowIso() });
  const noteId = uuid();
  app.db.transaction(() => {
    app.db
      .prepare("INSERT INTO generated_notes (id, generation_id, recording_id, template, title, markdown, structured, classification, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(noteId, genId, rec.id, template, rendered.title, rendered.markdown, JSON.stringify(out), JSON.stringify({ classification: c, candidates: vault.candidates.map((x) => x.folder) }), nowIso(), nowIso());
    app.db.prepare("UPDATE note_generations SET status = 'completed', cost_usd = ?, duration_ms = ?, finished_at = ? WHERE id = ?").run(result.costUsd, result.durationMs, nowIso(), genId);
  })();
  app.events.publish("recording.updated", { id: rec.id });
  ctx.progress(1, 1, "steps");
  return {
    kind: "completed",
    modelVersion: `${provider}:${result.resolvedModel ?? model} (effort ${effort})`,
    detail: { noteId, provider, model: result.resolvedModel ?? model, costUsd: result.costUsd, documentType: c.document_type, confidence: c.classification_confidence, suggestedFolder: c.suggested_folder },
    message: `Generated ${template} notes with ${provider}/${result.resolvedModel ?? model}${result.costUsd != null ? ` ($${result.costUsd.toFixed(3)})` : ""}`,
  };
};
