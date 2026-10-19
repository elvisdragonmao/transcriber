import { useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Library, Search } from "lucide-react";
import { get, type Recording } from "../lib/api";
import { dateTime, duration, LANG_LABEL, STATUS_LABEL } from "../lib/format";
import { Badge, Empty, Input, Spinner, statusTone } from "../components/ui";

export function RecordingsPage() {
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const list = useQuery({ queryKey: ["recordings", "list", q], queryFn: () => get<{ items: Recording[]; total: number }>(`/api/recordings?limit=200${q ? `&search=${encodeURIComponent(q)}` : ""}`) });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">錄音</h1>
        <form
          className="relative w-full sm:w-80"
          onSubmit={(e) => {
            e.preventDefault();
            setQ(search.trim());
          }}
        >
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted" />
          <Input className="pl-8" placeholder="搜尋標題或逐字稿內容…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </form>
      </div>
      {list.isLoading && <Spinner />}
      {list.data?.items.length === 0 && <Empty icon={<Library className="size-8" />} title={q ? "找不到符合的錄音" : "還沒有錄音"} />}
      <div className="overflow-hidden rounded-lg border border-line bg-panel">
        <table className="w-full text-sm">
          <thead className="hidden bg-panel-2 text-left text-xs text-muted sm:table-header-group">
            <tr>
              <th className="px-4 py-2 font-medium">標題</th>
              <th className="px-3 py-2 font-medium">專案</th>
              <th className="px-3 py-2 font-medium">長度</th>
              <th className="px-3 py-2 font-medium">日期</th>
              <th className="px-3 py-2 font-medium">狀態</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {list.data?.items.map((r) => {
              const active = r.activeJobs[0];
              return (
                <tr key={r.id} className="block hover:bg-panel-2 sm:table-row">
                  <td className="block px-4 pt-2.5 sm:table-cell sm:py-2.5">
                    <Link to={`/recordings/${r.id}`} className="font-medium hover:underline">
                      {r.title}
                    </Link>
                    <div className="text-xs text-muted">
                      {r.originalFilename} · {LANG_LABEL[r.languageHint]}
                      {!r.hasAudio && " · 原始錄音已刪除"}
                    </div>
                  </td>
                  <td className="inline-block px-4 text-xs text-muted sm:table-cell sm:px-3">{r.project?.name ?? "–"}</td>
                  <td className="inline-block px-2 text-xs tabular-nums sm:table-cell sm:px-3 sm:text-sm">{duration(r.durationMs)}</td>
                  <td className="inline-block px-2 text-xs text-muted sm:table-cell sm:px-3">{dateTime(r.recordedAt ?? r.createdAt)}</td>
                  <td className="block px-4 pb-2.5 sm:table-cell sm:px-3 sm:py-2.5">
                    {active ? (
                      <Badge tone={statusTone(active.status)}>
                        {STATUS_LABEL[active.status]} {Math.floor(active.progress * 100)}%
                      </Badge>
                    ) : r.transcript?.status === "complete" ? (
                      <Badge tone="ok">逐字稿{r.noteCount ? ` + ${r.noteCount} 筆記` : ""}</Badge>
                    ) : r.lastJob ? (
                      <Badge tone={statusTone(r.lastJob.status)}>{STATUS_LABEL[r.lastJob.status]}</Badge>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
