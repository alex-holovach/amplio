import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const LISTENING_RE = /listening on http:\/\/127\.0\.0\.1:(\d+)/;

describe("serve-registry CORS", () => {
  let child: ChildProcessWithoutNullStreams | undefined;

  afterEach(async () => {
    if (!child) return;

    const proc = child;
    child = undefined;

    await new Promise<void>((resolve) => {
      proc.once("exit", () => resolve());
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!proc.killed) {
          proc.kill("SIGKILL");
        }
        resolve();
      }, 2000);
    });
  });

  function startServer(): Promise<number> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let stdout = "";
      let stderr = "";

      const proc = spawn("node", ["scripts/serve-registry.mjs", "--port", "0"], {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });
      child = proc;

      const finish = (error?: Error, port?: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve(port!);
      };

      proc.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        const match = LISTENING_RE.exec(stdout);
        if (match) {
          finish(undefined, Number(match[1]));
        }
      });

      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on("error", (error) => finish(error));

      proc.on("exit", (code) => {
        if (!settled) {
          finish(
            new Error(`serve-registry exited early (${code}): ${stderr || stdout}`),
          );
        }
      });

      const timeout = setTimeout(() => {
        finish(new Error(`Timed out waiting for serve-registry: ${stderr || stdout}`));
      }, 15000);
    });
  }

  it("responds to OPTIONS /registry.json with CORS preflight headers", async () => {
    const port = await startServer();

    const response = await fetch(`http://127.0.0.1:${port}/registry.json`, {
      method: "OPTIONS",
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");

    const methods = (
      response.headers.get("Access-Control-Allow-Methods") ?? ""
    ).toLowerCase();
    expect(methods).toContain("options");
    expect(methods).toContain("get");
  });

  it("responds to OPTIONS /sink-console.json with CORS preflight headers", async () => {
    const port = await startServer();

    const response = await fetch(`http://127.0.0.1:${port}/sink-console.json`, {
      method: "OPTIONS",
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");

    const methods = (
      response.headers.get("Access-Control-Allow-Methods") ?? ""
    ).toLowerCase();
    expect(methods).toContain("options");
    expect(methods).toContain("get");
  });

  it("responds to POST /registry.json with 405 Method Not Allowed", async () => {
    const port = await startServer();
    const response = await fetch(`http://127.0.0.1:${port}/registry.json`, { method: "POST" });
    expect(response.status).toBe(405);
    expect(response.headers.get("Content-Type")).toMatch(/text\/plain/);
    expect(await response.text()).toBe("Method Not Allowed");
  });

  it("responds to POST /sink-console.json with 405 Method Not Allowed", async () => {
    const port = await startServer();
    const response = await fetch(`http://127.0.0.1:${port}/sink-console.json`, { method: "POST" });
    expect(response.status).toBe(405);
    expect(response.headers.get("Content-Type")).toMatch(/text\/plain/);
    expect(await response.text()).toBe("Method Not Allowed");
  });

  it("responds to PUT /sink-console.json with 405 Method Not Allowed", async () => {
    const port = await startServer();
    const response = await fetch(`http://127.0.0.1:${port}/sink-console.json`, { method: "PUT" });
    expect(response.status).toBe(405);
    expect(response.headers.get("Content-Type")).toMatch(/text\/plain/);
    expect(await response.text()).toBe("Method Not Allowed");
  });

  it("responds to DELETE /sink-console.json with 405 Method Not Allowed", async () => {
    const port = await startServer();
    const response = await fetch(`http://127.0.0.1:${port}/sink-console.json`, { method: "DELETE" });
    expect(response.status).toBe(405);
    expect(response.headers.get("Content-Type")).toMatch(/text\/plain/);
    expect(await response.text()).toBe("Method Not Allowed");
  });

  it("responds to HEAD /registry.json with 200, application/json, and empty body", async () => {
    const port = await startServer();
    const response = await fetch(`http://127.0.0.1:${port}/registry.json`, {
      method: "HEAD",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toMatch(/application\/json/);
    expect(await response.text()).toBe("");
  });

  it("responds to HEAD /sink-console.json with 200, application/json, and empty body", async () => {
    const port = await startServer();
    const response = await fetch(`http://127.0.0.1:${port}/sink-console.json`, {
      method: "HEAD",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toMatch(/application\/json/);
    expect(await response.text()).toBe("");
  });

  it("responds to GET /registry.json with 200, application/json, and items array", async () => {
    const port = await startServer();
    const response = await fetch(`http://127.0.0.1:${port}/registry.json`, {
      method: "GET",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toMatch(/application\/json/);

    const body = (await response.json()) as { items?: unknown };
    expect(Array.isArray(body.items)).toBe(true);
  });

  it("responds to GET /sink-console.json with 200, application/json, and matching name", async () => {
    const port = await startServer();
    const response = await fetch(`http://127.0.0.1:${port}/sink-console.json`, {
      method: "GET",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toMatch(/application\/json/);

    const body = (await response.json()) as { name?: unknown };
    expect(body.name).toBe("sink-console");
  });

  it("responds to GET of a missing file under public/r with 404 Not Found", async () => {
    const port = await startServer();
    const response = await fetch(
      `http://127.0.0.1:${port}/does-not-exist-${Date.now()}.json`,
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toMatch(/text\/plain/);
    expect(await response.text()).toBe("Not Found");
  });

  it("responds to GET path traversal with 403 Forbidden", async () => {
    const port = await startServer();
    // URL pathname normalizes "/../x"; encoded slash keeps ".." for resolveFile.
    const response = await fetch(
      `http://127.0.0.1:${port}/%2e%2e%2fpackage.json`,
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("Content-Type")).toMatch(/text\/plain/);
    expect(await response.text()).toBe("Forbidden");
  });
});
