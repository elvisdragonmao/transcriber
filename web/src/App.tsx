import { useEffect, useRef, useState, type ReactNode } from "react";
import { Navigate, NavLink, Route, Routes, useLocation, useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AudioLines, House, LogOut, Menu, Moon, Settings as SettingsIcon, Sun, UploadCloud, Users, Library } from "lucide-react";
import { get, post } from "./lib/api";
import { useLiveEvents } from "./lib/sse";
import { cx } from "./components/ui";
import { Login } from "./pages/Login";
import { HomePage } from "./pages/Home";
import { uploads } from "./lib/upload";
import { resolveUploadOptions } from "./lib/uploadOptions";
import { RecordingsPage } from "./pages/Recordings";
import { RecordingDetail } from "./pages/RecordingDetail";
import { SpeakersPage } from "./pages/Speakers";
import { SettingsPage } from "./pages/Settings";

const NAV = [
  { to: "/", label: "首頁", icon: House, end: true },
  { to: "/recordings", label: "錄音", icon: Library },
  { to: "/speakers", label: "講者", icon: Users },
  { to: "/settings", label: "設定", icon: SettingsIcon },
];

function ThemeToggle() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  return (
    <button
      className="rounded-md p-2 text-muted hover:bg-panel-2 hover:text-fg"
      aria-label="切換深色模式"
      onClick={() => {
        const next = !dark;
        setDark(next);
        document.documentElement.classList.toggle("dark", next);
        try {
          localStorage.setItem("theme", next ? "dark" : "light");
        } catch {
          /* ignore */
        }
      }}
    >
      {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </button>
  );
}

/** Drop audio files anywhere in the window: they upload with the options set on the home page. */
function useWindowDrop() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [count, setCount] = useState<number | null>(null);
  const depth = useRef(0);
  useEffect(() => {
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current++;
      setCount(e.dataTransfer!.items?.length ?? 0);
    };
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = "copy";
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setCount(null);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setCount(null);
      const files = [...(e.dataTransfer?.files ?? [])];
      if (!files.length) return;
      const settings = (qc.getQueryData(["settings"]) as any)?.settings;
      uploads.add(files, resolveUploadOptions(settings));
      navigate("/");
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [qc, navigate]);
  return count;
}

function Shell({ children, user }: { children: ReactNode; user: string }) {
  const qc = useQueryClient();
  const dragging = useWindowDrop();
  const conn = useLiveEvents(qc, true);
  const [menu, setMenu] = useState(false);
  const loc = useLocation();
  useEffect(() => setMenu(false), [loc.pathname]);
  const { data: active } = useQuery({ queryKey: ["jobs", "active-count"], queryFn: () => get("/api/jobs?status=queued,running,pausing,cancelling&limit=100"), refetchInterval: 15000 });
  const activeCount = active?.items?.length ?? 0;
  const nav = (
    <nav className="flex flex-col gap-0.5">
      {NAV.map((n) => (
        <NavLink
          key={n.to}
          to={n.to}
          end={n.end}
          className={({ isActive }) => cx("flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm", isActive ? "bg-accent/10 font-medium text-accent" : "text-muted hover:bg-panel-2 hover:text-fg")}
        >
          <n.icon className="size-4" />
          <span className="flex-1">{n.label}</span>
          {n.to === "/" && activeCount > 0 && <span className="rounded-full bg-accent px-1.5 text-[11px] font-semibold text-accent-fg">{activeCount}</span>}
        </NavLink>
      ))}
    </nav>
  );
  const footer = (
    <div className="mt-auto flex items-center justify-between gap-2 border-t border-line pt-3 text-xs text-muted">
      <span className="flex items-center gap-1.5" title={conn === "open" ? "即時更新已連線" : "即時更新重新連線中"}>
        <span className={cx("size-2 rounded-full", conn === "open" ? "bg-ok" : "bg-warn")} />
        {user}
      </span>
      <div className="flex items-center">
        <ThemeToggle />
        <button
          className="rounded-md p-2 hover:bg-panel-2 hover:text-fg"
          aria-label="登出"
          onClick={async () => {
            await post("/api/auth/logout");
            qc.clear();
            window.location.href = "/";
          }}
        >
          <LogOut className="size-4" />
        </button>
      </div>
    </div>
  );
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[220px_minmax(0,1fr)]">
      <aside className="sticky top-0 hidden h-dvh flex-col gap-4 border-r border-line bg-panel p-3 lg:flex">
        <div className="flex items-center gap-2 px-2 pt-1 font-semibold">
          <AudioLines className="size-5 text-accent" /> Transcriber
        </div>
        {nav}
        {footer}
      </aside>
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-line bg-panel/95 px-4 py-2.5 backdrop-blur lg:hidden">
        <div className="flex items-center gap-2 font-semibold">
          <AudioLines className="size-5 text-accent" /> Transcriber
        </div>
        <button className="rounded-md p-2 hover:bg-panel-2" onClick={() => setMenu(!menu)} aria-label="選單">
          <Menu className="size-5" />
        </button>
      </header>
      {menu && (
        <div className="fixed inset-x-0 top-[53px] z-30 flex flex-col gap-3 border-b border-line bg-panel p-3 shadow-lg lg:hidden">
          {nav}
          {footer}
        </div>
      )}
      <main className="mx-auto w-full max-w-[1400px] px-4 py-5 sm:px-6">{children}</main>
      {dragging !== null && (
        <div className="pointer-events-none fixed inset-3 z-50 flex items-center justify-center rounded-2xl border-4 border-dashed border-accent bg-accent/10 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-2 rounded-xl bg-panel px-8 py-6 shadow-xl">
            <UploadCloud className="size-10 text-accent" />
            <div className="text-lg font-semibold">放開即可上傳{dragging > 1 ? `（${dragging} 個檔案）` : ""}</div>
            <div className="text-sm text-muted">使用首頁目前的處理選項</div>
          </div>
        </div>
      )}
    </div>
  );
}

export function App() {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: () => get("/api/auth/me"), retry: false, staleTime: 60_000 });
  useEffect(() => {
    const h = () => qc.invalidateQueries({ queryKey: ["me"] });
    window.addEventListener("auth:required", h);
    return () => window.removeEventListener("auth:required", h);
  }, [qc]);
  if (me.isLoading) return null;
  if (me.isError) return <Login onDone={() => qc.invalidateQueries({ queryKey: ["me"] })} />;
  return (
    <Shell user={me.data.user.username}>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/upload" element={<Navigate to="/" replace />} />
        <Route path="/jobs" element={<Navigate to="/" replace />} />
        <Route path="/recordings" element={<RecordingsPage />} />
        <Route path="/recordings/:id" element={<RecordingDetail />} />
        <Route path="/speakers" element={<SpeakersPage />} />
        <Route path="/speakers/:id" element={<SpeakersPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<div className="py-20 text-center text-muted">找不到頁面</div>} />
      </Routes>
    </Shell>
  );
}
