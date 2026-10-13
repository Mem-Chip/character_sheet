/** Node 下的数据提供者：从本地缓存目录读（tools/fetch-data.ts 抓下来的那一份） */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DataProvider } from './store';

export const DEFAULT_DATA_DIR = resolve(import.meta.dirname, '..', '..', 'data', '5etools');

export function dirProvider(dir = DEFAULT_DATA_DIR): DataProvider {
  return {
    async load(path: string) {
      const file = resolve(dir, '.' + path);
      if (!existsSync(file)) throw new Error(`本地没有 ${path}（先跑 npm run fetch:data）`);
      return JSON.parse(readFileSync(file, 'utf8'));
    },
  };
}

export const hasLocalData = (dir = DEFAULT_DATA_DIR) => existsSync(resolve(dir, 'data', 'races.json'));
