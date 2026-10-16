/**
 * 战役资料库（DATA-HUB.md 第二节）：战役启用的书 + 本团内容（家规、数据化补丁）；全服的怪物 AI 结果。
 *
 * 服务器只存、只做结构检查，不算：
 * - 启用的书：5etools 来源代号（books.json 里的 id）。卡面、战斗都从 5etools 原数据取，这里只记开关。
 * - 本团内容（content）：一条 = 卡面部分（HomeRuleEntry：mods / grants / choices / resources）
 *   和 / 或战斗部分（房规层的一条：整条 entry 或字段 patch，键 = 官方键或 HR:<id>）。
 * - 怪物 AI 结果（monster_ai）：怪物键 → 补到解析结果上的条目 / 备注，全服共享。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HouseRule } from '../src/combat';
import { lintShape } from '../src/factory';
import type { Deps } from './encounters';

type Row = Record<string, unknown>;
interface User { id: number; name: string }

/** 一条本团内容（和 app/lib/hub.ts 的 HubItem 一样） */
export interface HubItem {
  id: string;
  name: string;
  text: string;
  /** 卡面覆盖的官方条目键（`<来源>:<名字>` / 职业特性键）；空 = 新内容 */
  covers?: string;
  /** 新内容能不能在建卡时被选（专长、可选特性那种） */
  pickable?: boolean;
  sheet?: { mods?: unknown[]; grants?: unknown[]; choices?: unknown[]; resources?: unknown[] };
  /** 战斗：key 不写 = covers（覆盖的官方键），再没有 = HR:<id>（新内容）；entry 整条替换 / 新增，patch 改字段，value 改核心参数（key = core.<名>） */
  combat?: { key?: string; entry?: unknown; patch?: Record<string, unknown>; value?: unknown };
  /** 谁写的：手写 / AI（byok:<模型名>） */
  by: string;
  reviewed: boolean;
  rev?: number;
  updated?: number;
}

const ID_RE = /^hr-[0-9a-z]{4,16}$/;
const SRC_RE = /^[A-Za-z0-9-]{1,24}$/;
const MAX_ITEM = 200_000;

/** 检查并整理一条内容；返回问题（空 = 通过） */
export function checkItem(x: Row, id: string): { item: HubItem | null; problems: string[] } {
  const p: string[] = [];
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
  if (!ID_RE.test(id)) p.push('id 不合法');
  const name = str(x.name, 60).trim();
  if (!name) p.push('要有名字');
  const sheet = x.sheet && typeof x.sheet === 'object' ? x.sheet as Row : undefined;
  if (sheet) for (const k of ['mods', 'grants', 'choices', 'resources']) if (sheet[k] !== undefined && !Array.isArray(sheet[k])) p.push(`卡面的 ${k} 要是数组`);
  const combat = x.combat && typeof x.combat === 'object' ? x.combat as Row : undefined;
  if (combat) {
    const key = combat.key === undefined ? '' : str(combat.key, 200);
    if (combat.entry !== undefined && combat.patch !== undefined) p.push('战斗部分不能同时整条替换和改字段');
    if (combat.entry === undefined && combat.patch === undefined && combat.value === undefined) p.push('战斗部分是空的');
    if (combat.entry !== undefined) p.push(...lintShape(combat.entry).map((m) => '战斗数据：' + m));
    if (combat.patch !== undefined && (typeof combat.patch !== 'object' || Array.isArray(combat.patch))) p.push('patch 要是「路径 → 新值」');
    if (combat.patch !== undefined && !key) p.push('改字段要写改哪条（key）');
    if (combat.value !== undefined && !key.startsWith('core.')) p.push('核心参数的 key 要写成 core.<名字>');
  }
  if (!sheet && !combat && !str(x.text, 20000).trim()) p.push('卡面、战斗、说明至少要有一样');
  const item: HubItem = {
    id, name, text: str(x.text, 20000),
    ...(str(x.covers, 200).trim() ? { covers: str(x.covers, 200).trim() } : {}),
    ...(x.pickable ? { pickable: true } : {}),
    ...(sheet ? { sheet: sheet as HubItem['sheet'] } : {}),
    ...(combat ? { combat: combat as HubItem['combat'] } : {}),
    by: /^(hand|byok:[^\s]{1,80})$/.test(String(x.by)) ? String(x.by) : 'hand',
    reviewed: !!x.reviewed,
  };
  if (JSON.stringify(item).length > MAX_ITEM) p.push('太大了');
  return { item: p.length ? null : item, problems: p };
}

/** 一条内容在战斗规则书里的样子（房规层的一条）；没有战斗部分 = null */
export function houseRuleOf(it: HubItem): HouseRule | null {
  const c = it.combat;
  if (!c) return null;
  const text = it.text?.trim() || it.name;
  // 默认：覆盖了哪条官方能力就写在那条的键上（卡面、战斗同一个键），新内容用 HR:<id>
  const key = c.key?.trim() || it.covers || `HR:${it.id}`;
  return {
    id: it.id, key, text,
    ...(c.entry !== undefined ? { entry: c.entry as HouseRule['entry'], ...(key.startsWith('HR:') ? {} : { fill: true }) } : {}),
    ...(c.patch !== undefined ? { patch: c.patch } : {}),
    ...(c.value !== undefined ? { value: c.value } : {}),
  };
}

export function createHub(d: Deps) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS campaign_books (
      campaign_id TEXT PRIMARY KEY REFERENCES campaigns(id) ON DELETE CASCADE,
      sources TEXT NOT NULL, updated INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS content (
      id TEXT NOT NULL, campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      data TEXT NOT NULL, by_user INTEGER NOT NULL, rev INTEGER NOT NULL, updated INTEGER NOT NULL,
      PRIMARY KEY (campaign_id, id)
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
  const itemsOf = (cid: string): HubItem[] => d.all('SELECT data, rev, updated FROM content WHERE campaign_id = ? ORDER BY updated', cid)
    .map((r) => ({ ...JSON.parse(String(r.data)), rev: Number(r.rev), updated: Number(r.updated) }));

  /** 开遭遇时抄进遭遇的：本团内容的战斗部分 */
  function campaignRules(cid: string): HouseRule[] {
    return itemsOf(cid).map(houseRuleOf).filter((x): x is HouseRule => !!x);
  }

  async function handle(req: IncomingMessage, res: ServerResponse, u: User, path: string, method: string): Promise<boolean> {
    let hit = path.match(/^\/api\/campaigns\/([\w-]{1,64})\/hub(?:\/(sources|items)(?:\/([\w-]{1,40}))?)?$/);
    if (hit) {
      const [, cid, sub, itemId] = hit;
      const role = d.roleIn(u, cid);
      if (!role) throw d.fail(404, '没有这个战役');
      if (method === 'GET' && !sub) {
        d.send(res, 200, { sources: sourcesOf(cid), items: itemsOf(cid) });
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
      if (sub === 'items' && itemId && method === 'PUT') {
        const b = await d.bodyOf(req);
        const { item, problems } = checkItem((b.item ?? {}) as Row, itemId);
        if (!item) { d.send(res, 200, { status: 'rejected', problems }); return true; }
        const now = Date.now();
        d.run(`INSERT INTO content (id, campaign_id, data, by_user, rev, updated) VALUES (?, ?, ?, ?, 1, ?)
               ON CONFLICT(campaign_id, id) DO UPDATE SET data = excluded.data, by_user = excluded.by_user, rev = content.rev + 1, updated = excluded.updated`,
        itemId, cid, JSON.stringify(item), u.id, now);
        const r = d.one('SELECT rev FROM content WHERE campaign_id = ? AND id = ?', cid, itemId);
        d.send(res, 200, { status: 'done', item: { ...item, rev: Number(r?.rev ?? 1), updated: now } });
        return true;
      }
      if (sub === 'items' && itemId && method === 'DELETE') {
        d.run('DELETE FROM content WHERE campaign_id = ? AND id = ?', cid, itemId);
        d.send(res, 200, { status: 'done' });
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
        if (data.length > MAX_ITEM) throw d.fail(413, '太大了');
        d.run(`INSERT INTO monster_ai (monster_key, data, by_user, rev, updated) VALUES (?, ?, ?, 1, ?)
               ON CONFLICT(monster_key) DO UPDATE SET data = excluded.data, by_user = excluded.by_user, rev = monster_ai.rev + 1, updated = excluded.updated`, key, data, u.id, Date.now());
        d.send(res, 200, { status: 'done' });
        return true;
      }
    }
    return false;
  }

  return { handle, campaignRules };
}
