/**
 * PCM 音频包的拼接与传输编码（AI 语音输入 / 语音会话共用）。
 *
 * 两条链路都以 AudioWorklet 的 16k Int16 包为原料、攒够 200ms 交给 ASR；
 * 拼接与 base64 只该有一份实现 —— 任一份改错（例如 base64 分块大小）都会让
 * 另一条链路出现「偶尔识别不出」的幽灵缺陷。
 */

/** 顺序拼接多段 Int16 PCM */
export function mergeInt16(parts: Int16Array[]): Int16Array {
  const total = parts.reduce((s, p) => s + p.length, 0)
  const out = new Int16Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

/** Int16 PCM → base64（Rust 侧按 raw PCM 解码） */
export function int16ToB64(arr: Int16Array): string {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength)
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)))
  }
  return btoa(bin)
}
