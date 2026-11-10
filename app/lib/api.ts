/**
 * 后端接口（server/main.ts）。接口在页面旁边的 api/（线上页面在根目录，就是 /api/）；开发时 vite 把 /api 转给本机后端。
 * 登录靠 httpOnly 的会话 cookie，这里不碰令牌。
 */
export interface User { id: number; name: string }

export class ApiError extends Error {
  status: number;
  data: Record<string, unknown>;
  constructor(status: number, message: string, data: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

const base = () => new URL('api/', document.baseURI).pathname;

export async function api<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(base() + path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, '连不上服务器', {});
  }
  const data = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) throw new ApiError(res.status, String(data.error ?? `出错了（${res.status}）`), data);
  return data as T;
}

export interface ServerCard {
  id: string;
  rev: number;
  updated: number;
  deleted: boolean;
  owner: User;
  campaignId: string | null;
  char: Record<string, unknown> | null;
}

export interface Campaign {
  id: string;
  name: string;
  ownerId: number;
  role: 'dm' | 'player';
  code?: string;
  members: Array<{ id: number; name: string; role: 'dm' | 'player' }>;
  cards: Array<{ id: string; ownerId: number; ownerName: string; name: string; dmControlled?: boolean; summary: string }>;
}
