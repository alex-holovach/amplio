import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, cpSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPkg = path.join(repoRoot, "packages/cli");
const corePkg = path.join(repoRoot, "packages/core");

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  });
}

function fail(msg) {
  console.error(`publish-smoke failed: ${msg}`);
  process.exit(1);
}

// Ensure builds + bundled registry
run("pnpm", ["--filter", "@logcn/core", "build"], { cwd: repoRoot, stdio: "inherit" });
run("pnpm", ["--filter", "@logcn/cli", "build"], { cwd: repoRoot, stdio: "inherit" });

if (!existsSync(path.join(cliPkg, "registry/registry.json"))) {
  fail("packages/cli/registry/registry.json missing after build");
}

const staging = mkdtempSync(path.join(tmpdir(), "logcn-pack-"));
const project = mkdtempSync(path.join(tmpdir(), "logcn-app-"));
let coreTgz;
let cliTgz;

try {
  coreTgz = run("npm", ["pack", "--pack-destination", staging], { cwd: corePkg }).trim().split("\n").pop();
  cliTgz = run("npm", ["pack", "--pack-destination", staging], { cwd: cliPkg }).trim().split("\n").pop();
  const corePath = path.join(staging, coreTgz);
  const cliPath = path.join(staging, cliTgz);

  writeFileSync(
    path.join(project, "package.json"),
    JSON.stringify({ name: "logcn-publish-smoke", private: true, type: "module" }, null, 2),
  );

  run("npm", ["install", corePath, cliPath], { cwd: project, stdio: "inherit" });

  const logcn = path.join(project, "node_modules/.bin/logcn");
  if (!existsSync(logcn)) fail("logcn bin missing after install");

  const initOut = run(logcn, ["init", "--service", "publish-smoke"], { cwd: project });
  if (!existsSync(path.join(project, "telemetry/logger.ts"))) fail("init did not create telemetry/logger.ts");
  if (!existsSync(path.join(project, "logcn.json"))) fail("init did not create logcn.json");

  const listOut = run(logcn, ["list"], { cwd: project });
  if (!listOut.includes("middleware-hono") && !listOut.includes("hono")) {
    fail(`list missing hono item:\n${listOut}`);
  }

  run(logcn, ["add", "middleware", "hono"], { cwd: project, stdio: "inherit" });
  if (!existsSync(path.join(project, "telemetry/middleware/hono.ts"))) {
    fail("add middleware hono did not create telemetry/middleware/hono.ts");
  }

  run(logcn, ["add", "event", "auth.user.signed_up"], { cwd: project, stdio: "inherit" });
  if (!existsSync(path.join(project, "telemetry/events/auth/user-signed-up.ts"))) {
    fail("add event did not create user-signed-up.ts");
  }

  console.log("publish-smoke ok");
  console.log(
    JSON.stringify({
      coreTgz,
      cliTgz,
      project,
      initSnippet: initOut.trim().split("\n").slice(0, 3),
      listTotalLine: listOut.trim().split("\n").filter((l) => l.startsWith("Total:")).pop(),
    }),
  );
} finally {
  rmSync(staging, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
}
