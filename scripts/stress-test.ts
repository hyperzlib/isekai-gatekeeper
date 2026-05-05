#!/usr/bin/env bun

type Options = {
  url: string;
  method: string;
  concurrency: number;
  durationSec: number;
  timeoutMs: number;
  warmupSec: number;
  body?: string;
  headers: Record<string, string>;
};

type RunStats = {
  started: number;
  completed: number;
  succeeded: number;
  failed: number;
  timedOut: number;
  statusCounts: Map<number, number>;
  latenciesMs: number[];
  bytesReceived: number;
  firstResponse?: {
    status: number;
    body: string;
  };
  lastResponse?: {
    status: number;
    body: string;
  };
};

function printHelp(): void {
  console.log(`
Usage:
  bun scripts/stress-test.ts --url <url> [options]

Required:
  --url <url>                 Target URL, e.g. http://127.0.0.1:8080/.isekai-gatekeeper/challenge

Options:
  --method <method>           HTTP method (default: GET)
  --concurrency <n>           Concurrent workers (default: 50)
  --duration <sec>            Test duration in seconds (default: 30)
  --timeout <ms>              Per-request timeout in ms (default: 5000)
  --warmup <sec>              Warmup phase in seconds, ignored in final stats (default: 3)
  --header <k:v>              Repeatable header, e.g. --header Host:test.com
  --body <text>               Request body (for POST/PUT/PATCH)
  --help                      Show help

Examples:
  bun scripts/stress-test.ts --url http://127.0.0.1:8080/.isekai-gatekeeper/challenge
  bun run stress --url http://127.0.0.1:8080/.isekai-gatekeeper/challenge --concurrency 200 --duration 60 --header Host:test.com
`);
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    url: "",
    method: "GET",
    concurrency: 50,
    durationSec: 30,
    timeoutMs: 5000,
    warmupSec: 3,
    headers: {},
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }

    if (arg === "--url") {
      options.url = argv[++i] ?? "";
      continue;
    }
    if (arg === "--method") {
      options.method = (argv[++i] ?? "GET").toUpperCase();
      continue;
    }
    if (arg === "--concurrency") {
      options.concurrency = Number.parseInt(argv[++i] ?? "", 10);
      continue;
    }
    if (arg === "--duration") {
      options.durationSec = Number.parseInt(argv[++i] ?? "", 10);
      continue;
    }
    if (arg === "--timeout") {
      options.timeoutMs = Number.parseInt(argv[++i] ?? "", 10);
      continue;
    }
    if (arg === "--warmup") {
      options.warmupSec = Number.parseInt(argv[++i] ?? "", 10);
      continue;
    }
    if (arg === "--body") {
      options.body = argv[++i] ?? "";
      continue;
    }
    if (arg === "--header") {
      const raw = argv[++i] ?? "";
      const idx = raw.indexOf(":");
      if (idx <= 0) {
        throw new Error(`Invalid --header value: ${raw}`);
      }
      const key = raw.slice(0, idx).trim();
      const value = raw.slice(idx + 1).trim();
      if (!key) throw new Error(`Invalid --header key in: ${raw}`);
      options.headers[key] = value;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.url) {
    throw new Error("Missing required argument: --url");
  }

  if (!Number.isFinite(options.concurrency) || options.concurrency <= 0) {
    throw new Error("--concurrency must be a positive integer");
  }

  if (!Number.isFinite(options.durationSec) || options.durationSec <= 0) {
    throw new Error("--duration must be a positive integer (seconds)");
  }

  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("--timeout must be a positive integer (ms)");
  }

  if (!Number.isFinite(options.warmupSec) || options.warmupSec < 0) {
    throw new Error("--warmup must be >= 0");
  }

  return options;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank] ?? 0;
}

function formatNumber(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

function formatMs(n: number): string {
  return `${n.toFixed(2)} ms`;
}

function trimBody(body: string, maxLength: number): string {
  if (body.length <= maxLength) return body;
  return `${body.slice(0, maxLength)}... [truncated ${body.length - maxLength} chars]`;
}

async function run(options: Options): Promise<void> {
  const stats: RunStats = {
    started: 0,
    completed: 0,
    succeeded: 0,
    failed: 0,
    timedOut: 0,
    statusCounts: new Map(),
    latenciesMs: [],
    bytesReceived: 0,
  };

  const startAt = performance.now();
  const warmupUntil = startAt + options.warmupSec * 1000;
  const endAt = startAt + (options.warmupSec + options.durationSec) * 1000;

  let stop = false;

  const requestInitBase: RequestInit = {
    method: options.method,
    headers: options.headers,
  };

  if (options.body !== undefined) {
    requestInitBase.body = options.body;
  }

  const worker = async (): Promise<void> => {
    while (!stop) {
      const now = performance.now();
      if (now >= endAt) {
        stop = true;
        break;
      }

      stats.started += 1;
      const reqStart = performance.now();
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs);

      try {
        const response = await fetch(options.url, {
          ...requestInitBase,
          signal: controller.signal,
        });

        const bodyText = await response.text();
        const reqEnd = performance.now();
        const elapsed = reqEnd - reqStart;

        if (reqEnd >= warmupUntil) {
          stats.completed += 1;
          stats.succeeded += 1;
          stats.latenciesMs.push(elapsed);
          stats.bytesReceived += bodyText.length;
          stats.statusCounts.set(response.status, (stats.statusCounts.get(response.status) ?? 0) + 1);

          if (!stats.firstResponse) {
            stats.firstResponse = {
              status: response.status,
              body: bodyText,
            };
          }

          stats.lastResponse = {
            status: response.status,
            body: bodyText,
          };
        }
      } catch (error) {
        const reqEnd = performance.now();
        if (reqEnd >= warmupUntil) {
          stats.completed += 1;
          stats.failed += 1;
          if (error instanceof Error && error.name === "AbortError") {
            stats.timedOut += 1;
          }
        }
      } finally {
        clearTimeout(timeoutId);
      }
    }
  };

  const progressTimer = setInterval(() => {
    const now = performance.now();
    const elapsedSec = Math.max(0, (now - warmupUntil) / 1000);
    const completed = stats.completed;
    const rps = elapsedSec > 0 ? completed / elapsedSec : 0;
    const inPhase = now < warmupUntil ? "warmup" : "running";
    console.log(`[${inPhase}] completed=${formatNumber(completed)} rps=${rps.toFixed(2)}`);
  }, 1000);

  console.log("Starting stress test...");
  console.log(`target=${options.url}`);
  console.log(`method=${options.method}`);
  console.log(`concurrency=${options.concurrency} warmup=${options.warmupSec}s duration=${options.durationSec}s timeout=${options.timeoutMs}ms`);

  await Promise.all(Array.from({ length: options.concurrency }, () => worker()));
  clearInterval(progressTimer);

  const measuredSec = options.durationSec;
  const completed = stats.completed;
  const succeeded = stats.succeeded;
  const failed = stats.failed;
  const timeout = stats.timedOut;
  const rps = completed / measuredSec;
  const throughputBytesPerSec = stats.bytesReceived / measuredSec;

  const sorted = stats.latenciesMs.slice().sort((a, b) => a - b);
  const avg = sorted.length > 0 ? sorted.reduce((acc, n) => acc + n, 0) / sorted.length : 0;
  const p50 = percentile(sorted, 50);
  const p90 = percentile(sorted, 90);
  const p95 = percentile(sorted, 95);
  const p99 = percentile(sorted, 99);

  console.log("\n=== Result ===");
  console.log(`requests.started     : ${formatNumber(stats.started)}`);
  console.log(`requests.completed   : ${formatNumber(completed)}`);
  console.log(`requests.succeeded   : ${formatNumber(succeeded)}`);
  console.log(`requests.failed      : ${formatNumber(failed)}`);
  console.log(`requests.timed_out   : ${formatNumber(timeout)}`);
  console.log(`rps                  : ${rps.toFixed(2)}`);
  console.log(`throughput           : ${formatNumber(Math.round(throughputBytesPerSec))} bytes/s`);

  console.log("\nLatency:");
  console.log(`avg                  : ${formatMs(avg)}`);
  console.log(`p50                  : ${formatMs(p50)}`);
  console.log(`p90                  : ${formatMs(p90)}`);
  console.log(`p95                  : ${formatMs(p95)}`);
  console.log(`p99                  : ${formatMs(p99)}`);

  console.log("\nStatus codes:");
  const statusRows = Array.from(stats.statusCounts.entries()).sort((a, b) => a[0] - b[0]);
  if (statusRows.length === 0) {
    console.log("(none)");
  } else {
    for (const [status, count] of statusRows) {
      console.log(`${status} : ${formatNumber(count)}`);
    }
  }

  console.log("\nResponse samples:");
  if (!stats.firstResponse) {
    console.log("first response       : (none)");
  } else {
    console.log(`first response       : status=${stats.firstResponse.status}`);
    console.log(trimBody(stats.firstResponse.body, 1000));
  }

  if (!stats.lastResponse) {
    console.log("last response        : (none)");
  } else {
    console.log(`last response        : status=${stats.lastResponse.status}`);
    console.log(trimBody(stats.lastResponse.body, 1000));
  }
}

async function main(): Promise<void> {
  try {
    const options = parseArgs(process.argv.slice(2));
    await run(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    console.error("Use --help to view usage.");
    process.exit(1);
  }
}

main();
