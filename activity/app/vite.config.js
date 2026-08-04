import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: __dirname,
  // 相對路徑：Discord 的 /.proxy/ 只重寫文件路徑前綴，
  // 若資源用根路徑 (/assets/x.js) 在真的 Discord 裡會 404
  base: './',
  plugins: [vue()],
  build: {
    outDir: path.resolve(__dirname, '../public'),
    emptyOutDir: true,
    assetsDir: 'assets',
  },
  server: {
    port: 5173,
    proxy: {
      // API 走 activity-server.js；Skin/Sounds 是 helper.js 用相對路徑 fetch 的共用素材，
      // 正式環境由 activity-server.js 的 engine/ fallback 提供，dev 模式下一併代理過去
      '/api': { target: `http://localhost:${process.env.ACTIVITY_PORT ?? 3000}`, changeOrigin: true },
      '/Skin': { target: `http://localhost:${process.env.ACTIVITY_PORT ?? 3000}`, changeOrigin: true },
      '/Sounds': { target: `http://localhost:${process.env.ACTIVITY_PORT ?? 3000}`, changeOrigin: true },
    },
  },
});
