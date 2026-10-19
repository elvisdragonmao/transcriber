import { useEffect, useState } from "react";
import type { QueryClient } from "@tanstack/react-query";
import type { Job } from "./api";

export type ConnState = "connecting" | "open" | "closed";

/**
 * Live updates over SSE. The browser's EventSource reconnects by itself and sends
 * Last-Event-ID; when the server can no longer replay the gap it emits `resync` and
 * we refetch everything from REST, so the UI always converges to the real state.
 */
export function useLiveEvents(qc: QueryClient, enabled: boolean): ConnState {
  const [state, setState] = useState<ConnState>("connecting");
  useEffect(() => {
    if (!enabled) return;
    let es: EventSource | null = null;
    let retry: number | undefined;
    const connect = () => {
      es = new EventSource("/api/events");
      es.onopen = () => setState("open");
      es.onerror = () => {
        setState(es?.readyState === EventSource.CLOSED ? "closed" : "connecting");
        if (es?.readyState === EventSource.CLOSED) retry = window.setTimeout(connect, 5000);
      };
      es.addEventListener("resync", () => qc.invalidateQueries());
      es.addEventListener("job", (e) => {
        const job: Job = JSON.parse((e as MessageEvent).data);
        qc.setQueryData(["job", job.id], (old: Job | undefined) => ({ ...old, ...job, events: old?.events }));
        qc.setQueriesData({ queryKey: ["jobs"] }, (old: any) => {
          if (!old?.items) return old;
          const i = old.items.findIndex((j: Job) => j.id === job.id);
          if (i < 0) return old;
          const items = old.items.slice();
          items[i] = job;
          return { ...old, items };
        });
        if (["completed", "failed", "cancelled", "paused"].includes(job.status) || !qc.getQueryData(["jobs", "list"])) {
          qc.invalidateQueries({ queryKey: ["jobs"] });
          qc.invalidateQueries({ queryKey: ["job", job.id] });
        }
        if (["completed", "failed"].includes(job.status)) qc.invalidateQueries({ queryKey: ["recording", job.recordingId] });
      });
      es.addEventListener("job.deleted", () => qc.invalidateQueries({ queryKey: ["jobs"] }));
      for (const t of ["recording.updated", "recording.deleted", "transcript.updated"]) {
        es.addEventListener(t, (e) => {
          const d = JSON.parse((e as MessageEvent).data);
          const id = d.id ?? d.recordingId;
          qc.invalidateQueries({ queryKey: ["recordings"] });
          if (id) {
            qc.invalidateQueries({ queryKey: ["recording", id] });
            qc.invalidateQueries({ queryKey: ["transcript", id] });
            qc.invalidateQueries({ queryKey: ["notes", id] });
            qc.invalidateQueries({ queryKey: ["exports", id] });
          }
        });
      }
      es.addEventListener("speakers.updated", () => qc.invalidateQueries({ queryKey: ["speakers"] }));
    };
    connect();
    return () => {
      window.clearTimeout(retry);
      es?.close();
    };
  }, [qc, enabled]);
  return state;
}
