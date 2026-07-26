import { describe, expect, it } from "bun:test";
import { getRequestHostCandidates, normalizeConfiguredHostname } from "../../src/utils/host.ts";

describe("host utilities", () => {
  it("normalizes configured hostnames without dropping ports", () => {
    expect(normalizeConfiguredHostname("Example.COM:8080")).toBe("example.com:8080");
  });

  it("uses explicit request ports as the primary lookup key", () => {
    expect(getRequestHostCandidates("Example.COM:8080", "http")).toEqual(["example.com:8080"]);
  });

  it("tries the bare hostname before the default HTTP port", () => {
    expect(getRequestHostCandidates("Example.COM", "http")).toEqual(["example.com", "example.com:80"]);
  });

  it("tries the bare hostname before the default HTTPS port", () => {
    expect(getRequestHostCandidates("Example.COM", "https")).toEqual(["example.com", "example.com:443"]);
  });

  it("falls back from explicit standard ports after the bare hostname", () => {
    expect(getRequestHostCandidates("Example.COM:80", "http")).toEqual(["example.com", "example.com:80"]);
    expect(getRequestHostCandidates("Example.COM:443", "https")).toEqual(["example.com", "example.com:443"]);
  });
});
