#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public", "r");
const registryJson = path.join(publicDir, "registry.json");

function parsePort() {
  const idx = process.argv.indexOf("--port");
  if (idx !== -1) {
    const val = Number(process.argv[idx + 1]);
    if (!Number.isInteger(val) || val < 0 || val > 65535) {
      console.error("Invalid --port value");
      process.exit(1);
    }
    return val;
  }

  const envPort = process.env.PORT ? Number(process.env.PORT) : 4173;
  if (!Number.isInteger(envPort) || envPort < 0 || envPort > 65535) {
    console.error("Invalid PORT env value");
    process.exit(1);
  }
  return envPort;
}

function ensureBuilt() {
  if (existsSync(registryJson)) {
    return;
  }
  console.log("public/r/registry.json missing — running registry:build...");
  execFileSync("node", ["scripts/build-registry.mjs"], { cwd: root, stdio: "inherit" });
}

function contentType(filePath) {
  if (filePath.endsWith(".json")) {
    return "application/json";
  }
  return "application/octet-stream";
}

function resolveFile(urlPath) {
  const relative = decodeURIComponent(urlPath).replace(/^\//, "");
  const filePath = path.resolve(publicDir, relative);
  if (filePath !== publicDir && !filePath.startsWith(`${publicDir}${path.sep}`)) {
    return null;
  }
  return filePath;
}

async function main() {
  ensureBuilt();
  const port = parsePort();

  const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "Content-Type": "text/plain" });
      res.end("Method Not Allowed");
      return;
    }

    const urlPath = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    const filePath = resolveFile(urlPath);
    if (!filePath) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }

    try {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
        return;
      }

      res.writeHead(200, { "Content-Type": contentType(filePath) });
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      createReadStream(filePath).pipe(res);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    }
  });

  server.listen(port, "127.0.0.1", () => {
    const bound = server.address();
    const actualPort = typeof bound === "object" && bound ? bound.port : port;
    console.log(`logcn registry listening on http://127.0.0.1:${actualPort}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
