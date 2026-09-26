// vitest 以 Node 全局运行，Node 24 的 WebCrypto SubtleCrypto 没有 timingSafeEqual；
// Workers(workerd) 运行时生产环境有（官方示例 protect-against-timing-attacks）。
// 此处仅为测试环境用 node:crypto 的恒定时间比较补上同一 API。
import { timingSafeEqual as nodeTSE } from 'node:crypto';

const subtle = globalThis.crypto?.subtle;
if (subtle && typeof subtle.timingSafeEqual !== 'function') {
  const toBuffer = (v) =>
    v instanceof ArrayBuffer
      ? Buffer.from(v)
      : Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  Object.defineProperty(subtle, 'timingSafeEqual', {
    value: (a, b) => nodeTSE(toBuffer(a), toBuffer(b)),
    configurable: true,
    writable: true,
  });
}
