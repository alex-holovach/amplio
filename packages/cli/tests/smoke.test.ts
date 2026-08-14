import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runSmoke } from "../src/commands/smoke.js";

async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

/** Project with the JSON sink installed and wired in runtime.ts. */
async function setupSmokeProject(cwd: string): Promise<void> {
  await writeFile(
    path.join(cwd, "amplio.json"),
    JSON.stringify({ telemetryDir: "telemetry", packageManager: "pnpm" }),
  );
  await mkdir(path.join(cwd, "telemetry/sinks"), { recursive: true });
  await writeFile(path.join(cwd, "telemetry/sinks/json.ts"), "export {};\n");
  await writeFile(
    path.join(cwd, "telemetry/runtime.ts"),
    'import { jsonFileSink } from "./sinks/json";\ninit({ sinks: [jsonFileSink()] });\n',
  );
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as { port: number }).port);
    });
  });
}

describe("runSmoke", () => {
  let server: http.Server | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  it("PASSes when the response arrives and a row lands in amplio*.jsonl", async () => {
    const cwd = await makeTempDir("amplio-smoke-pass-");
    await setupSmokeProject(cwd);

    const row = {
      "@event": "http.request",
      request_id: "req_smoke",
      status: 200,
      duration_ms: 7,
    };
    server = http.createServer((_req, res) => {
      // Simulates the dev server's JSON sink appending on emit.
      void appendFile(
        path.join(cwd, "amplio.development.jsonl"),
        `${JSON.stringify(row)}\n`,
      ).then(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    const port = await listen(server);

    const logs: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((line: string) => {
      logs.push(String(line));
    });
    const code = await runSmoke({
      cwd,
      url: `http://127.0.0.1:${port}/api/trpc/post.hello`,
    });
    log.mockRestore();

    expect(code).toBe(0);
    const output = logs.join("\n");
    expect(output).toContain("PASS");
    expect(output).toContain("http.request");
    expect(output).toContain("req_smoke");
    expect(output).toContain("amplio.development.jsonl");
  });

  it("FAILs with a diagnosis when the response arrives but no row lands", async () => {
    const cwd = await makeTempDir("amplio-smoke-noevent-");
    await setupSmokeProject(cwd);

    server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    const port = await listen(server);

    const logs: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((line: string) => {
      logs.push(String(line));
    });
    const code = await runSmoke({
      cwd,
      url: `http://127.0.0.1:${port}/`,
      timeoutSeconds: 1,
    });
    log.mockRestore();

    expect(code).toBe(1);
    const output = logs.join("\n");
    expect(output).toContain("FAIL");
    expect(output).toContain("Wrong port");
  });

  it("FAILs and points at add sink json when the JSON sink is not wired", async () => {
    const cwd = await makeTempDir("amplio-smoke-nosink-");
    await writeFile(
      path.join(cwd, "amplio.json"),
      JSON.stringify({ telemetryDir: "telemetry", packageManager: "pnpm" }),
    );

    const logs: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((line: string) => {
      logs.push(String(line));
    });
    const code = await runSmoke({ cwd, url: "http://127.0.0.1:9/never-hit" });
    log.mockRestore();

    expect(code).toBe(1);
    const output = logs.join("\n");
    expect(output).toContain("amplio add sink json");
  });

  it("FAILs with the dev-server hint when the connection is refused", async () => {
    const cwd = await makeTempDir("amplio-smoke-refused-");
    await setupSmokeProject(cwd);

    // Grab a free port, then close it so nothing is listening.
    const probe = http.createServer();
    const port = await listen(probe);
    await new Promise((resolve) => probe.close(resolve));

    const logs: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((line: string) => {
      logs.push(String(line));
    });
    const code = await runSmoke({
      cwd,
      url: `http://127.0.0.1:${port}/`,
      timeoutSeconds: 2,
    });
    log.mockRestore();

    expect(code).toBe(1);
    const output = logs.join("\n");
    expect(output).toContain("FAIL");
    expect(output).toContain("dev server");
  });
});
