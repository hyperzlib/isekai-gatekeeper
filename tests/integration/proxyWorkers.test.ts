import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BunRedisCacheStore } from "../../src/lib/bunRedisCacheStore.ts";

const root = path.resolve(import.meta.dir, "..", "..");

async function until(predicate: () => boolean, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for worker startup");
    await Bun.sleep(50);
  }
}

describe("ProxyApp worker processes", () => {
  it("starts Windows and macOS worker ports, keeps ApiApp in the parent, and restarts a stopped worker", async () => {
    if (process.platform !== "win32" && process.platform !== "darwin") return;

    // Startup needs Redis PING. Requests below do not use cache or rate limiting.
    let redisCommands = "";
    const redis = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket, data) {
          const command = data.toString();
          redisCommands += command;
          if (command.includes("HELLO")) {
            socket.write("%7\r\n+server\r\n+redis\r\n+version\r\n+7.0.0\r\n+proto\r\n:3\r\n+id\r\n:1\r\n+mode\r\n+standalone\r\n+role\r\n+master\r\n+modules\r\n*0\r\n");
          } else {
            socket.write("+PONG\r\n");
          }
        },
        open() {},
        close() {},
        error() {},
      },
    });
    const directory = await mkdtemp(path.join(tmpdir(), "gatekeeper-workers-"));
    const configPath = path.join(directory, "config.ts");
    const source = await readFile(path.join(root, "tests", "config.ts"), "utf8");
    await writeFile(configPath, source
      .replace("server_port: 19080", "server_port: 19180, workers: 2")
      .replace("server_port: 19081", "server_port: 19182")
      .replace('provider: "memory",', `provider: "bun+redis", bun_redis: { url: "redis://127.0.0.1:${redis.port}" },`));

    const child = Bun.spawn({
      cmd: [process.execPath, path.join(root, "src", "main.ts")],
      cwd: root,
      env: { ...process.env, CONFIG_PATH: configPath },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      windowsHide: true,
    });
    let logs = "";
    const collect = async (stream: ReadableStream<Uint8Array>) => {
      for await (const chunk of stream) logs += new TextDecoder().decode(chunk);
    };
    const stdout = collect(child.stdout);
    const stderr = collect(child.stderr);
    try {
      await until(() => logs.includes("[api] Listening on port 19182") || child.exitCode !== null);
      if (child.exitCode !== null) throw new Error(`Gatekeeper exited before ready:\n${logs}\nRedis:\n${redisCommands}`);
      expect(child.exitCode).toBeNull();
      expect(logs).toContain("Worker 0 ready on port 19180");
      expect(logs).toContain("Worker 1 ready on port 19181");
      for (const port of [19180, 19181]) {
        const response = await fetch(`http://127.0.0.1:${port}/open`, { headers: { host: "test.local" } });
        expect(response.status).toBe(502);
      }
      const apiResponse = await fetch("http://127.0.0.1:19182/api/v1/list_cached_pages", { method: "POST" });
      expect(apiResponse.status).toBe(401);

      const pid = Number(logs.match(/Worker 1 ready on port 19181 \(pid (\d+)\)/)?.[1]);
      expect(Number.isSafeInteger(pid)).toBe(true);
      process.kill(pid, "SIGTERM");
      await until(() => (logs.match(/Worker 1 ready on port 19181/g) ?? []).length === 2);
      const restarted = await fetch("http://127.0.0.1:19181/open", { headers: { host: "test.local" } });
      expect(restarted.status).toBe(502);
    } catch (error) {
      throw new Error(`${error}\nLogs:\n${logs}\nRedis:\n${redisCommands}`);
    } finally {
      child.kill("SIGTERM");
      await Promise.race([child.exited, Bun.sleep(5_000)]);
      if (child.exitCode === null) child.kill("SIGKILL");
      await Promise.allSettled([stdout, stderr]);
      redis.stop();
      await rm(directory, { recursive: true, force: true });
    }
  }, 110_000);

  const redisUrl = process.env["ISEKAI_TEST_REDIS_URL"];
  (redisUrl ? it : it.skip)("shares cache and rate limits across workers through Redis", async () => {
    if (process.platform !== "win32" && process.platform !== "darwin" && process.platform !== "linux") return;
    const linux = process.platform === "linux";
    const secondPort = linux ? 19380 : 19381;
    const siteId = `worker${Date.now()}`;
    const requestIp = `203.0.113.${Math.floor(Math.random() * 254) + 1}`;
    const directory = await mkdtemp(path.join(tmpdir(), "gatekeeper-real-redis-"));
    const configPath = path.join(directory, "config.ts");
    const source = await readFile(path.join(root, "tests", "config.ts"), "utf8");
    await writeFile(configPath, source
      .replace("server_port: 19080", "server_port: 19380, workers: 2")
      .replace("server_port: 19081", "server_port: 19382")
      .replace("127.0.0.1:19090", "127.0.0.1:19390")
      .replace("    test: {", `    ${siteId}: {`)
      .replace('provider: "memory",', `provider: "bun+redis", bun_redis: { url: ${JSON.stringify(redisUrl)} },`)
      .replace('id: "allow-open",', `id: "worker-pid",
          condition: ({ ctx }) => ctx.req.path === "/worker",
          return: { status: 200, text: String(process.pid) },
        },
        {
          id: "shared-limit",
          condition: async ({ ctx, rateLimit }) => ctx.req.path === "/limited" && await rateLimit.isLimited("ip", 1, 300),
          return: { status: 429, text: "limited" },
        },
        {
          id: "allow-limited",
          condition: ({ ctx }) => ctx.req.path === "/limited",
          browser_challenge: { enabled: false },
          cache: { enabled: false },
          last: true,
        },
        {
          id: "allow-open",`));
    let cacheCounter = 0;
    const upstream = Bun.serve({
      port: 19390,
      fetch(request) {
        if (new URL(request.url).pathname === "/cache") {
          return new Response(`cache-count:${++cacheCounter}`, { headers: { "content-type": "text/plain" } });
        }
        return new Response("allowed", { headers: { "content-type": "text/plain" } });
      },
    });
    const child = Bun.spawn({
      cmd: [process.execPath, path.join(root, "src", "main.ts")],
      cwd: root,
      env: { ...process.env, CONFIG_PATH: configPath },
      stdout: "pipe", stderr: "pipe", stdin: "ignore", windowsHide: true,
    });
    let logs = "";
    const collect = async (stream: ReadableStream<Uint8Array>) => {
      for await (const chunk of stream) logs += new TextDecoder().decode(chunk);
    };
    const stdout = collect(child.stdout);
    const stderr = collect(child.stderr);
    const proxyFetch = (port: number, pathname: string) => fetch(`http://127.0.0.1:${port}${pathname}`, {
      headers: { host: "test.local", "x-forwarded-for": requestIp },
    });
    try {
      await until(() => logs.includes("[api] Listening on port 19382") || child.exitCode !== null);
      if (child.exitCode !== null) throw new Error(`Gatekeeper exited before ready:\n${logs}`);
      if (linux) {
        expect(logs).toContain("Worker 0 ready on port 19380");
        expect(logs).toContain("Worker 1 ready on port 19380");
        const workers = new Set(await Promise.all(Array.from({ length: 32 }, async (_, index) => {
          const response = await fetch(`http://127.0.0.1:19380/worker?request=${index}`, {
            headers: { host: "test.local", connection: "close" },
          });
          expect(response.status).toBe(200);
          return response.text();
        })));
        expect(workers.size).toBe(2);
      }
      const first = await proxyFetch(19380, "/cache");
      expect(await first.text()).toBe("cache-count:1");
      const second = await proxyFetch(secondPort, "/cache");
      expect(await second.text()).toBe("cache-count:1");
      expect(second.headers.get("x-cache")).toBe("HIT");

      const deleted = await fetch("http://127.0.0.1:19382/api/v1/delete_cache", {
        method: "POST",
        headers: { "x-api-key": "test-api-key", "content-type": "application/json" },
        body: JSON.stringify({ site: siteId, path: "/cache" }),
      });
      expect(deleted.status).toBe(200);
      expect((await deleted.json() as { deleted: number }).deleted).toBeGreaterThan(0);
      const third = await proxyFetch(secondPort, "/cache");
      expect(await third.text()).toBe("cache-count:2");

      expect((await proxyFetch(19380, "/limited")).status).toBe(200);
      expect((await proxyFetch(secondPort, "/limited")).status).toBe(429);
      if (linux) {
        const oldPid = Number(logs.match(/Worker 1 ready on port 19380 \(pid (\d+)\)/)?.[1]);
        expect(Number.isSafeInteger(oldPid)).toBe(true);
        process.kill(oldPid, "SIGTERM");
        await until(() => (logs.match(/Worker 1 ready on port 19380/g) ?? []).length === 2);
        const replacementPid = Number([...logs.matchAll(/Worker 1 ready on port 19380 \(pid (\d+)\)/g)][1]?.[1]);
        expect(replacementPid).not.toBe(oldPid);
        expect((await proxyFetch(19380, "/worker")).status).toBe(200);
      }
    } catch (error) {
      throw new Error(`${error}\nLogs:\n${logs}`);
    } finally {
      child.kill("SIGTERM");
      await Promise.race([child.exited, Bun.sleep(5_000)]);
      if (child.exitCode === null) child.kill("SIGKILL");
      await Promise.allSettled([stdout, stderr]);
      upstream.stop();
      const redis = new Bun.RedisClient(redisUrl!);
      await redis.del(`rate_limit:ip:${requestIp}:300`);
      redis.close();
      const cache = new BunRedisCacheStore(redisUrl!, 1_000_000);
      await cache.init();
      await cache.deleteByPrefix(`page_cache:${siteId}:`);
      await rm(directory, { recursive: true, force: true });
    }
  }, 110_000);
});
