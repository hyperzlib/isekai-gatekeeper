import { describe, expect, it } from "bun:test";
import path from "node:path";

type GatekeeperProcess = {
  process: Bun.Subprocess<"inherit", "pipe", "pipe">;
  logs: string;
  readyPromise: Promise<void>;
};

const PROXY_PORT = 19080;
const API_PORT = 19081;
const UPSTREAM_PORT = 19090;

const PROJECT_ROOT = path.resolve(import.meta.dir, "..", "..");
const TEST_CONFIG_PATH = path.join(PROJECT_ROOT, "tests", "config.toml");

function withTimeout<T>(promise: Promise<T>, ms: number, reason: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(reason)), ms);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function readStream(stream: ReadableStream<Uint8Array>, onChunk: (text: string) => void): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();

  return (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      onChunk(decoder.decode(value, { stream: true }));
    }
    onChunk(decoder.decode());
  })();
}

function waitForGatekeeperReady(state: { logs: string; process: GatekeeperProcess["process"] }): Promise<void> {
  return new Promise((resolve, reject) => {
    const checkReady = () => {
      const proxyReady = state.logs.includes("[proxy] Listening on port");
      const apiReady = state.logs.includes("[api] Listening on port");
      if (proxyReady && apiReady) {
        resolve();
      }
    };

    const interval = setInterval(() => {
      if (state.process.exitCode !== null) {
        clearInterval(interval);
        reject(new Error(`isekai-gatekeeper exited before ready. Logs:\n${state.logs}`));
        return;
      }
      checkReady();
    }, 50);

    setTimeout(() => {
      clearInterval(interval);
      reject(new Error(`Timed out waiting for startup logs. Logs:\n${state.logs}`));
    }, 20_000);

    checkReady();
  });
}

function startGatekeeper(): GatekeeperProcess {
  const child = Bun.spawn({
    cmd: ["bun", "start"],
    cwd: PROJECT_ROOT,
    env: {
      ...globalThis.process.env,
      CONFIG_PATH: TEST_CONFIG_PATH,
    },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "inherit",
  });

  const state = { logs: "", process: child };

  void readStream(child.stdout, (text) => {
    state.logs += text;
  });
  void readStream(child.stderr, (text) => {
    state.logs += text;
  });

  return {
    process: child,
    get logs() {
      return state.logs;
    },
    readyPromise: waitForGatekeeperReady(state),
  };
}

async function stopGatekeeper(proc: GatekeeperProcess): Promise<void> {
  if (proc.process.exitCode !== null) return;

  proc.process.kill("SIGTERM");

  try {
    await withTimeout(proc.process.exited, 5_000, "Timed out waiting for gatekeeper process to exit");
  } catch {
    proc.process.kill("SIGKILL");
    await withTimeout(proc.process.exited, 2_000, "Timed out waiting for forced gatekeeper exit");
  }
}

async function fetchViaProxy(pathname: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("host", "test.local");

  return fetch(`http://127.0.0.1:${PROXY_PORT}${pathname}`, {
    ...init,
    headers,
  });
}

describe("proxy + upstream integration", () => {
  it(
    "covers normal access, challenge interception, cache lifecycle, and file upload",
    async () => {
      let cacheCounter = 0;
      let blockedCounter = 0;

      const upstream = Bun.serve({
        port: UPSTREAM_PORT,
        fetch: async (req) => {
          const url = new URL(req.url);

          if (url.pathname === "/open") {
            return new Response("open-ok", {
              status: 200,
              headers: { "content-type": "text/plain" },
            });
          }

          if (url.pathname === "/cache") {
            cacheCounter += 1;
            return new Response(`cache-count:${cacheCounter}`, {
              status: 200,
              headers: { "content-type": "text/plain" },
            });
          }

          if (url.pathname === "/upload" && req.method === "POST") {
            const form = await req.formData();
            const file = form.get("file");
            if (!(file instanceof File)) {
              return new Response(JSON.stringify({ error: "missing file" }), {
                status: 400,
                headers: { "content-type": "application/json" },
              });
            }

            const text = await file.text();
            return new Response(
              JSON.stringify({
                filename: file.name,
                size: file.size,
                text,
              }),
              {
                status: 200,
                headers: { "content-type": "application/json" },
              },
            );
          }

          if (url.pathname === "/blocked") {
            blockedCounter += 1;
          }

          return new Response(`upstream:${url.pathname}`, {
            status: 200,
            headers: { "content-type": "text/plain" },
          });
        },
      });

      const gatekeeper = startGatekeeper();

      try {
        await withTimeout(gatekeeper.readyPromise, 20_000, "gatekeeper startup timeout");

        // 正常页面访问
        const openResp = await fetchViaProxy("/open");
        expect(openResp.status).toBe(200);
        expect(await openResp.text()).toBe("open-ok");

        // 访问拦截（挑战页）
        const blockedResp = await fetchViaProxy("/blocked");
        const blockedBody = await blockedResp.text();
        expect(blockedResp.status).toBe(403);
        expect(blockedBody.includes("challenge-config")).toBe(true);
        expect(blockedCounter).toBe(0);

        // 缓存：初次请求
        const cacheFirstResp = await fetchViaProxy("/cache");
        const cacheFirstBody = await cacheFirstResp.text();
        expect(cacheFirstResp.status).toBe(200);
        expect(cacheFirstBody).toBe("cache-count:1");

        // 缓存：命中缓存
        const cacheHitResp = await fetchViaProxy("/cache");
        const cacheHitBody = await cacheHitResp.text();
        expect(cacheHitResp.status).toBe(200);
        expect(cacheHitBody).toBe("cache-count:1");
        expect((cacheHitResp.headers.get("x-cache") ?? "").toUpperCase()).toBe("HIT");

        // 缓存：通过 API 清理
        const clearResp = await fetch(`http://127.0.0.1:${API_PORT}/api/v1/delete_cache`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": "test-api-key",
          },
          body: JSON.stringify({
            url: "http://test.local/cache",
          }),
        });
        expect(clearResp.status).toBe(200);

        const clearJson = (await clearResp.json()) as { deleted?: number };
        expect((clearJson.deleted ?? 0) >= 1).toBe(true);

        const cacheAfterClearResp = await fetchViaProxy("/cache");
        const cacheAfterClearBody = await cacheAfterClearResp.text();
        expect(cacheAfterClearResp.status).toBe(200);
        expect(cacheAfterClearBody).toBe("cache-count:2");

        // 文件上传
        const form = new FormData();
        form.append("file", new File(["hello-upload"], "hello.txt", { type: "text/plain" }));

        const uploadResp = await fetchViaProxy("/upload", {
          method: "POST",
          body: form,
        });

        expect(uploadResp.status).toBe(200);
        const uploadJson = (await uploadResp.json()) as {
          filename: string;
          size: number;
          text: string;
        };
        expect(uploadJson.filename).toBe("hello.txt");
        expect(uploadJson.size).toBe(12);
        expect(uploadJson.text).toBe("hello-upload");
      } finally {
        await stopGatekeeper(gatekeeper);
        await upstream.stop(true);
      }
    },
    90_000,
  );
});
