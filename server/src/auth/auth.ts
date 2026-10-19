import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { DB } from "../db/index.js";
import type { AppConfig } from "../config.js";
import { AppError, nowIso, uuid } from "../lib/util.js";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const SESSION_COOKIE = "tsid";
const SESSION_DAYS = 30;

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [algo, n, saltB64, keyB64] = stored.split("$");
  if (algo !== "scrypt") return false;
  const key = Buffer.from(keyB64, "base64");
  const got = await scrypt(pw, Buffer.from(saltB64, "base64"), key.length, { ...SCRYPT, N: Number(n) });
  return got.length === key.length && timingSafeEqual(got, key);
}

export async function ensureAdmin(db: DB, cfg: AppConfig, log: (m: string) => void) {
  const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(cfg.adminUser);
  if (existing) return;
  if (!cfg.adminPassword) {
    log("No admin user yet and ADMIN_PASSWORD is not set; login is impossible until it is configured.");
    return;
  }
  db.prepare("INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
    uuid(),
    cfg.adminUser,
    await hashPassword(cfg.adminPassword),
    nowIso(),
    nowIso(),
  );
  log(`Created admin user "${cfg.adminUser}".`);
}

export interface AuthUser {
  id: string;
  username: string;
  sessionId: string;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

const failed = new Map<string, { count: number; until: number }>();

export function registerAuth(app: FastifyInstance, db: DB, cfg: AppConfig) {
  const lookup = db.prepare(
    `SELECT s.id AS sid, s.expires_at, u.id, u.username FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
  );

  app.decorateRequest("user", undefined);

  app.addHook("onRequest", async (req) => {
    const sid = req.cookies?.[SESSION_COOKIE];
    if (!sid) return;
    const row = lookup.get(sid) as any;
    if (!row) return;
    if (Date.parse(row.expires_at) < Date.now()) {
      db.prepare("DELETE FROM auth_sessions WHERE id = ?").run(sid);
      return;
    }
    req.user = { id: row.id, username: row.username, sessionId: row.sid };
  });

  app.post("/api/auth/login", async (req, reply) => {
    const ip = req.ip;
    const f = failed.get(ip);
    if (f && f.until > Date.now()) throw new AppError(429, "rate_limited", "Too many failed logins. Try again later.");
    const body = (req.body ?? {}) as { username?: string; password?: string };
    if (typeof body.username !== "string" || typeof body.password !== "string")
      throw new AppError(400, "bad_request", "username and password are required");
    const user = db.prepare("SELECT id, username, password_hash FROM users WHERE username = ?").get(body.username) as any;
    const ok = user ? await verifyPassword(body.password, user.password_hash) : false;
    if (!ok) {
      const count = (f?.count ?? 0) + 1;
      failed.set(ip, { count, until: count >= 5 ? Date.now() + 5 * 60_000 : 0 });
      throw new AppError(401, "invalid_credentials", "Invalid username or password");
    }
    failed.delete(ip);
    const sid = randomBytes(32).toString("base64url");
    const expires = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
    db.prepare("INSERT INTO auth_sessions (id, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)").run(
      sid,
      user.id,
      nowIso(),
      expires,
      String(req.headers["user-agent"] ?? "").slice(0, 200),
    );
    reply.setCookie(SESSION_COOKIE, sid, {
      httpOnly: true,
      sameSite: "strict",
      secure: cfg.secureCookies,
      path: "/",
      maxAge: SESSION_DAYS * 86400,
    });
    return { user: { id: user.id, username: user.username } };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    if (req.user) db.prepare("DELETE FROM auth_sessions WHERE id = ?").run(req.user.sessionId);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/auth/me", async (req) => {
    if (!req.user) throw new AppError(401, "unauthorized", "Not logged in");
    return { user: { id: req.user.id, username: req.user.username } };
  });

  app.post("/api/auth/password", async (req) => {
    if (!req.user) throw new AppError(401, "unauthorized", "Not logged in");
    const body = (req.body ?? {}) as { current?: string; next?: string };
    const user = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(req.user.id) as any;
    if (!body.current || !(await verifyPassword(body.current, user.password_hash)))
      throw new AppError(400, "invalid_credentials", "Current password is wrong");
    if (!body.next || body.next.length < 10) throw new AppError(400, "weak_password", "New password must be at least 10 characters");
    db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").run(await hashPassword(body.next), nowIso(), req.user.id);
    db.prepare("DELETE FROM auth_sessions WHERE user_id = ? AND id != ?").run(req.user.id, req.user.sessionId);
    return { ok: true };
  });
}

/** Guard for every /api route except the auth endpoints and health. */
export function requireAuth(req: FastifyRequest, _reply: FastifyReply, done: (err?: Error) => void) {
  if (!req.user) return done(new AppError(401, "unauthorized", "Login required"));
  done();
}

/**
 * CSRF / cross-origin defence for state-changing requests: the session cookie is
 * SameSite=Strict, and additionally the Origin (when present) must be one we serve.
 */
export function originCheck(cfg: AppConfig) {
  return (req: FastifyRequest, _reply: FastifyReply, done: (err?: Error) => void) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return done();
    const origin = req.headers.origin;
    if (!origin) return done();
    const host = req.headers["x-forwarded-host"] ?? req.headers.host;
    const self = [`https://${host}`, `http://${host}`];
    if (self.includes(origin) || cfg.allowedOrigins.includes(origin)) return done();
    done(new AppError(403, "bad_origin", "Cross-origin request refused"));
  };
}
