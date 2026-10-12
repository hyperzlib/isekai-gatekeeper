import { loadConfig } from "./config/loadConfig.ts";
import { createProxyApp, createApiApp } from "./app.ts";
import { createRuntime } from "./runtime.ts";
import type { AppConfig } from "./types/config.ts";
import { validateWorkerConfig } from "./config/workerConfig.ts";

const WORKER_ARG = "--proxy-worker";
const STARTUP_TIMEOUT_MS = 20_000;
type WorkerMessage = { type: "ready"; index: number; port: number };

function workerPort(cfg: AppConfig, index: number): number {
  return process.platform === "linux" ? cfg.proxy.server_port : cfg.proxy.server_port + index;
}

async function runWorker(index: number): Promise<void> {
  console.log(`[proxy] Worker ${index} starting (pid ${process.pid})`);
  const cfg = await loadConfig();
  const count = validateWorkerConfig(cfg);
  if (!Number.isSafeInteger(index) || index < 0 || index >= count || count === 1 || !process.send) {
    throw new Error("Invalid proxy worker invocation");
  }
  const runtime = await createRuntime(cfg, false);
  const port = workerPort(cfg, index);
  const app = await createProxyApp(cfg, runtime.services);
  const server = Bun.serve({ port, reusePort: process.platform === "linux", fetch: app.fetch });
  console.log(`[proxy] Worker ${index} listening on port ${port} (pid ${process.pid})`);
  process.send({ type: "ready", index, port } satisfies WorkerMessage);
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    server.stop();
    void runtime.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("disconnect", shutdown);
}

async function runMain(): Promise<void> {
  const cfg = await loadConfig();
  const count = validateWorkerConfig(cfg);
  console.log("[boot] Config loaded.");
  if (cfg.proxy.workers === "auto") {
    console.log(`[proxy] workers=auto resolved to ${count} on ${process.platform}`);
  }
  if (process.platform === "win32" || process.platform === "darwin") {
    console.log("[proxy] Windows/macOS 多 worker 需要手动设置 proxy.workers，并使用 nginx 反向代理分流到各 worker 的连续端口；workers=auto 始终使用 1 个 worker。");
  }
  const runtime = await createRuntime(cfg, true);
  let proxyServer: ReturnType<typeof Bun.serve> | undefined;
  let apiServer: ReturnType<typeof Bun.serve> | undefined;
  let stopping = false;
  const children = new Map<number, Bun.Subprocess>();
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  const failures = new Map<number, number>();
  const readySince = new Map<number, number>();

  const stop = async (exitCode = 0) => {
    if (stopping) return;
    stopping = true;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    proxyServer?.stop();
    apiServer?.stop();
    for (const child of children.values()) child.kill("SIGTERM");
    const exited = Promise.allSettled([...children.values()].map((child) => child.exited));
    const graceful = await Promise.race([exited.then(() => true), Bun.sleep(5_000).then(() => false)]);
    if (!graceful) {
      for (const child of children.values()) child.kill("SIGKILL");
      await exited;
    }
    await runtime.close();
    process.exit(exitCode);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());

  const spawnWorker = (index: number): Promise<void> => new Promise((resolve, reject) => {
    const port = workerPort(cfg, index);
    console.log(`[proxy] Starting worker ${index} on port ${port}`);
    let settled = false;
    let timeout: ReturnType<typeof setTimeout>;
    const child = Bun.spawn({
      cmd: [process.execPath, import.meta.path, WORKER_ARG, String(index)],
      cwd: process.cwd(),
      env: { ...process.env },
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
      windowsHide: true,
      ipc(message) {
        if (message && typeof message === "object" && (message as WorkerMessage).type === "ready" &&
            (message as WorkerMessage).index === index && (message as WorkerMessage).port === port) {
          readySince.set(index, Date.now());
          console.log(`[proxy] Worker ${index} ready on port ${port} (pid ${child.pid})`);
          if (!settled) { settled = true; clearTimeout(timeout); resolve(); }
        }
      },
      onExit(_proc, exitCode) {
        children.delete(index);
        if (!settled) { settled = true; clearTimeout(timeout); reject(new Error(`Proxy worker ${index} exited before ready (code ${exitCode})`)); }
        if (stopping) return;
        const stable = Date.now() - (readySince.get(index) ?? 0) >= 60_000;
        readySince.delete(index);
        const attempts = (stable ? 0 : (failures.get(index) ?? 0)) + 1;
        failures.set(index, attempts);
        const delay = Math.min(30_000, 500 * 2 ** Math.min(attempts - 1, 6));
        console.error(`[proxy] Worker ${index} exited (code ${exitCode}); restarting in ${delay}ms`);
        timers.set(index, setTimeout(() => {
          timers.delete(index);
          void spawnWorker(index).catch((error) => console.error(`[proxy] Worker ${index} startup failed:`, error));
        }, delay));
      },
    });
    children.set(index, child);
    timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGTERM");
        reject(new Error(`Proxy worker ${index} did not become ready within ${STARTUP_TIMEOUT_MS}ms`));
      }
    }, STARTUP_TIMEOUT_MS);
  });

  try {
    if (count === 1) {
      const app = await createProxyApp(cfg, runtime.services);
      proxyServer = Bun.serve({ port: cfg.proxy.server_port, fetch: app.fetch });
    } else {
      await Promise.all(Array.from({ length: count }, (_, index) => spawnWorker(index)));
    }
    const apiApp = await createApiApp(cfg, runtime.services);
    apiServer = Bun.serve({ port: cfg.api.server_port, fetch: apiApp.fetch });
    console.log(`[proxy] Listening on port ${cfg.proxy.server_port}${count > 1 ? ` (${count} workers)` : ""}`);
    console.log(`[api] Listening on port ${cfg.api.server_port}`);
  } catch (error) {
    console.error("[boot] Startup failed:", error);
    await stop(1);
  }
}

const workerIndex = process.argv[2] === WORKER_ARG ? Number(process.argv[3]) : null;
const entry = workerIndex === null ? runMain() : runWorker(workerIndex);
entry.catch((error) => {
  console.error("[boot] Fatal error:", error);
  process.exit(1);
});
