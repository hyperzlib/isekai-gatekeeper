import { hmacSha256Hex, sha256Bytes, hexToBuf } from "../utils/crypto.ts";
import type { BrowserChallengeConfig } from "../types/config.ts";

export interface ChallengePayload {
  challenge: string;
  expires: number;
  token: string;
  difficulty: number;
}

/**
 * 生成 PoW 挑战。
 * token = HMAC-SHA256(challenge + ":" + expires, secret)
 */
export async function generateChallenge(cfg: BrowserChallengeConfig): Promise<ChallengePayload> {
  const challengeBytes = crypto.getRandomValues(new Uint8Array(16));
  const challenge = Array.from(challengeBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const expires = Math.floor(Date.now() / 1000) + cfg.challenge_ttl;
  const token = await hmacSha256Hex(`${challenge}:${expires}`, cfg.secret);
  return { challenge, expires, token, difficulty: cfg.pow.difficulty };
}

/**
 * 校验挑战 token 是否合法且未过期。
 */
export async function verifyChallengeToken(
  challenge: string,
  expires: number,
  token: string,
  secret: string,
): Promise<boolean> {
  if (Math.floor(Date.now() / 1000) > expires) return false;
  const expected = await hmacSha256Hex(`${challenge}:${expires}`, secret);
  // 恒定时间比较
  if (expected.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * 验证工作量证明。
 * SHA-256(challenge_bytes || nonce_big_endian_4B) 前 difficulty bit 全为 0。
 */
export async function verifyPow(
  challenge: string,
  nonce: number,
  difficulty: number,
): Promise<boolean> {
  const challengeBytes = hexToBuf(challenge);
  const nonceBuf = new Uint8Array(4);
  new DataView(nonceBuf.buffer).setUint32(0, nonce >>> 0, false); // big-endian

  const combined = new Uint8Array(challengeBytes.length + 4);
  combined.set(challengeBytes, 0);
  combined.set(nonceBuf, challengeBytes.length);

  const hash = await sha256Bytes(combined);
  return checkLeadingZeroBits(hash, difficulty);
}

function checkLeadingZeroBits(hash: Uint8Array, difficulty: number): boolean {
  const fullBytes = Math.floor(difficulty / 8);
  const remainBits = difficulty % 8;

  for (let i = 0; i < fullBytes; i++) {
    if ((hash[i] ?? 0xff) !== 0) return false;
  }
  if (remainBits > 0) {
    const mask = 0xff << (8 - remainBits) & 0xff;
    if (((hash[fullBytes] ?? 0xff) & mask) !== 0) return false;
  }
  return true;
}
