import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./test/setup.js'],
    // routes.test.ts 走 unstable_dev + 真网络（含新增的 favicon.im 探测，单次约 1s），
    // 默认 5s 会被拖爆；统一给 15s 余量。
    testTimeout: 15000,
  },
});
