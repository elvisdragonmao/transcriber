import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ListChecks } from "lucide-react";
import { get, type Job } from "../lib/api";
import { JobCard } from "../components/JobCard";
import { Empty, Spinner, cx } from "../components/ui";

const FILTERS = [
  { key: "active", label: "進行中", status: "queued,running,pausing,paused,cancelling" },
  { key: "failed", label: "失敗", status: "failed" },
  { key: "completed", label: "完成", status: "completed" },
  { key: "cancelled", label: "已取消", status: "cancelled" },
  { key: "all", label: "全部", status: "" },
];

export function JobsPage() {
  const [filter, setFilter] = useState("active");
  const f = FILTERS.find((x) => x.key === filter)!;
  const q = useQuery({
    queryKey: ["jobs", "list", filter],
    queryFn: () => get<{ items: Job[] }>(`/api/jobs?limit=200${f.status ? `&status=${f.status}` : ""}`),
    refetchInterval: 15000,
  });
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">任務</h1>
      <div className="flex flex-wrap gap-1 rounded-lg border border-line bg-panel p-1 text-sm sm:w-fit">
        {FILTERS.map((x) => (
          <button key={x.key} onClick={() => setFilter(x.key)} className={cx("rounded-md px-3 py-1.5", filter === x.key ? "bg-accent text-accent-fg" : "text-muted hover:bg-panel-2")}>
            {x.label}
          </button>
        ))}
      </div>
      {q.isLoading && <Spinner />}
      {q.data?.items.length === 0 && <Empty icon={<ListChecks className="size-8" />} title="沒有符合的任務" />}
      <div className="space-y-3">
        {q.data?.items.map((j) => (
          <JobCard key={j.id} job={j} compact={!["running", "pausing", "failed"].includes(j.status)} />
        ))}
      </div>
    </div>
  );
}
