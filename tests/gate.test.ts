// 站点门禁（server/gate.ts）：密码、门禁 cookie、输错封 IP
import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type { IncomingMessage } from 'node:http';
import { BAN_HOURS, FAIL_WINDOW_MS, MAX_FAILS, createGate } from '../server/gate';

function setup() {
  const db = new DatabaseSync(':memory:');
  let t = 1_000_000;
  const gate = createGate({
    one: (sql, ...a) => db.prepare(sql).get(...a) as Record<string, unknown> | undefined,
    all: (sql, ...a) => db.prepare(sql).all(...a) as Record<string, unknown>[],
    run: (sql, ...a) => db.prepare(sql).run(...a),
    exec: (sql) => db.exec(sql),
    now: () => t,
  });
  const req = (ip: string, token?: string) =>
    ({ headers: { 'cf-connecting-ip': ip, ...(token ? { cookie: `x=1; dnd2_gate=${token}` } : {}) }, socket: {} }) as unknown as IncomingMessage;
  return { gate, req, tick: (ms: number) => { t += ms; } };
}

describe('站点门禁', () => {
  it('没设密码时谁都放行', () => {
    const { gate, req } = setup();
    expect(gate.enabled()).toBe(false);
    expect(gate.passed(req('1.1.1.1'))).toBe(true);
  });

  it('输对了发 cookie，带着 cookie 就放行；改密码后旧 cookie 作废', () => {
    const { gate, req } = setup();
    gate.setPassword('secret-1');
    expect(gate.passed(req('1.1.1.1'))).toBe(false);
    const r = gate.login('1.1.1.1', 'secret-1');
    expect(r.ok).toBe(true);
    const token = r.ok ? r.token : '';
    expect(gate.passed(req('1.1.1.1', token))).toBe(true);
    expect(gate.passed(req('1.1.1.1', 'made-up'))).toBe(false);
    gate.setPassword('secret-2');
    expect(gate.passed(req('1.1.1.1', token))).toBe(false);
  });

  it(`输错 ${MAX_FAILS} 次封 IP，封着时输对也不行，别的 IP 不受影响；到期解封`, () => {
    const { gate, req, tick } = setup();
    gate.setPassword('secret-1');
    for (let i = 1; i < MAX_FAILS; i++) {
      const r = gate.login('6.6.6.6', 'wrong');
      expect(r).toEqual({ ok: false, left: MAX_FAILS - i, bannedUntil: 0 });
    }
    const last = gate.login('6.6.6.6', 'wrong');
    expect(last.ok).toBe(false);
    expect(!last.ok && last.bannedUntil).toBeGreaterThan(0);
    expect(gate.login('6.6.6.6', 'secret-1').ok).toBe(false);
    expect(gate.bans().map((b) => b.ip)).toEqual(['6.6.6.6']);
    expect(gate.login('7.7.7.7', 'secret-1').ok).toBe(true);
    tick(BAN_HOURS * 3600_000 + 1);
    expect(gate.login('6.6.6.6', 'secret-1').ok).toBe(true);
  });

  it('封着的 IP 带着有效 cookie 也进不来；解封后恢复', () => {
    const { gate, req } = setup();
    gate.setPassword('secret-1');
    const r = gate.login('6.6.6.6', 'secret-1');
    const token = r.ok ? r.token : '';
    for (let i = 0; i < MAX_FAILS; i++) gate.login('6.6.6.6', 'wrong');
    expect(gate.passed(req('6.6.6.6', token))).toBe(false);
    gate.unban('6.6.6.6');
    expect(gate.passed(req('6.6.6.6', token))).toBe(true);
  });

  it('输错的次数一小时后重新算；输对清零', () => {
    const { gate, tick } = setup();
    gate.setPassword('secret-1');
    for (let i = 0; i < MAX_FAILS - 1; i++) gate.login('6.6.6.6', 'wrong');
    tick(FAIL_WINDOW_MS + 1);
    expect(gate.login('6.6.6.6', 'wrong')).toMatchObject({ left: MAX_FAILS - 1 });
    gate.login('6.6.6.6', 'secret-1');
    expect(gate.login('6.6.6.6', 'wrong')).toMatchObject({ left: MAX_FAILS - 1 });
  });
});
