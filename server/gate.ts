/**
 * 站点门禁：整个站一个共用密码（取代以前 nginx 的 HTTP 基本认证）。
 *
 * - 密码只在服务器上用命令行设（node main.js gate-password 密码），库里存 scrypt 哈希；没设 = 不启用（本地开发）。
 * - 输对了发一个门禁 cookie（随机令牌，库里存哈希），90 天有效；改密码时全部作废。
 * - 同一个 IP 在一小时内输错 MAX_FAILS 次就封 BAN_HOURS 小时；输对清零。封着的 IP 连密码都不让试。
 * - nginx 用 auth_request 问 /api/gate/check 决定放不放行静态页面；/api/ 下的接口由 main.ts 自己挡。
 *
 * IP 取 Cloudflare 给的 CF-Connecting-IP（站点在 Cloudflare 后面，nginx 看到的是 Cloudflare 的地址），
 * 没有再用 nginx 的 X-Real-IP。绕过 Cloudflare 直连源站的人能伪造这个头，所以封 IP 只是挡住乱试，不是铁门。
 */
import type { IncomingMessage } from 'node:http';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const GATE_COOKIE = 'dnd2_gate';
export const MAX_FAILS = 5;
export const FAIL_WINDOW_MS = 3600_000;
export const BAN_HOURS = 24;
const GATE_DAYS = 90;

type Row = Record<string, unknown>;
export interface GateDeps {
  one: (sql: string, ...args: Array<string | number | null>) => Row | undefined;
  all: (sql: string, ...args: Array<string | number | null>) => Row[];
  run: (sql: string, ...args: Array<string | number | null>) => unknown;
  exec: (sql: string) => void;
  now?: () => number;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export function clientIp(req: IncomingMessage): string {
  const h = (k: string) => { const v = req.headers[k]; return (Array.isArray(v) ? v[0] : v)?.trim(); };
  return h('cf-connecting-ip') || h('x-real-ip') || req.socket.remoteAddress || '?';
}

export function cookieOf(req: IncomingMessage, name: string): string | undefined {
  return (req.headers.cookie ?? '').split(';').map((s) => s.trim()).find((s) => s.startsWith(name + '='))?.slice(name.length + 1);
}

export function createGate(d: GateDeps) {
  const now = d.now ?? Date.now;
  d.exec(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS gate_sessions (token_hash TEXT PRIMARY KEY, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS gate_fails (
      ip TEXT PRIMARY KEY, count INTEGER NOT NULL, first INTEGER NOT NULL, banned_until INTEGER NOT NULL DEFAULT 0
    );
  `);

  const secret = () => {
    const v = d.one(`SELECT value FROM settings WHERE key = 'gate_password'`)?.value;
    return v ? (JSON.parse(String(v)) as { salt: string; hash: string }) : null;
  };

  /** 没设密码 = 门禁关着，谁都放行 */
  const enabled = () => secret() !== null;

  function setPassword(password: string | null): void {
    d.run('DELETE FROM gate_sessions');
    if (password === null) { d.run(`DELETE FROM settings WHERE key = 'gate_password'`); return; }
    const salt = randomBytes(16).toString('hex');
    const value = JSON.stringify({ salt, hash: scryptSync(password, salt, 32).toString('hex') });
    d.run(`INSERT INTO settings (key, value) VALUES ('gate_password', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, value);
  }

  /** 这个 IP 封到什么时候（毫秒时间戳），没封是 0 */
  function bannedUntil(ip: string): number {
    const until = Number(d.one('SELECT banned_until FROM gate_fails WHERE ip = ?', ip)?.banned_until ?? 0);
    return until > now() ? until : 0;
  }

  function passed(req: IncomingMessage): boolean {
    if (!enabled()) return true;
    if (bannedUntil(clientIp(req))) return false;
    const token = cookieOf(req, GATE_COOKIE);
    if (!token) return false;
    const row = d.one('SELECT created FROM gate_sessions WHERE token_hash = ?', sha(token));
    return !!row && now() - Number(row.created) < GATE_DAYS * 86400_000;
  }

  type LoginResult = { ok: true; token: string } | { ok: false; left: number; bannedUntil: number };

  function login(ip: string, password: string): LoginResult {
    const s = secret();
    if (!s) return { ok: true, token: newToken() };
    const banned = bannedUntil(ip);
    if (banned) return { ok: false, left: 0, bannedUntil: banned };
    const got = scryptSync(password, s.salt, 32), want = Buffer.from(s.hash, 'hex');
    if (got.length === want.length && timingSafeEqual(got, want)) {
      d.run('DELETE FROM gate_fails WHERE ip = ?', ip);
      return { ok: true, token: newToken() };
    }
    // 输错：一小时窗口内累计，到 MAX_FAILS 次就封
    const t = now();
    const row = d.one('SELECT count, first FROM gate_fails WHERE ip = ?', ip);
    const fresh = !row || t - Number(row.first) > FAIL_WINDOW_MS;
    const count = fresh ? 1 : Number(row!.count) + 1;
    const until = count >= MAX_FAILS ? t + BAN_HOURS * 3600_000 : 0;
    d.run(`INSERT INTO gate_fails (ip, count, first, banned_until) VALUES (?, ?, ?, ?)
           ON CONFLICT(ip) DO UPDATE SET count = excluded.count, first = excluded.first, banned_until = excluded.banned_until`,
      ip, until ? 0 : count, fresh ? t : Number(row!.first), until);
    return { ok: false, left: until ? 0 : MAX_FAILS - count, bannedUntil: until };
  }

  function newToken(): string {
    const token = randomBytes(32).toString('base64url');
    d.run('INSERT INTO gate_sessions (token_hash, created) VALUES (?, ?)', sha(token), now());
    return token;
  }

  function cookieHeader(token: string, secure: boolean): string {
    return `${GATE_COOKIE}=${token}; Max-Age=${GATE_DAYS * 86400}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  }

  const bans = () => d.all('SELECT ip, banned_until FROM gate_fails WHERE banned_until > ? ORDER BY banned_until', now());
  const unban = (ip: string) => d.run('DELETE FROM gate_fails WHERE ip = ?', ip);

  return { enabled, setPassword, passed, login, bannedUntil, cookieHeader, bans, unban };
}
export type Gate = ReturnType<typeof createGate>;
