import { useState } from "react";
import { AudioLines } from "lucide-react";
import { post } from "../lib/api";
import { Button, ErrorNote, Field, Input } from "../components/ui";

export function Login({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <form
        className="w-full max-w-sm space-y-4 rounded-xl border border-line bg-panel p-6 shadow-sm"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await post("/api/auth/login", { username, password });
            onDone();
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="flex items-center gap-2 text-lg font-semibold">
          <AudioLines className="size-6 text-accent" /> Transcriber
        </div>
        <p className="text-sm text-muted">本機語音轉錄與知識管理。錄音只在這台主機上處理。</p>
        <Field label="帳號">
          <Input autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
        </Field>
        <Field label="密碼">
          <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
        </Field>
        <ErrorNote error={error} />
        <Button variant="primary" className="w-full" loading={busy} type="submit">
          登入
        </Button>
      </form>
    </div>
  );
}
