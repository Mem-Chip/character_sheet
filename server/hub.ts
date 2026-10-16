/**
 * 战役资料（LIBRARY.md 后：内容已经搬到账户资料库，这里只剩战役自己的东西）。
 *
 * - 启用的书（campaign_books）：5etools 来源代号。卡面、战斗都从 5etools 原数据取，这里只记开关。
 * - 战役挂上来的内容：存在账户库（server/library.ts）里，这里只读出来给界面。
 * - 全服怪物 AI 结果（monster_ai）：怪物键 → 补到解析结果上的条目 / 备注，全服共享。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { lintShape } from '../src/factory';
import type { Deps } from './encounters';
import type { createLibrary } from './library';

type Row = Record<string, unknown>;
interface User { id: number; name: string }
type Lib = ReturnType<typeof createLibrary>;

const SRC_RE = /^[A-Za-z0-9-]{1,24}$/;
const MAX_MONSTER_AI = 600_000;

export function createHub(d: Deps, lib: Lib) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS campaign_books (
      campaign_id TEXT PRIMARY KEY REFERENCES campaigns(id) ON DELETE CASCADE,
      sources TEXT NOT NULL, updated INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS monster_ai (
      monster_key TEXT PRIMARY KEY, data TEXT NOT NULL, by_user INTEGER NOT NULL,
      rev INTEGER NOT NULL, updated INTEGER NOT NULL
    );
  `);

  const sourcesOf = (cid: string): string[] => {
    const r = d.one('SELECT sources FROM campaign_books WHERE campaign_id = ?', cid);
    return r ? JSON.parse(String(r.sources)) : [];
  };

  async function handle(req: IncomingMessage, res: ServerResponse, u: User, path: string, method: string): Promise<boolean> {
    let hit = path.match(/^\/api\/campaigns\/([\w-]{1,64})\/hub(?:\/(sources))?$/);
    if (hit) {
      const [, cid, sub] = hit;
      const role = d.roleIn(u, cid);
      if (!role) throw d.fail(404, '没有这个战役');
      if (method === 'GET' && !sub) {
        d.send(res, 200, {
          sources: sourcesOf(cid), role,
          /** 全部挂载（含待审、关掉的）：界面算生效、DM 面板列开关都从这里来 */
          attached: lib.attachedOf(cid),
          /** 我挂上去的条目 id */
          mine: lib.itemsOf(u.id).map((it) => it.id),
        });
        return true;
      }
      if (role !== 'dm') throw d.fail(403, '只有 DM 能改战役资料');
      if (method === 'PUT' && sub === 'sources') {
        const b = await d.bodyOf(req);
        const list = Array.isArray(b.sources) ? [...new Set((b.sources as unknown[]).map(String).filter((s) => SRC_RE.test(s)).map((s) => s.toUpperCase()))].slice(0, 200) : null;
        if (!list) throw d.fail(400, '缺 sources');
        d.run('INSERT INTO campaign_books (campaign_id, sources, updated) VALUES (?, ?, ?) ON CONFLICT(campaign_id) DO UPDATE SET sources = excluded.sources, updated = excluded.updated', cid, JSON.stringify(list), Date.now());
        d.send(res, 200, { sources: list });
        return true;
      }
      throw d.fail(404, '没有这个接口');
    }

    // 怪物 AI 结果：谁都能读；当过 DM 的人能写
    if (method === 'GET' && path === '/api/monster-ai') {
      const out: Record<string, unknown> = {};
      for (const r of d.all('SELECT monster_key, data, rev, updated FROM monster_ai')) out[String(r.monster_key)] = { ...JSON.parse(String(r.data)), rev: Number(r.rev), updated: Number(r.updated) };
      d.send(res, 200, { monsters: out });
      return true;
    }
    hit = path.match(/^\/api\/monster-ai\/(.{1,160})$/);
    if (hit) {
      const key = decodeURIComponent(hit[1]);
      if (!d.one(`SELECT 1 AS x FROM members WHERE user_id = ? AND role = 'dm' LIMIT 1`, u.id)) throw d.fail(403, '当 DM 的人才能改怪物数据');
      if (method === 'DELETE') {
        d.run('DELETE FROM monster_ai WHERE monster_key = ?', key);
        d.send(res, 200, { status: 'done' });
        return true;
      }
      if (method === 'PUT') {
        const b = await d.bodyOf(req);
        const body = (b.data ?? {}) as Row;
        const entries = body.entries && typeof body.entries === 'object' ? body.entries as Record<string, unknown> : {};
        const problems = Object.entries(entries).flatMap(([k, e]) => lintShape(e).map((m) => `${k}：${m}`));
        if (problems.length) { d.send(res, 200, { status: 'rejected', problems }); return true; }
        const data = JSON.stringify({ entries, drop: Array.isArray(body.drop) ? body.drop.map(String) : [], by: String(body.by ?? 'hand').slice(0, 80), reviewed: !!body.reviewed });
        if (data.length > MAX_MONSTER_AI) throw d.fail(413, '太大了');
        d.run(`INSERT INTO monster_ai (monster_key, data, by_user, rev, updated) VALUES (?, ?, ?, 1, ?)
               ON CONFLICT(monster_key) DO UPDATE SET data = excluded.data, by_user = excluded.by_user, rev = monster_ai.rev + 1, updated = excluded.updated`, key, data, u.id, Date.now());
        d.send(res, 200, { status: 'done' });
        return true;
      }
    }
    return false;
  }

  return { handle };
}
