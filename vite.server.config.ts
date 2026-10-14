import { defineConfig } from 'vite';

/**
 * 后端打包：server/main.ts + 它用到的战斗引擎（src/combat）和规则数据，打成一个 dist-server/main.js。
 * Node 自带的模块（node:http、node:sqlite…）不打进去。部署只传这一个文件。
 */
export default defineConfig({
  build: {
    ssr: 'server/main.ts',
    outDir: 'dist-server',
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    rollupOptions: { output: { entryFileNames: 'main.js' } },
  },
  ssr: { noExternal: true },
});
