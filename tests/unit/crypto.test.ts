import { describe, it, expect } from "bun:test";
import { hmacSha256Hex, timingSafeEqual, hexToBuf, bufToHex } from "../../src/utils/crypto.ts";

describe("crypto utilities", () => {
  it("hmacSha256Hex produces consistent output", async () => {
    const a = await hmacSha256Hex("hello", "secret");
    const b = await hmacSha256Hex("hello", "secret");
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  it("hmacSha256Hex differs for different inputs", async () => {
    const a = await hmacSha256Hex("hello", "secret");
    const b = await hmacSha256Hex("world", "secret");
    expect(a).not.toBe(b);
  });

  it("timingSafeEqual returns true for identical strings", () => {
    expect(timingSafeEqual("abc123", "abc123")).toBe(true);
  });

  it("timingSafeEqual returns false for different strings", () => {
    expect(timingSafeEqual("abc123", "abc124")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
  });

  it("hexToBuf / bufToHex round-trip", () => {
    const hex = "deadbeefcafebabe";
    const buf = hexToBuf(hex);
    expect(bufToHex(buf)).toBe(hex);
  });
});
