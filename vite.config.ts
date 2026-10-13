import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/** 开发时把本地数据缓存（npm run fetch:data）挂在 /5etools/ 下，省得每次都去站点取 */
function localData(): Plugin {
  const dir = resolve(import.meta.dirname, 'data', '5etools');
  return {
    name: 'local-5etools',
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

export default defineConfig({
  plugins: [react(), localData()],
  server: { port: 5280 },
});
