import cluster from "node:cluster";
import type { Worker } from "node:cluster";
import { cpus } from "node:os";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { loadConfig } from "./config/loadConfig.ts";
import { CacheService } from "./services/cacheService.ts";
import { ProxyService } from "./services/proxyService.ts";
import { createProxyApp, createApiApp } from "./app.ts";
import { TemplateService } from "./services/templateService.ts";
import { GeoIPService } from "./services/geoipService.ts";
import { CaptchaService } from "./services/captchaService.ts";
import { ServiceContainer } from "./types/service.ts";
import { RateLimitService } from "./services/rateLimitService.ts";
import {
  IpcCacheExecute,
  IpcCacheOp,
  IpcCacheRequest,
  IpcCacheResponse,
  IpcCacheExecutedResponse,
  ICacheStore,
} from "./types/cache.ts";
import { IpcCacheStore } from "./services/cacheStores/ipcCacheStore.ts";
import {
  isIpcCacheRequest,
  isIpcCacheExecutedResponse,
} from "./utils/ipcCacheProtocol.ts";
import { runCacheWorker } from "./ipcCacheWorker.ts";
import { createWorkerCacheService } from "./cluster/cacheServiceFactory.ts";

type WorkerRole = "proxy" | "cache";

const WORKER_ROLE_ENV = "WORKER_ROLE";
const IPC_TIMEOUT_MS = 2000;

type PendingMasterRequest = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

async function runProxyWorker(): Promise<void> {
  const { cfg, cacheService } = await createWorkerCacheService();
  const proxyService = new ProxyService(cfg, cacheService);
  const captchaService = new CaptchaService(cfg);
  const rateLimitService = new RateLimitService(cacheService);

  const templateService = new TemplateService(cfg);
  await templateService.init();

  const geoipService = new GeoIPService(cfg);
  await geoipService.init();

  const serviceContainer: ServiceContainer = {
    cacheService,
    captchaService,
    rateLimitService,
    proxyService,
    tpl: templateService,
    geoipService,
  };

  const proxyApp = await createProxyApp(cfg, serviceContainer);
  const proxyServer = proxyApp.listen(cfg.proxy.server_port, () => {
    console.log(`[proxy:${process.pid}] Listening on port ${cfg.proxy.server_port}`);
  });

  const shutdown = () => {
    console.log(`[proxy:${process.pid}] Shutting down...`);
    proxyServer.close();
    proxyService.close();
    void templateService.close();
    void geoipService.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function runStandalone(): Promise<void> {
  const cfg = loadConfig();

  console.log("[boot] Config loaded.");

  const cacheService = new CacheService(cfg);
  await cacheService.init();

  const proxyService = new ProxyService(cfg, cacheService);
  const captchaService = new CaptchaService(cfg);
  const rateLimitService = new RateLimitService(cacheService);

  const templateService = new TemplateService(cfg);
  await templateService.init();

  const geoipService = new GeoIPService(cfg);
  await geoipService.init();

  const serviceContainer: ServiceContainer = {
    cacheService,
    captchaService,
    rateLimitService,
    proxyService,
    tpl: templateService,
    geoipService,
  };

  const proxyApp = await createProxyApp(cfg, serviceContainer);
  const proxyServer = proxyApp.listen(cfg.proxy.server_port, () => {
    console.log(`[proxy] Listening on port ${cfg.proxy.server_port}`);
  });

  const apiApp = await createApiApp(cfg, { cacheService });
  const apiServer = apiApp.listen(cfg.api.server_port, cfg.cluster.admin_host, () => {
    console.log(`[api] Listening on ${cfg.cluster.admin_host}:${cfg.api.server_port}`);
  });

  const shutdown = () => {
    console.log("[boot] Shutting down...");
    proxyServer.close();
    apiServer.close();
    proxyService.close();
    void templateService.close();
    void geoipService.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function runPrimary(): Promise<void> {
  const cfg = loadConfig();
  const roleByWorkerId = new Map<number, WorkerRole>();
  const pendingMasterRequests = new Map<string, PendingMasterRequest>();
  let shuttingDown = false;
  let cacheWorker: Worker | null = null;
  let apiServer: Server | null = null;

  const rejectAllMasterPending = (reason: string) => {
    for (const [requestId, pending] of pendingMasterRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
      pendingMasterRequests.delete(requestId);
    }
  };

  const forwardResponseToProxy = (msg: IpcCacheExecutedResponse) => {
    if (msg.sourceWorkerId === 0) {
      const pending = pendingMasterRequests.get(msg.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingMasterRequests.delete(msg.requestId);
      if (!msg.ok) {
        pending.reject(new Error(msg.error ?? "IPC cache request failed"));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    const worker = cluster.workers?.[msg.sourceWorkerId];
    if (!worker) return;
    const response: IpcCacheResponse = {
      kind: "ipc-cache:res",
      requestId: msg.requestId,
      ok: msg.ok,
      result: msg.result,
      error: msg.error,
    };
    worker.send(response);
  };

  const onWorkerMessage = (worker: Worker, message: unknown) => {
    if (isIpcCacheRequest(message)) {
      if (!cacheWorker) {
        const response: IpcCacheResponse = {
          kind: "ipc-cache:res",
          requestId: message.requestId,
          ok: false,
          error: "Cache worker is unavailable",
        };
        worker.send(response);
        return;
      }

      const execute: IpcCacheExecute = {
        ...message,
        kind: "ipc-cache:exec",
        sourceWorkerId: worker.id,
      };
      cacheWorker.send(execute);
      return;
    }

    if (isIpcCacheExecutedResponse(message)) {
      forwardResponseToProxy(message);
    }
  };

  const forkWorker = (role: WorkerRole) => {
    const worker = cluster.fork({ [WORKER_ROLE_ENV]: role });
    roleByWorkerId.set(worker.id, role);
    worker.on("message", (message: unknown) => onWorkerMessage(worker, message));
    if (role === "cache") {
      cacheWorker = worker;
    }
    return worker;
  };

  const requestCacheFromMaster = (op: IpcCacheOp, payload?: Omit<IpcCacheRequest, "kind" | "requestId" | "op">) => {
    if (!cacheWorker) {
      return Promise.reject(new Error("Cache worker is unavailable"));
    }

    const requestId = randomUUID();
    const execute: IpcCacheExecute = {
      kind: "ipc-cache:exec",
      requestId,
      sourceWorkerId: 0,
      op,
      ...payload,
    };

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingMasterRequests.delete(requestId);
        reject(new Error(`Master cache request timeout (${op})`));
      }, IPC_TIMEOUT_MS);

      pendingMasterRequests.set(requestId, { resolve, reject, timer });
      cacheWorker?.send(execute);
    });
  };

  const runMasterApi = async () => {
    let cacheService: CacheService;
    if (cfg.cache.provider === "memory") {
      const store: ICacheStore = new IpcCacheStore(requestCacheFromMaster);
      cacheService = new CacheService(cfg, { store });
    } else {
      cacheService = new CacheService(cfg);
    }
    await cacheService.init();

    const apiApp = await createApiApp(cfg, { cacheService });
    apiServer = apiApp.listen(cfg.api.server_port, cfg.cluster.admin_host, () => {
      console.log(`[master-api] Listening on ${cfg.cluster.admin_host}:${cfg.api.server_port}`);
    });
  };

  if (cfg.cache.provider === "memory") {
    forkWorker("cache");
  }

  await runMasterApi();

  const workerCount = cfg.cluster.num_workers > 0 ? cfg.cluster.num_workers : Math.max(1, cpus().length);
  for (let i = 0; i < workerCount; i++) {
    forkWorker("proxy");
  }

  cluster.on("exit", (worker, code, signal) => {
    const role = roleByWorkerId.get(worker.id);
    roleByWorkerId.delete(worker.id);

    if (role === "cache" && cacheWorker?.id === worker.id) {
      cacheWorker = null;
      rejectAllMasterPending("Cache worker exited");
    }

    if (shuttingDown) return;

    console.warn(`[master] Worker ${worker.process.pid} (${role ?? "unknown"}) exited (code=${code}, signal=${signal ?? "none"}), restarting...`);
    if (role === "cache") {
      forkWorker("cache");
      return;
    }
    if (role === "proxy") {
      forkWorker("proxy");
    }
  });

  const shutdown = () => {
    shuttingDown = true;
    console.log("[master] Shutting down...");
    apiServer?.close();

    const workers = Object.values(cluster.workers ?? {});
    for (const worker of workers) {
      worker?.kill("SIGTERM");
    }

    setTimeout(() => process.exit(0), 500);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function main() {
  const cfg = loadConfig();

  if (!cfg.cluster.enabled) {
    await runStandalone();
    return;
  }

  if (cluster.isPrimary) {
    await runPrimary();
    return;
  }

  const role = (process.env[WORKER_ROLE_ENV] as WorkerRole | undefined) ?? "proxy";
  if (role === "cache") {
    await runCacheWorker();
    return;
  }

  await runProxyWorker();
}

main().catch((err) => {
  console.error("[boot] Fatal error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
