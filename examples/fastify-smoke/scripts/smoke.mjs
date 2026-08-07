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
const child = spawn(
  process.execPath,
  ["--import", "tsx", "src/index.ts"],
  {
    cwd: root,
    env: { ...process.env, PORT: String(port), SERVICE_NAME: "fastify-smoke" },
    stdio: ["ignore", "pipe", "pipe"],
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

  const res = await fetch(`http://127.0.0.1:${port}/health`);
  if (!res.ok) fail(`GET /health returned ${res.status}`);
  const body = await res.json();
  if (body?.ok !== true) fail(`unexpected health body: ${JSON.stringify(body)}`);

  // allow finish handler to emit
  await new Promise((r) => setTimeout(r, 150));

  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{") && l.endsWith("}"));

  let record;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed?.http?.path === "/health" || parsed?.http?.method === "GET") {
        record = parsed;
        break;
      }
    } catch {
      // ignore non-json noise
    }
  }

  if (!record) {
    fail(`no JSON wide-event for /health in stdout:\n${stdout}`);
  }

  if (record.http?.status !== 200 && record.status !== 200) {
    fail(`expected status 200, got ${JSON.stringify({ http: record.http, status: record.status })}`);
  }

  if (!record.http || typeof record.http !== "object") {
    fail("emitted record missing nested http object");
  }

  console.log("fastify-smoke ok");
  console.log(JSON.stringify({ service: record.service, http: record.http, status: record.status }));
  cleanup();
  await new Promise((r) => child.once("exit", r));
  process.exit(0);
} catch (error) {
  cleanup();
  fail(error instanceof Error ? error.message : String(error));
}
