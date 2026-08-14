import { spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("failed to bind ephemeral port"));
        return;
      }
      const { port } = addr;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
    server.on("error", reject);
  });
}

function fail(message, code = 1) {
  console.error(`smoke failed: ${message}`);
  process.exit(code);
}

function killTree(child) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // already gone
    }
  }
}

const port = await freePort();
const child = spawn(
  process.execPath,
  [
    path.join(root, "node_modules/next/dist/bin/next"),
    "dev",
    "-H",
    "127.0.0.1",
    "-p",
    String(port),
  ],
  {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      SERVICE_NAME: "next-smoke",
      NODE_ENV: "development",
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  },
);

let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdout += chunk;
});
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

function cleanup() {
  killTree(child);
}

process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(143);
});

async function waitReady(timeoutMs = 60000) {
  const start = Date.now();
  const readyHints = [
    "Ready in",
    "started server on",
    "Local:",
    `localhost:${port}`,
  ];
  while (Date.now() - start < timeoutMs) {
    const combined = `${stdout}\n${stderr}`;
    if (readyHints.some((h) => combined.includes(h))) return;
    if (child.exitCode != null) {
      fail(`server exited early (${child.exitCode}): ${stderr || stdout}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  fail(`server did not become ready.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
}

try {
  await waitReady();

  // First compile can lag after "Ready"
  const hostileRequestId = "tenant/../../orders?token=private";
  let res;
  let lastErr;
  for (let i = 0; i < 30; i++) {
    try {
      res = await fetch(`http://127.0.0.1:${port}/api/health?token=secret`, {
        headers: { "x-request-id": hostileRequestId },
      });
      if (res.ok) break;
    } catch (error) {
      lastErr = error;
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  if (!res?.ok) {
    fail(
      `GET /api/health failed: ${res ? res.status : lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
    );
  }

  const body = await res.json();
  if (body?.ok !== true)
    fail(`unexpected health body: ${JSON.stringify(body)}`);

  const failureRes = await fetch(`http://127.0.0.1:${port}/api/failure`);
  if (failureRes.status !== 503)
    fail(`GET /api/failure returned ${failureRes.status}`);

  // allow emit + next log flush
  await new Promise((r) => setTimeout(r, 300));

  const combined = `${stdout}\n${stderr}`;
  const lines = combined
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{") && l.endsWith("}"));

  let record;
  let failureRecord;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (
        parsed?.http?.route === "/api/health" ||
        parsed?.service === "next-smoke"
      ) {
        if (parsed?.http?.route === "/api/health") record = parsed;
      }
      if (parsed?.http?.route === "/api/failure") failureRecord = parsed;
    } catch {
      // ignore
    }
  }

  if (!record) {
    fail(`no JSON wide-event for /api/health in output:\n${combined}`);
  }
  if (!failureRecord || failureRecord.http?.status !== 503) {
    fail(`no status-503 wide event for /api/failure in output:\n${combined}`);
  }
  if (failureRecord.success !== false) {
    fail(`expected /api/failure success false, got ${failureRecord.success}`);
  }

  if (record.http?.status !== 200 && record.status !== 200) {
    fail(
      `expected status 200, got ${JSON.stringify({ http: record.http, status: record.status })}`,
    );
  }

  if (!record.http || typeof record.http !== "object") {
    fail("emitted record missing nested http object");
  }
  if ("search" in record.http || JSON.stringify(record).includes("secret")) {
    fail(`query string leaked into wide event: ${JSON.stringify(record.http)}`);
  }
  if (record.http?.route !== "/api/health") {
    fail(
      `expected stable route /api/health, got ${JSON.stringify(record.http)}`,
    );
  }
  if (failureRecord.http?.route !== "/api/failure") {
    fail(
      `expected stable route /api/failure, got ${JSON.stringify(failureRecord.http)}`,
    );
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(record.request_id)) {
    fail(
      `expected generated request_id, got ${JSON.stringify(record.request_id)}`,
    );
  }
  if (
    record.request_id === hostileRequestId ||
    JSON.stringify(record).includes(hostileRequestId)
  ) {
    fail(
      `hostile request ID leaked into wide event: ${JSON.stringify(record)}`,
    );
  }

  console.log("next-smoke ok");
  console.log(
    JSON.stringify({
      service: record.service,
      event: record["@event"],
      http: record.http,
    }),
  );
  cleanup();
  await new Promise((r) => setTimeout(r, 500));
  process.exit(0);
} catch (error) {
  cleanup();
  fail(error instanceof Error ? error.message : String(error));
}
