/** Admin CLI: `node dist/cli.js set-password <user>` (password read from stdin), `migrate`. */
import readline from "node:readline";
import { loadConfig, dataPaths } from "./config.js";
import { openDb, schemaVersion } from "./db/index.js";
import { hashPassword } from "./auth/auth.js";
import { nowIso, uuid } from "./lib/util.js";

const [cmd, arg] = process.argv.slice(2);
const cfg = loadConfig();
const db = openDb(dataPaths(cfg.dataDir).db);

if (cmd === "migrate") {
  console.log(`schema version ${schemaVersion(db)}`);
} else if (cmd === "set-password") {
  const user = arg ?? cfg.adminUser;
  const rl = readline.createInterface({ input: process.stdin });
  const pw: string = await new Promise((r) => rl.once("line", (l) => (rl.close(), r(l.trim()))));
  if (pw.length < 10) {
    console.error("password must be at least 10 characters");
    process.exit(1);
  }
  const hash = await hashPassword(pw);
  const exists = db.prepare("SELECT id FROM users WHERE username = ?").get(user) as any;
  if (exists) db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").run(hash, nowIso(), exists.id);
  else db.prepare("INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(uuid(), user, hash, nowIso(), nowIso());
  db.prepare("DELETE FROM auth_sessions WHERE user_id = (SELECT id FROM users WHERE username = ?)").run(user);
  console.log(`password set for ${user}`);
} else {
  console.log("usage: cli.js migrate | set-password [user]  (password on stdin)");
}
db.close();
