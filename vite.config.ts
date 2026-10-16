import { cpSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/**
 * 本地数据缓存（npm run fetch:data）：
 * - 开发时挂在 /5etools/ 下，省得每次都去站点取；
 * - 构建时复制进 dist/5etools/，部署后和页面放在一起（站点数据不保证允许跨域取）。
 */
function localData(): Plugin {
  const dir = resolve(import.meta.dirname, 'data', '5etools');
  let outDir = 'dist';
  return {
    name: 'local-5etools',
    configResolved(c) { outDir = resolve(c.root, c.build.outDir); },
    closeBundle() {
      if (existsSync(dir)) cpSync(dir, resolve(outDir, '5etools'), { recursive: true });
      else this.warn('没有 data/5etools（先 npm run fetch:data）：部署后的页面只能直接去站点取数据');
    },
    configureServer(server) {
      server.middlewares.use('/5etools', (req, res, next) => {
        const file = resolve(dir, '.' + decodeURIComponent((req.url || '').split('?')[0]));
        if (!file.startsWith(dir) || !existsSync(file)) return next();
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(readFileSync(file));
      });
    },
  };
}

/** 命令行的 --port（vite 自己也认它） */
const argPort = (() => { const i = process.argv.indexOf('--port'); return i > 0 ? Number(process.argv[i + 1]) : NaN; })();
const UI_PORT = Number.isFinite(argPort) ? argPort : Number(process.env.VITE_PORT ?? 5280);
const API_PORT = Number(process.env.API_PORT ?? 8789 + (UI_PORT - 5280));

export default defineConfig({
  // 相对路径：构建产物放在任何子路径下都能用（线上在 /v2/）
  base: './',
  plugins: [react(), localData()],
  // 后端（server/main.ts，默认 8789）：开发时把 /api 转过去。
  // 几个 worktree 同时开发：`npx vite --port 5281` 配 `npx tsx server/main.ts --port 8790`（界面端口 +1，后端端口跟着 +1）；
  // 也可以用环境变量 VITE_PORT / API_PORT。
  server: { port: UI_PORT, proxy: { '/api': `http://127.0.0.1:${API_PORT}` } },
});
