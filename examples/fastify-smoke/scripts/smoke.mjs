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

const port = await freePort();
const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
  cwd: root,
  env: { ...process.env, PORT: String(port), SERVICE_NAME: "fastify-smoke" },
  stdio: ["ignore", "pipe", "pipe"],
});

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
  if (!child.killed) {
    child.kill("SIGTERM");
  }
}

process.on("exit", cleanup);

async function waitReady(timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (stdout.includes("listening on")) return;
    if (child.exitCode != null) {
      fail(`server exited early (${child.exitCode}): ${stderr || stdout}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  fail(`server did not become ready.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
}

try {
  await waitReady();

  const hostileRequestId = "tenant/../../orders?token=private";
  const res = await fetch(`http://127.0.0.1:${port}/health?token=secret`, {
    headers: { "x-request-id": hostileRequestId },
  });
  if (!res.ok) fail(`GET /health returned ${res.status}`);
  const body = await res.json();
  if (body?.ok !== true)
    fail(`unexpected health body: ${JSON.stringify(body)}`);

  const failureRes = await fetch(`http://127.0.0.1:${port}/failure`);
  if (failureRes.status !== 503)
    fail(`GET /failure returned ${failureRes.status}`);

  // allow finish handler to emit
  await new Promise((r) => setTimeout(r, 150));

  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{") && l.endsWith("}"));

  let record;
  let failureRecord;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed?.http?.route === "/health") record = parsed;
      if (parsed?.http?.route === "/failure") failureRecord = parsed;
    } catch {
      // ignore non-json noise
    }
  }

  if (!record) {
    fail(`no JSON wide-event for /health in stdout:\n${stdout}`);
  }
  if (!failureRecord || failureRecord.http?.status !== 503) {
    fail(`no status-503 wide event for /failure in stdout:\n${stdout}`);
  }
  if (failureRecord.success !== false) {
    fail(`expected /failure success false, got ${failureRecord.success}`);
  }

  if (record.http?.status !== 200 && record.status !== 200) {
    fail(
      `expected status 200, got ${JSON.stringify({ http: record.http, status: record.status })}`,
    );
  }

  if (!record.http || typeof record.http !== "object") {
    fail("emitted record missing nested http object");
  }
  if (record.http?.route !== "/health") {
    fail(`expected stable route /health, got ${JSON.stringify(record.http)}`);
  }
  if ("search" in record.http || JSON.stringify(record).includes("secret")) {
    fail(`query string leaked into wide event: ${JSON.stringify(record.http)}`);
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

  console.log("fastify-smoke ok");
  console.log(
    JSON.stringify({
      service: record.service,
      event: record["@event"],
      http: record.http,
    }),
  );
  cleanup();
  await new Promise((r) => child.once("exit", r));
  process.exit(0);
} catch (error) {
  cleanup();
  fail(error instanceof Error ? error.message : String(error));
}
