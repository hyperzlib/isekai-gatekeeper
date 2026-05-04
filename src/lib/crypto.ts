/**
 * 基于 Bun 内置 crypto 的 HMAC-SHA256 / SHA-256 工具函数。
 */

/**
 * 计算 HMAC-SHA256(data, secret)，返回十六进制字符串。
 */
export async function hmacSha256Hex(data: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", keyMaterial, enc.encode(data));
  return bufToHex(new Uint8Array(sig));
}

/**
 * 计算 SHA-256(data)，返回 Uint8Array。
 */
export async function sha256Bytes(data: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(digest);
}

/**
 * Uint8Array → 十六进制字符串。
 */
export function bufToHex(buf: Uint8Array): string {
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * 十六进制字符串 → Uint8Array。
 */
export function hexToBuf(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("Invalid hex string");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * 恒定时间比较两个字符串，防止时序攻击。
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
