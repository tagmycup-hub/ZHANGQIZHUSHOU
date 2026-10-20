import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig(({ mode }) => ({
  base: './',
  plugins: mode === 'single' ? [react(), viteSingleFile()] : [react()],
  // artifact：发布为 Claude 页面（多文件、不注册 Service Worker）
  define: { __SINGLE__: JSON.stringify(mode === 'single' || mode === 'artifact') },
  build: mode === 'single' ? { outDir: 'dist-single', assetsInlineLimit: 100000000 } : mode === 'artifact' ? { outDir: 'dist-artifact' } : { outDir: 'dist' },
  server: { proxy: { '/api': 'http://localhost:8787' } },
  test: { environment: 'node', include: ['tests/**/*.test.ts'], testTimeout: 15000 },
}));
