import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const cliPkg = path.join(repoRoot, "packages/cli");
const corePkg = path.join(repoRoot, "packages/amplio");

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function fail(message) {
  throw new Error(`publish-smoke failed: ${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function read(file) {
  return readFileSync(file, "utf8");
}

function readJson(file) {
  return JSON.parse(read(file));
}

const rootMetadata = readJson(path.join(repoRoot, "package.json"));
const coreMetadata = readJson(path.join(corePkg, "package.json"));
const cliMetadata = readJson(path.join(cliPkg, "package.json"));
const releaseVersion = rootMetadata.version;

assert(
  coreMetadata.version === releaseVersion,
  `core version ${coreMetadata.version} does not match root ${releaseVersion}`,
);
assert(
  cliMetadata.version === releaseVersion,
  `CLI version ${cliMetadata.version} does not match root ${releaseVersion}`,
);

function pack(packageRoot, staging) {
  return run("npm", ["pack", "--pack-destination", staging], {
    cwd: packageRoot,
  })
    .trim()
    .split("\n")
    .at(-1);
}

function assertNoForbiddenKeys(value, forbidden, currentPath = "record") {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertNoForbiddenKeys(entry, forbidden, `${currentPath}[${index}]`),
    );
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    assert(
      !forbidden.has(key),
      `privacy-forbidden key ${JSON.stringify(key)} at ${currentPath}`,
    );
    assertNoForbiddenKeys(entry, forbidden, `${currentPath}.${key}`);
  }
}

run("pnpm", ["--filter", "@useamplio/amplio", "build"], {
  cwd: repoRoot,
  stdio: "inherit",
});
run("pnpm", ["--filter", "@useamplio/cli", "build"], {
  cwd: repoRoot,
  stdio: "inherit",
});

const bundledManifest = path.join(cliPkg, "registry/registry.manifest.json");
assert(
  existsSync(bundledManifest),
  "CLI package is missing its registry manifest",
);
const manifest = readJson(bundledManifest);
for (const name of ["event-http-request", "plugin-hono", "plugin-resend"]) {
  assert(
    manifest.items.some((item) => item.name === name),
    `bundled registry is missing ${name}`,
  );
}
for (const item of manifest.items.filter((item) => item.kind === "plugin")) {
  assert(
    item.coreRange === `>=${releaseVersion} <1`,
    `${item.name} supports ${item.coreRange}, expected >=${releaseVersion} <1`,
  );
}
const bundledRegistry = readJson(path.join(cliPkg, "registry/registry.json"));
for (const item of bundledRegistry.items) {
  assert(
    item.dependencies?.includes(`@useamplio/amplio@^${releaseVersion}`),
    `${item.name} is not pinned to core ${releaseVersion}`,
  );
}

const staging = mkdtempSync(path.join(tmpdir(), "amplio-pack-"));
const project = mkdtempSync(path.join(tmpdir(), "amplio-hono-app-"));

try {
  const coreTgz = pack(corePkg, staging);
  const cliTgz = pack(cliPkg, staging);
  assert(
    coreTgz.endsWith(`-${releaseVersion}.tgz`),
    `core tarball ${coreTgz} does not carry ${releaseVersion}`,
  );
  assert(
    cliTgz.endsWith(`-${releaseVersion}.tgz`),
    `CLI tarball ${cliTgz} does not carry ${releaseVersion}`,
  );
  const corePath = path.join(staging, coreTgz);
  const cliPath = path.join(staging, cliTgz);

  writeFileSync(
    path.join(project, "package.json"),
    `${JSON.stringify(
      {
        name: "amplio-packed-hono-smoke",
        private: true,
        type: "module",
        scripts: {
          typecheck: "tsc --noEmit",
          smoke: "tsx src/app.ts",
        },
        dependencies: {
          "@useamplio/amplio": `file:${corePath}`,
          "@useamplio/cli": `file:${cliPath}`,
          hono: "^4.7.4",
          zod: "^3.24.2",
        },
        devDependencies: {
          "@types/node": "^22.13.10",
          tsx: "^4.19.3",
          typescript: "^5.8.2",
        },
      },
      null,
      2,
    )}\n`,
  );
  run("npm", ["install", "--no-audit", "--no-fund"], {
    cwd: project,
    stdio: "inherit",
  });

  const amplio = path.join(project, "node_modules/.bin/amplio");
  assert(existsSync(amplio), "amplio bin is missing after tarball install");

  mkdirSync(path.join(project, "src"), { recursive: true });
  const compositionPath = path.join(project, "src/email.ts");
  writeFileSync(
    compositionPath,
    `import { Resend } from "resend";

export const rawResend = new Resend(process.env.RESEND_API_KEY);
export const resend = rawResend;
`,
  );
  const appPath = path.join(project, "src/app.ts");
  writeFileSync(
    appPath,
    `import { flush } from "@useamplio/amplio";
import { Hono } from "hono";
import { rawResend, resend } from "./email.js";

let providerCalls = 0;
globalThis.fetch = async (_input, options) => {
  providerCalls += 1;
  const payload = JSON.parse(String(options?.body));
  if (
    payload.to !== "private-recipient@example.com" ||
    payload.subject !== "Sensitive publish smoke subject" ||
    payload.html !== "<p>private publish smoke body</p>"
  ) {
    throw new Error("Resend did not receive the original application payload");
  }
  return new Response(JSON.stringify({ id: "email_publish_smoke_1" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

if (rawResend !== resend) {
  throw new Error("Resend Plugin changed client identity");
}

const app = new Hono();
app.post("/send", async (context) => {
  const result = await resend.emails.send({
    from: "sender@example.com",
    to: "private-recipient@example.com",
    subject: "Sensitive publish smoke subject",
    html: "<p>private publish smoke body</p>",
    tags: [{ name: "template", value: "welcome-email" }],
  });
  if (result.error || result.data?.id !== "email_publish_smoke_1") {
    throw new Error("Resend Plugin changed the provider result");
  }
  return context.json({ id: result.data.id }, 201);
});

const response = await app.request(
  "https://example.test/send?private_query=publish-smoke-query-token",
  { method: "POST" },
);
if (response.status !== 201) {
  throw new Error(\`expected HTTP 201, received \${response.status}\`);
}
const body = await response.json();
if (body.id !== "email_publish_smoke_1" || providerCalls !== 1) {
  throw new Error("Hono or Resend application behavior changed");
}
await flush();
`,
  );

  run(
    amplio,
    ["init", "--yes", "--skip-install", "--service", "publish-smoke"],
    { cwd: project, stdio: "inherit" },
  );

  for (const relative of [
    "telemetry/runtime.ts",
    "telemetry/events/http-request.ts",
    "telemetry/plugins/hono.ts",
  ]) {
    assert(
      existsSync(path.join(project, relative)),
      `init did not create ${relative}`,
    );
  }
  const activatedApp = read(appPath);
  assert(
    activatedApp.includes(
      'import { HonoPlugin } from "../telemetry/plugins/hono.js";',
    ),
    "init did not import the detected Hono boundary Plugin",
  );
  assert(
    activatedApp.includes('app.use("*", HonoPlugin());'),
    "init did not register the detected Hono boundary Plugin",
  );
  for (const removed of [
    "components.json",
    "telemetry/components",
    "telemetry/workloads",
    "telemetry/middleware",
    "telemetry/integrations",
  ]) {
    assert(
      !existsSync(path.join(project, removed)),
      `init created alpha path ${removed}`,
    );
  }

  assert(
    readJson(path.join(project, "package.json")).dependencies.resend ===
      undefined,
    "packed fixture unexpectedly started with Resend installed",
  );
  const beforePluginInstall = new Map(
    ["src/email.ts", "telemetry/events/http-request.ts"].map((relative) => [
      relative,
      read(path.join(project, relative)),
    ]),
  );
  run(amplio, ["add", "plugin", "resend", "--event", "http.request", "--yes"], {
    cwd: project,
    stdio: "inherit",
  });
  const resendVersionInstalled = readJson(path.join(project, "package.json"))
    .dependencies.resend;
  assert(
    typeof resendVersionInstalled === "string" &&
      /^\^4\.\d+\.\d+$/.test(resendVersionInstalled),
    `Plugin installed unexpected Resend range ${String(resendVersionInstalled)}`,
  );
  const installedPlugin = readJson(path.join(project, "amplio.json")).plugins
    .resend;
  assert(
    installedPlugin.recipeVersion === "1.0.0" &&
      /^sha256-[a-f0-9]{64}$/.test(installedPlugin.recipeDigest) &&
      /^sha256-[a-f0-9]{64}$/.test(installedPlugin.privacyDigest) &&
      installedPlugin.events?.[0]?.id === "resend.send" &&
      installedPlugin.events?.[0]?.version === 1,
    "Plugin lifecycle metadata is incomplete",
  );

  const tracked = [
    "package.json",
    "package-lock.json",
    "amplio.json",
    installedPlugin.baseArchive,
    installedPlugin.stateArchive,
    "src/app.ts",
    "src/email.ts",
    "telemetry/events/http-request.ts",
    "telemetry/plugins/resend.ts",
  ];
  const firstInstall = new Map(
    tracked.map((relative) => [relative, read(path.join(project, relative))]),
  );
  run(amplio, ["add", "plugin", "resend", "--event", "http.request", "--yes"], {
    cwd: project,
    stdio: "inherit",
  });
  for (const [relative, expected] of firstInstall) {
    assert(
      read(path.join(project, relative)) === expected,
      `idempotent add changed ${relative}`,
    );
  }
  assert(
    readJson(path.join(project, "package.json")).dependencies.resend ===
      resendVersionInstalled,
    "add plugin changed the application's Resend dependency range",
  );
  const cleanDiff = run(amplio, ["diff", "plugin", "resend"], {
    cwd: project,
  });
  assert(
    cleanDiff.includes("local source: unchanged") &&
      cleanDiff.includes("registry source: current"),
    "fresh Plugin install did not have clean lifecycle provenance",
  );

  writeFileSync(
    path.join(project, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: ["node"],
        },
        include: ["src/**/*.ts", "telemetry/**/*.ts"],
      },
      null,
      2,
    )}\n`,
  );

  run(path.join(project, "node_modules/.bin/tsc"), ["--noEmit"], {
    cwd: project,
    stdio: "inherit",
  });
  const output = run(
    path.join(project, "node_modules/.bin/tsx"),
    ["src/app.ts"],
    {
      cwd: project,
      env: {
        ...process.env,
        NODE_ENV: "test",
        RESEND_API_KEY: "re_private_publish_smoke_key",
      },
    },
  );
  const records = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line);
        return parsed && typeof parsed === "object" && "@event" in parsed
          ? [parsed]
          : [];
      } catch {
        return [];
      }
    });

  assert(
    records.length === 1,
    `expected one root Event record, received ${records.length}`,
  );
  const record = records[0];
  assert(
    record["@event"] === "http.request",
    "root Event id is not http.request",
  );
  assert(record["@event_version"] === 1, "root Event version is not 1");
  assert(record.success === true, "root Event did not succeed");
  assert(
    record.http?.method === "POST",
    "root Event lost the native HTTP method",
  );
  assert(
    record.http?.route === "/send",
    "root Event did not use the stable Hono route",
  );
  assert(
    record.http?.status === 201,
    "root Event did not preserve the 201 response",
  );
  assert(
    Array.isArray(record.email?.sends),
    "Resend subtree is not repeated under email.sends",
  );
  assert(
    record.email.sends.length === 1,
    "expected one nested Resend occurrence",
  );
  assert(
    record.email.sends[0].provider === "resend",
    "Resend provider field is missing",
  );
  assert(
    record.email.sends[0].template === "welcome-email",
    "explicit template tag was not projected",
  );
  assert(
    record.email.sends[0].success === true,
    "Resend occurrence did not succeed",
  );

  const serialized = JSON.stringify(record);
  for (const secret of [
    "private-recipient@example.com",
    "sender@example.com",
    "Sensitive publish smoke subject",
    "private publish smoke body",
    "re_private_publish_smoke_key",
    "publish-smoke-query-token",
  ]) {
    assert(
      !serialized.includes(secret),
      `telemetry leaked ${JSON.stringify(secret)}`,
    );
  }
  assertNoForbiddenKeys(
    record,
    new Set([
      "to",
      "cc",
      "bcc",
      "from",
      "subject",
      "html",
      "text",
      "react",
      "key",
      "url",
      "path",
      "query",
      "headers",
      "cookies",
      "body",
    ]),
  );

  run(amplio, ["remove", "plugin", "resend"], {
    cwd: project,
    stdio: "inherit",
  });
  assert(
    !existsSync(path.join(project, "telemetry/plugins/resend.ts")),
    "remove plugin retained the installed Resend source",
  );
  assert(
    !existsSync(path.join(project, installedPlugin.stateArchive)),
    "remove plugin retained the installed Resend state snapshot",
  );
  for (const [relative, expected] of beforePluginInstall) {
    assert(
      read(path.join(project, relative)) === expected,
      `remove plugin did not reverse managed wiring in ${relative}`,
    );
  }
  const removedConfig = readJson(path.join(project, "amplio.json"));
  assert(
    removedConfig.plugins?.resend === undefined &&
      removedConfig.plugins?.hono?.role === "boundary",
    "remove plugin did not preserve the remaining Hono boundary metadata",
  );
  assert(
    readJson(path.join(project, "package.json")).dependencies.resend ===
      resendVersionInstalled,
    "remove plugin removed the host-owned Resend dependency",
  );
  run(path.join(project, "node_modules/.bin/tsc"), ["--noEmit"], {
    cwd: project,
    stdio: "inherit",
  });

  console.log("publish-smoke ok");
  console.log(
    JSON.stringify({
      coreTgz,
      cliTgz,
      status: record.http.status,
      rootEvent: record["@event"],
      nestedPluginEvent: "resend.send",
      rootRecords: records.length,
    }),
  );
} finally {
  rmSync(staging, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
}
