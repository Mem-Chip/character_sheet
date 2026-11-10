/**
 * 后端：账户、人物卡同步、战役（SERVER-DESIGN.md 第四、五、七节的第一步）。
 *
 * 不装依赖，数据在 SQLite（node:sqlite）里。遭遇用的是和浏览器同一份战斗引擎（src/combat），
 * 所以部署时先打包成一个文件（npm run build:server → dist-server/main.js），开发时用 tsx 直接跑：
 *   npx tsx server/main.ts                    起服务（PORT、DB 见下面的环境变量）
 *   node main.js reset-password 名字 新密码     （服务器上：/opt/dnd-v2/main.js）
 *   node main.js users                        列出所有用户
 *   node main.js gate-password 密码            设站点门禁密码（--off 关掉门禁）；旧的门禁 cookie 全部作废
 *   node main.js bans / unban IP              看 / 解封因为输错门禁密码被封的 IP
 *
 * 只监听 127.0.0.1；外面是 nginx 和站点门禁（gate.ts：一个共用密码，输错多次封 IP）。私人站点，默认用户都是好人：
 * 注册不验证，账户只用来区分「你是谁」。
 *
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createEncounters } from './encounters';
import { clientIp, createGate } from './gate';
import { createHub } from './hub';
import { createLibrary } from './library';

const argPort = process.argv.indexOf('--port');
const PORT = Number(argPort > 0 ? process.argv[argPort + 1] : process.env.PORT ?? 8789);
const DB_FILE = resolve(process.env.DB ?? 'data/server.db');
const SECURE_COOKIE = process.env.SECURE_COOKIE === '1';
const COOKIE = 'dnd2_sid';
const SESSION_DAYS = 90;
const MAX_BODY = 8 * 1024 * 1024;

mkdirSync(dirname(DB_FILE), { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    hash TEXT NOT NULL, salt TEXT NOT NULL, created INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created INTEGER NOT NULL, seen INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS campaigns (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id INTEGER NOT NULL REFERENCES users(id),
    code TEXT NOT NULL UNIQUE, created INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS members (
    campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('dm', 'player')), joined INTEGER NOT NULL,
    PRIMARY KEY (campaign_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS cards (
    id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES users(id),
    data TEXT NOT NULL, rev INTEGER NOT NULL, updated INTEGER NOT NULL,
    campaign_id TEXT REFERENCES campaigns(id) ON DELETE SET NULL,
    deleted INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS cards_owner ON cards(owner_id);
  CREATE INDEX IF NOT EXISTS cards_campaign ON cards(campaign_id);
`);

type Row = Record<string, unknown>;
const one = (sql: string, ...args: Array<string | number | null>) => db.prepare(sql).get(...args) as Row | undefined;
const all = (sql: string, ...args: Array<string | number | null>) => db.prepare(sql).all(...args) as Row[];
const run = (sql: string, ...args: Array<string | number | null | Uint8Array>) => db.prepare(sql).run(...args);

/* ───────────── 密码与会话 ───────────── */

function hashPassword(password: string, salt = randomBytes(16).toString('hex')) {
  return { salt, hash: scryptSync(password, salt, 32).toString('hex') };
}
function checkPassword(password: string, salt: string, hash: string): boolean {
  const got = scryptSync(password, salt, 32);
  const want = Buffer.from(hash, 'hex');
  return got.length === want.length && timingSafeEqual(got, want);
}
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function newSession(userId: number): string {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  run('INSERT INTO sessions (token_hash, user_id, created, seen) VALUES (?, ?, ?, ?)', sha(token), userId, now, now);
  return token;
}

function cookieHeader(token: string | null): string {
  const attrs = ['Path=/', 'HttpOnly', 'SameSite=Lax', ...(SECURE_COOKIE ? ['Secure'] : [])];
  return token === null
    ? `${COOKIE}=; Max-Age=0; ${attrs.join('; ')}`
    : `${COOKIE}=${token}; Max-Age=${SESSION_DAYS * 86400}; ${attrs.join('; ')}`;
}

interface User { id: number; name: string }

function userOf(req: IncomingMessage): User | null {
  const raw = (req.headers.cookie ?? '').split(';').map((s) => s.trim()).find((s) => s.startsWith(COOKIE + '='));
  const token = raw?.slice(COOKIE.length + 1);
  if (!token) return null;
  const row = one(`SELECT u.id, u.name, s.seen FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`, sha(token));
  if (!row) return null;
  const now = Date.now();
  if (now - Number(row.seen) > SESSION_DAYS * 86400_000) {
    run('DELETE FROM sessions WHERE token_hash = ?', sha(token));
    return null;
  }
  if (now - Number(row.seen) > 3600_000) run('UPDATE sessions SET seen = ? WHERE token_hash = ?', now, sha(token));
  return { id: Number(row.id), name: String(row.name) };
}

/* ───────────── 人物卡与战役 ───────────── */

/** 能看到的卡：自己的（含已删除的，好让别的设备知道删了）+ 自己当 DM 的战役里挂着的 */
function visibleCards(u: User): Row[] {
  return all(`
    SELECT c.*, u.name AS owner_name FROM cards c JOIN users u ON u.id = c.owner_id
    WHERE c.owner_id = ?
       OR (c.deleted = 0 AND c.campaign_id IN (SELECT campaign_id FROM members WHERE user_id = ? AND role = 'dm'))`, u.id, u.id);
}

const cardJson = (r: Row) => ({
  id: r.id, rev: r.rev, updated: r.updated, deleted: !!r.deleted,
  owner: { id: r.owner_id, name: r.owner_name },
  campaignId: r.campaign_id ?? null,
  char: r.deleted ? null : JSON.parse(String(r.data)),
});

const roleIn = (u: User, campaignId: string) =>
  (one('SELECT role FROM members WHERE campaign_id = ? AND user_id = ?', campaignId, u.id)?.role as 'dm' | 'player' | undefined) ?? null;

function canWriteCard(u: User, card: Row): boolean {
  if (Number(card.owner_id) === u.id) return true;
  // DM 可以改挂在自己战役里的卡（战斗结束写回生命值、资源）
  return !!card.campaign_id && roleIn(u, String(card.campaign_id)) === 'dm';
}

function campaignJson(c: Row, u: User) {
  const role = roleIn(u, String(c.id));
  const members = all(`SELECT u.id, u.name, m.role FROM members m JOIN users u ON u.id = m.user_id WHERE m.campaign_id = ? ORDER BY m.joined`, String(c.id));
  const cards = all(`SELECT c.id, c.data, c.owner_id, u.name AS owner_name FROM cards c JOIN users u ON u.id = c.owner_id
                     WHERE c.campaign_id = ? AND c.deleted = 0`, String(c.id))
    .map((r) => {
      const ch = JSON.parse(String(r.data));
      return {
        id: r.id, ownerId: r.owner_id, ownerName: r.owner_name, name: ch.name || '未命名',
        dmControlled: !!ch.dmControlled,
        summary: [ch.race, (ch.classes || []).filter((k: Row) => k.name).map((k: Row) => `${k.name} ${k.level}`).join(' / ')].filter(Boolean).join(' · '),
      };
    });
  return { id: c.id, name: c.name, ownerId: c.owner_id, role, code: role === 'dm' ? c.code : undefined, members, cards };
}

const newCode = () => randomBytes(5).toString('base64url').replace(/[-_]/g, 'x').slice(0, 6).toUpperCase();

/* ───────────── HTTP ───────────── */

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
const bad = (msg: string) => new HttpError(400, msg);

async function bodyOf(req: IncomingMessage): Promise<Row> {
  if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) throw new HttpError(415, '要 JSON');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, '太大了');
    chunks.push(c as Buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw bad('不是合法的 JSON'); }
}

function send(res: ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(data));
}

const NAME_RE = /^[^\s<>"'&]{1,24}$/u;

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // nginx 和开发时的 vite 都转发 /api/...；/v2/api/ 是以前页面在 /v2/ 下时的路径，留着兼容
  const url = new URL(req.url ?? '/', 'http://x');
  const path = url.pathname.replace(/^\/v2(?=\/api\/)/, '');
  const method = req.method ?? 'GET';
  const m = (re: RegExp) => path.match(re);

  if (path === '/api/health') return send(res, 200, { ok: true });

  // 站点门禁：nginx 的 auth_request 每个页面请求都来问一次；接口在这里挡
  if (path === '/api/gate/check') {
    res.writeHead(gate.passed(req) ? 204 : gate.bannedUntil(clientIp(req)) ? 403 : 401, { 'cache-control': 'no-store' });
    return void res.end();
  }
  if (method === 'GET' && path === '/api/gate/status') {
    return send(res, 200, { enabled: gate.enabled(), passed: gate.passed(req), bannedUntil: gate.bannedUntil(clientIp(req)) });
  }
  if (method === 'POST' && path === '/api/gate/login') {
    const b = await bodyOf(req);
    const r = gate.login(clientIp(req), String(b.password ?? ''));
    if (r.ok) return send(res, 200, { ok: true }, { 'set-cookie': gate.cookieHeader(r.token, SECURE_COOKIE) });
    if (r.bannedUntil) return send(res, 429, { error: '输错太多次，这个 IP 暂时被封了', bannedUntil: r.bannedUntil });
    return send(res, 401, { error: `密码不对，还能试 ${r.left} 次`, left: r.left });
  }
  if (!gate.passed(req)) return send(res, 401, { error: '要先输入站点密码', gate: true });

  if (method === 'POST' && path === '/api/register') {
    const b = await bodyOf(req);
    const name = String(b.name ?? '').trim(), password = String(b.password ?? '');
    if (!NAME_RE.test(name)) throw bad('名字 1–24 个字，不能有空格和 <>"\'&');
    if (password.length < 4) throw bad('密码至少 4 位');
    if (one('SELECT 1 FROM users WHERE name = ?', name)) throw new HttpError(409, '这个名字有人用了');
    const { salt, hash } = hashPassword(password);
    const id = Number(run('INSERT INTO users (name, hash, salt, created) VALUES (?, ?, ?, ?)', name, hash, salt, Date.now()).lastInsertRowid);
    return send(res, 200, { user: { id, name } }, { 'set-cookie': cookieHeader(newSession(id)) });
  }

  if (method === 'POST' && path === '/api/login') {
    const b = await bodyOf(req);
    const row = one('SELECT * FROM users WHERE name = ?', String(b.name ?? '').trim());
    if (!row || !checkPassword(String(b.password ?? ''), String(row.salt), String(row.hash))) throw new HttpError(401, '名字或密码不对');
    return send(res, 200, { user: { id: row.id, name: row.name } }, { 'set-cookie': cookieHeader(newSession(Number(row.id))) });
  }

  const u = userOf(req);
  if (path === '/api/me') return send(res, 200, { user: u });
  if (method === 'POST' && path === '/api/logout') {
    const token = (req.headers.cookie ?? '').split(';').map((s) => s.trim()).find((s) => s.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
    if (token) run('DELETE FROM sessions WHERE token_hash = ?', sha(token));
    return send(res, 200, { ok: true }, { 'set-cookie': cookieHeader(null) });
  }
  if (!u) throw new HttpError(401, '没有登录');
  // CSRF：带内容的请求一律要 JSON（bodyOf 检查），跨站表单发不出；cookie 是 SameSite=Lax，跨站 POST 不带它

  if (method === 'POST' && path === '/api/password') {
    const b = await bodyOf(req);
    const row = one('SELECT * FROM users WHERE id = ?', u.id)!;
    if (!checkPassword(String(b.old ?? ''), String(row.salt), String(row.hash))) throw new HttpError(403, '旧密码不对');
    if (String(b.password ?? '').length < 4) throw bad('密码至少 4 位');
    const { salt, hash } = hashPassword(String(b.password));
    run('UPDATE users SET hash = ?, salt = ? WHERE id = ?', hash, salt, u.id);
    return send(res, 200, { ok: true });
  }

  if (await encounters(req, res, u, path, method)) return;
  if (await library.handle(req, res, u, path, method)) return;
  if (await hub.handle(req, res, u, path, method)) return;

  /* 人物卡 */
  if (method === 'GET' && path === '/api/cards') return send(res, 200, { cards: visibleCards(u).map(cardJson) });

  let hit = m(/^\/api\/cards\/([\w-]{1,64})$/);
  if (hit && method === 'PUT') {
    const id = hit[1];
    const b = await bodyOf(req);
    if (!b.char || typeof b.char !== 'object') throw bad('缺 char');
    const data = JSON.stringify(b.char);
    const baseRev = Number(b.baseRev ?? 0);
    const cur = one('SELECT c.*, u.name AS owner_name FROM cards c JOIN users u ON u.id = c.owner_id WHERE c.id = ?', id);
    const now = Date.now();
    if (!cur) {
      run('INSERT INTO cards (id, owner_id, data, rev, updated) VALUES (?, ?, ?, 1, ?)', id, u.id, data, now);
      return send(res, 200, { rev: 1, updated: now });
    }
    if (!canWriteCard(u, cur)) throw new HttpError(403, '这张卡不是你的');
    if (cur.deleted) throw new HttpError(410, '这张卡已经删了');
    if (Number(cur.rev) !== baseRev) return send(res, 409, { error: '卡在别处改过了', card: cardJson(cur) });
    run('UPDATE cards SET data = ?, rev = rev + 1, updated = ? WHERE id = ?', data, now, id);
    return send(res, 200, { rev: Number(cur.rev) + 1, updated: now });
  }
  if (hit && method === 'DELETE') {
    const cur = one('SELECT * FROM cards WHERE id = ?', hit[1]);
    if (!cur) return send(res, 200, { ok: true });
    if (Number(cur.owner_id) !== u.id) throw new HttpError(403, '只有卡主能删');
    run(`UPDATE cards SET deleted = 1, data = '{}', campaign_id = NULL, rev = rev + 1, updated = ? WHERE id = ?`, Date.now(), hit[1]);
    return send(res, 200, { ok: true });
  }
  hit = m(/^\/api\/cards\/([\w-]{1,64})\/campaign$/);
  if (hit && method === 'PUT') {
    const b = await bodyOf(req);
    const cur = one('SELECT * FROM cards WHERE id = ? AND deleted = 0', hit[1]);
    if (!cur) throw new HttpError(404, '没有这张卡（先同步上去）');
    if (Number(cur.owner_id) !== u.id) throw new HttpError(403, '只有卡主能把卡带进战役');
    const cid = b.campaignId == null ? null : String(b.campaignId);
    if (cid && !roleIn(u, cid)) throw new HttpError(403, '你不在这个战役里');
    run('UPDATE cards SET campaign_id = ?, rev = rev + 1, updated = ? WHERE id = ?', cid, Date.now(), hit[1]);
    return send(res, 200, { ok: true });
  }

  /* 战役 */
  if (method === 'GET' && path === '/api/campaigns') {
    const rows = all(`SELECT c.* FROM campaigns c JOIN members m ON m.campaign_id = c.id WHERE m.user_id = ? ORDER BY c.created DESC`, u.id);
    return send(res, 200, { campaigns: rows.map((c) => campaignJson(c, u)) });
  }
  if (method === 'POST' && path === '/api/campaigns') {
    const b = await bodyOf(req);
    const name = String(b.name ?? '').trim().slice(0, 40);
    if (!name) throw bad('起个名字');
    const id = randomUUID();
    const now = Date.now();
    run('INSERT INTO campaigns (id, name, owner_id, code, created) VALUES (?, ?, ?, ?, ?)', id, name, u.id, newCode(), now);
    run(`INSERT INTO members (campaign_id, user_id, role, joined) VALUES (?, ?, 'dm', ?)`, id, u.id, now);
    return send(res, 200, { campaign: campaignJson(one('SELECT * FROM campaigns WHERE id = ?', id)!, u) });
  }
  if (method === 'POST' && path === '/api/campaigns/join') {
    const b = await bodyOf(req);
    const c = one('SELECT * FROM campaigns WHERE code = ?', String(b.code ?? '').trim().toUpperCase());
    if (!c) throw new HttpError(404, '邀请码不对');
    run(`INSERT OR IGNORE INTO members (campaign_id, user_id, role, joined) VALUES (?, ?, 'player', ?)`, String(c.id), u.id, Date.now());
    return send(res, 200, { campaign: campaignJson(c, u) });
  }
  hit = m(/^\/api\/campaigns\/([\w-]{1,64})(\/[a-z]+)?$/);
  if (hit) {
    const c = one('SELECT * FROM campaigns WHERE id = ?', hit[1]);
    const role = c ? roleIn(u, hit[1]) : null;
    if (!c || !role) throw new HttpError(404, '没有这个战役');
    const isOwner = Number(c.owner_id) === u.id;
    const sub = hit[2] ?? '';
    if (method === 'PATCH' && sub === '') {
      if (role !== 'dm') throw new HttpError(403, '只有 DM 能改');
      const b = await bodyOf(req);
      if (b.name) run('UPDATE campaigns SET name = ? WHERE id = ?', String(b.name).trim().slice(0, 40), hit[1]);
      if (b.newCode) run('UPDATE campaigns SET code = ? WHERE id = ?', newCode(), hit[1]);
      return send(res, 200, { campaign: campaignJson(one('SELECT * FROM campaigns WHERE id = ?', hit[1])!, u) });
    }
    if (method === 'POST' && sub === '/role') {
      if (!isOwner) throw new HttpError(403, '只有建团的人能指定 DM');
      const b = await bodyOf(req);
      const r = b.role === 'dm' ? 'dm' : 'player';
      if (Number(b.userId) === Number(c.owner_id)) throw bad('建团的人一直是 DM');
      run('UPDATE members SET role = ? WHERE campaign_id = ? AND user_id = ?', r, hit[1], Number(b.userId));
      return send(res, 200, { campaign: campaignJson(c, u) });
    }
    if (method === 'POST' && sub === '/leave') {
      if (isOwner) throw bad('建团的人不能退出（可以删掉战役）');
      run('UPDATE cards SET campaign_id = NULL WHERE campaign_id = ? AND owner_id = ?', hit[1], u.id);
      run('DELETE FROM members WHERE campaign_id = ? AND user_id = ?', hit[1], u.id);
      library.detachAll(hit[1], u.id);
      return send(res, 200, { ok: true });
    }
    if (method === 'POST' && sub === '/kick') {
      if (role !== 'dm') throw new HttpError(403, '只有 DM 能请人离开');
      const b = await bodyOf(req);
      if (Number(b.userId) === Number(c.owner_id)) throw bad('不能请建团的人离开');
      run('UPDATE cards SET campaign_id = NULL WHERE campaign_id = ? AND owner_id = ?', hit[1], Number(b.userId));
      run('DELETE FROM members WHERE campaign_id = ? AND user_id = ?', hit[1], Number(b.userId));
      library.detachAll(hit[1], Number(b.userId));
      return send(res, 200, { campaign: campaignJson(c, u) });
    }
    if (method === 'DELETE' && sub === '') {
      if (!isOwner) throw new HttpError(403, '只有建团的人能删战役');
      run('UPDATE cards SET campaign_id = NULL WHERE campaign_id = ?', hit[1]);
      run('DELETE FROM campaigns WHERE id = ?', hit[1]);
      return send(res, 200, { ok: true });
    }
  }
  throw new HttpError(404, '没有这个接口');
}

const deps = {
  one, all, run, exec: (sql: string) => db.exec(sql), bodyOf, send, roleIn,
  fail: (status: number, message: string) => new HttpError(status, message),
};
const gate = createGate(deps);
const library = createLibrary(deps);
const hub = createHub(deps, library);
const encounters = createEncounters({ ...deps, campaignRules: library.campaignRules, ownerRules: library.rulesOfOwner });

/* ───────────── 命令行 ───────────── */

const [cmd, ...args] = process.argv.slice(2).filter((_, i, a) => a[i] !== '--port' && a[i - 1] !== '--port');
if (cmd === 'reset-password') {
  const [name, password] = args;
  if (!name || !password) { console.error('用法：node server/main.ts reset-password 名字 新密码'); process.exit(1); }
  const { salt, hash } = hashPassword(password);
  const r = run('UPDATE users SET hash = ?, salt = ? WHERE name = ?', hash, salt, name);
  if (!r.changes) { console.error(`没有用户「${name}」`); process.exit(1); }
  run('DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE name = ?)', name);
  console.log(`已重置「${name}」的密码，旧的登录全部失效`);
} else if (cmd === 'users') {
  for (const r of all('SELECT id, name, created FROM users ORDER BY id')) console.log(r.id, r.name, new Date(Number(r.created)).toISOString());
} else if (cmd === 'gate-password') {
  const [password] = args;
  if (!password) { console.error('用法：node main.js gate-password 密码   （--off 关掉门禁）'); process.exit(1); }
  if (password === '--off') { gate.setPassword(null); console.log('门禁已关掉：谁都能打开站点'); }
  else if (password.length < 6) { console.error('门禁密码至少 6 位'); process.exit(1); }
  else { gate.setPassword(password); console.log('门禁密码已设好，旧的门禁 cookie 全部作废'); }
} else if (cmd === 'bans') {
  for (const r of gate.bans()) console.log(r.ip, '封到', new Date(Number(r.banned_until)).toISOString());
} else if (cmd === 'unban') {
  if (!args[0]) { console.error('用法：node main.js unban IP'); process.exit(1); }
  gate.unban(args[0]); console.log(`已解封 ${args[0]}`);
} else if (cmd) {
  console.error(`不认识的命令：${cmd}`);
  process.exit(1);
} else {
  createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      if (!res.headersSent) send(res, status, { error: e instanceof HttpError ? e.message : '服务器出错了' });
    });
  }).listen(PORT, '127.0.0.1', () => console.log(`listening on 127.0.0.1:${PORT}, db ${DB_FILE}`));
}
