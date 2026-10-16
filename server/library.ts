/**
 * 账户资料库（LIBRARY.md 第二、三、四节）：条目归账户所有，可以挂到自己所在的战役。
 *
 * 服务器只存、只做结构检查，不跑引擎：
 * - `library`：一条 = 一份资源（LibraryItem，可以拆成多条 part）；
 * - `library_share`：挂到哪个战役、DM 开关的结果。
 *
 * 权限：新内容（不覆盖官方键）挂上就生效；覆盖官方键的要 DM 在战役页开关。
 * 每个人自己的库对自己永远生效——所以自己的卡和服务器的战斗不会打架。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HouseRule } from '../src/combat';
import {
  checkItem, houseRulesFor, houseRulesOf, shareStateOf,
  type LibraryItem, type ShareState, type ShareView,
} from '../src/library';
import type { Deps } from './encounters';

interface User { id: number; name: string }
type Row = Record<string, unknown>;

export function createLibrary(d: Deps) {
  d.exec(`
    DROP TABLE IF EXISTS content;
    CREATE TABLE IF NOT EXISTS library (
      id TEXT NOT NULL,
      owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      data TEXT NOT NULL, by_user INTEGER NOT NULL, rev INTEGER NOT NULL, updated INTEGER NOT NULL,
      PRIMARY KEY (owner_id, id)
    );
    CREATE INDEX IF NOT EXISTS library_owner ON library(owner_id);
    CREATE TABLE IF NOT EXISTS library_share (
      owner_id INTEGER NOT NULL,
      item_id TEXT NOT NULL,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      state TEXT NOT NULL CHECK (state IN ('auto', 'pending', 'on', 'off')),
      by_user INTEGER NOT NULL, updated INTEGER NOT NULL,
      PRIMARY KEY (owner_id, item_id, campaign_id),
      FOREIGN KEY (owner_id, item_id) REFERENCES library(owner_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS library_share_camp ON library_share(campaign_id);
  `);

  /* ───────── 读 ───────── */

  const parse = (r: Row): LibraryItem => ({ ...JSON.parse(String(r.data)), rev: Number(r.rev), updated: Number(r.updated) });

  /** 某个账户的全部内容（新的在前） */
  function itemsOf(ownerId: number): LibraryItem[] {
    return d.all('SELECT data, rev, updated FROM library WHERE owner_id = ? ORDER BY updated DESC', ownerId).map(parse);
  }
  function itemOf(ownerId: number, id: string): LibraryItem | null {
    const r = d.one('SELECT data, rev, updated FROM library WHERE owner_id = ? AND id = ?', ownerId, id);
    return r ? parse(r) : null;
  }

  /** 一个战役挂上来的全部内容（含待审、关掉的），DM 面板用 */
  function attachedOf(campaignId: string): ShareView[] {
    return d.all(`
      SELECT s.owner_id, s.item_id, s.state, s.updated, l.data, l.rev, u.name AS owner_name
      FROM library_share s
      JOIN library l ON l.owner_id = s.owner_id AND l.id = s.item_id
      JOIN users u ON u.id = s.owner_id
      WHERE s.campaign_id = ?
      ORDER BY s.updated, s.owner_id`, campaignId).map((r) => ({
      ownerId: Number(r.owner_id), ownerName: String(r.owner_name), itemId: String(r.item_id),
      item: parse(r), state: String(r.state) as ShareState, updated: Number(r.updated),
    }));
  }

  /** 战役里生效的内容：新内容（auto）+ DM 开着的覆盖（on） */
  const effectiveItems = (campaignId: string): LibraryItem[] =>
    attachedOf(campaignId).filter((s) => s.state === 'auto' || s.state === 'on').map((s) => s.item);

  /** 开遭遇时抄进遭遇的战斗部分 */
  const campaignRules = (campaignId: string): HouseRule[] => houseRulesFor(effectiveItems(campaignId));

  /** 某个账户自己的库的战斗部分（参战者各自的卡用） */
  const rulesOfOwner = (ownerId: number): HouseRule[] => itemsOf(ownerId).flatMap(houseRulesOf);

  /** 成员退团 / 被请出：把这个人在这个战役里挂的东西摘掉（内容还在他自己的库里） */
  const detachAll = (campaignId: string, ownerId: number): void => {
    d.run('DELETE FROM library_share WHERE campaign_id = ? AND owner_id = ?', campaignId, ownerId);
  };

  /* ───────── 写 ───────── */

  /** 挂到战役：覆盖官方键的默认「待审」，DM 自己挂的直接开 */
  function share(u: User, campaignId: string, itemId: string): ShareState {
    const item = itemOf(u.id, itemId);
    if (!item) throw d.fail(404, '库里没有这条');
    const base = shareStateOf(item);
    const state: ShareState = base === 'pending' && d.roleIn(u, campaignId) === 'dm' ? 'on' : base;
    const now = Date.now();
    d.run(`INSERT INTO library_share (owner_id, item_id, campaign_id, state, by_user, updated) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(owner_id, item_id, campaign_id) DO UPDATE SET state = excluded.state, by_user = excluded.by_user, updated = excluded.updated`,
    u.id, itemId, campaignId, state, u.id, now);
    return state;
  }

  async function handle(req: IncomingMessage, res: ServerResponse, u: User, path: string, method: string): Promise<boolean> {
    if (method === 'GET' && path === '/api/library') {
      d.send(res, 200, { items: itemsOf(u.id) });
      return true;
    }

    let hit = path.match(/^\/api\/library\/items\/([\w-]{1,40})$/);
    if (hit && (method === 'PUT' || method === 'DELETE')) {
      const id = hit[1];
      if (method === 'DELETE') {
        d.run('DELETE FROM library WHERE owner_id = ? AND id = ?', u.id, id);
        d.send(res, 200, { status: 'done' });
        return true;
      }
      const b = await d.bodyOf(req);
      const { item, problems } = checkItem((b.item ?? {}) as Row, id);
      if (!item) { d.send(res, 200, { status: 'rejected', problems }); return true; }
      const now = Date.now();
      d.run(`INSERT INTO library (id, owner_id, data, by_user, rev, updated) VALUES (?, ?, ?, ?, 1, ?)
             ON CONFLICT(owner_id, id) DO UPDATE SET data = excluded.data, by_user = excluded.by_user, rev = library.rev + 1, updated = excluded.updated`,
      id, u.id, JSON.stringify(item), u.id, now);
      // 改完之后「覆盖了什么」可能变了：自动 / 待审跟着重算，DM 开过关过的不动
      const state = shareStateOf(item);
      d.run(`UPDATE library_share SET state = ? WHERE owner_id = ? AND item_id = ? AND state IN ('auto', 'pending')`, state, u.id, id);
      const r = d.one('SELECT rev FROM library WHERE owner_id = ? AND id = ?', u.id, id);
      d.send(res, 200, { status: 'done', item: { ...item, rev: Number(r?.rev ?? 1), updated: now } });
      return true;
    }

    hit = path.match(/^\/api\/library\/items\/([\w-]{1,40})\/(share|unshare)$/);
    if (hit && method === 'POST') {
      const [, itemId, op] = hit;
      const b = await d.bodyOf(req);
      const cid = String(b.campaignId ?? '');
      if (!d.roleIn(u, cid)) throw d.fail(403, '你不在这个战役里');
      if (op === 'unshare') {
        d.run('DELETE FROM library_share WHERE owner_id = ? AND item_id = ? AND campaign_id = ?', u.id, itemId, cid);
        d.send(res, 200, { status: 'done' });
        return true;
      }
      d.send(res, 200, { status: 'done', state: share(u, cid, itemId) });
      return true;
    }

    // DM 的开关：把某个人挂上来的某条内容，在这个战役里打开 / 关掉
    hit = path.match(/^\/api\/campaigns\/([\w-]{1,64})\/library\/state$/);
    if (hit && method === 'POST') {
      const cid = hit[1];
      if (d.roleIn(u, cid) !== 'dm') throw d.fail(403, '只有 DM 能开关战役里的内容');
      const b = await d.bodyOf(req);
      const state = String(b.state ?? '');
      if (state !== 'on' && state !== 'off') throw d.fail(400, 'state 只能是 on / off');
      const ownerId = Number(b.ownerId);
      const itemId = String(b.itemId ?? '');
      const cur = d.one('SELECT state FROM library_share WHERE owner_id = ? AND item_id = ? AND campaign_id = ?', ownerId, itemId, cid);
      if (!cur) throw d.fail(404, '这个战役没有挂这条内容');
      d.run('UPDATE library_share SET state = ?, by_user = ?, updated = ? WHERE owner_id = ? AND item_id = ? AND campaign_id = ?',
        state, u.id, Date.now(), ownerId, itemId, cid);
      d.send(res, 200, { status: 'done', state });
      return true;
    }

    return false;
  }

  return { handle, itemsOf, itemOf, attachedOf, effectiveItems, campaignRules, rulesOfOwner, detachAll };
}
