#!/usr/bin/env node
import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { maxSatisfying, prerelease } from "semver";

const execFileAsync = promisify(execFile);
const cliRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repoRoot = path.resolve(cliRoot, "../..");
const manifestPath = path.join(repoRoot, "registry/registry.manifest.json");
const registryRoot = path.join(repoRoot, "registry");
const coreRoot = path.join(repoRoot, "packages/amplio");
const fixtureRoot = path.join(
  cliRoot,
  "scripts/provider-compatibility/fixtures",
);

export async function readProviderCompatibilityManifest() {
  return JSON.parse(await readFile(manifestPath, "utf8"));
}

export function providerCompatibilityMatrix(manifest) {
  return manifest.items
    .filter((item) => item.kind === "plugin")
    .flatMap((item) => {
      const ranges = Object.entries(item.providerRanges ?? {});
      const tested = Object.entries(item.testedProviderVersions ?? {});
      if (ranges.length !== 1 || tested.length !== 1) {
        throw new Error(
          `${item.name} must declare exactly one provider range and tested-version entry`,
        );
      }
      const [provider] = ranges[0];
      const [testedProvider, versions] = tested[0];
      if (provider !== testedProvider) {
        throw new Error(
          `${item.name} tested provider ${testedProvider} does not match ${provider}`,
        );
      }
      return [
        {
          plugin: item.name,
          provider,
          slot: "minimum",
          version: versions.minimum,
        },
        {
          plugin: item.name,
          provider,
          slot: "latest",
          version: versions.latest,
        },
      ];
    });
}

async function publishedVersions(provider) {
  const { stdout } = await execFileAsync(
    "npm",
    ["view", provider, "versions", "--json"],
    { cwd: repoRoot, maxBuffer: 10 * 1024 * 1024 },
  );
  const parsed = JSON.parse(stdout);
  return (Array.isArray(parsed) ? parsed : [parsed]).filter(
    (version) => typeof version === "string",
  );
}

export async function verifyLatestProviderVersions(manifest) {
  const failures = [];
  const plugins = manifest.items.filter((item) => item.kind === "plugin");
  await Promise.all(
    plugins.map(async (item) => {
      const [provider, range] =
        Object.entries(item.providerRanges ?? {})[0] ?? [];
      const versions = item.testedProviderVersions?.[provider];
      if (!provider || !range || !versions) {
        failures.push(`${item.name}: missing provider compatibility metadata`);
        return;
      }
      const published = await publishedVersions(provider);
      const latest = maxSatisfying(
        published.filter((version) => prerelease(version) === null),
        range,
      );
      if (!latest) {
        failures.push(`${item.name}: no stable npm version satisfies ${range}`);
      } else if (versions.latest !== latest) {
        failures.push(
          `${item.name}: recorded latest ${versions.latest}; npm latest satisfying ${range} is ${latest}`,
        );
      }
    }),
  );
  if (failures.length > 0) {
    throw new Error(failures.sort().join("\n"));
  }
}

function registryClosure(manifest, rootItem) {
  const byName = new Map(manifest.items.map((item) => [item.name, item]));
  const ordered = [];
  const visited = new Set();
  const visit = (item) => {
    if (visited.has(item.name)) return;
    visited.add(item.name);
    for (const dependency of item.registryDependencies ?? []) {
      const resolved = byName.get(dependency.replace(/^@useamplio\//, ""));
      if (!resolved) {
        throw new Error(
          `${item.name}: unknown registry dependency ${dependency}`,
        );
      }
      visit(resolved);
    }
    ordered.push(item);
  };
  visit(rootItem);
  return ordered;
}

function splitPackageSpec(spec) {
  const at = spec.lastIndexOf("@");
  if (at <= 0) return [spec, "latest"];
  return [spec.slice(0, at), spec.slice(at + 1) || "latest"];
}

function compatibilityPlan(manifest, pluginName, slot) {
  if (slot !== "minimum" && slot !== "latest") {
    throw new Error(`Unknown compatibility slot ${slot}`);
  }
  const item = manifest.items.find(
    (candidate) => candidate.name === pluginName && candidate.kind === "plugin",
  );
  if (!item) throw new Error(`Unknown registry Plugin ${pluginName}`);
  const [provider] = Object.keys(item.providerRanges ?? {});
  const version = item.testedProviderVersions?.[provider]?.[slot];
  if (!provider || !version) {
    throw new Error(`${pluginName}: incomplete tested provider metadata`);
  }
  return {
    item,
    closure: registryClosure(manifest, item),
    plugin: pluginName,
    provider,
    slot,
    version,
  };
}

async function runCommand(command, args, cwd) {
  try {
    return await execFileAsync(command, args, {
      cwd,
      env: { ...process.env, FORCE_COLOR: "0" },
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (error) {
    const stdout = typeof error?.stdout === "string" ? error.stdout : "";
    const stderr = typeof error?.stderr === "string" ? error.stderr : "";
    throw new Error(
      [`${command} ${args.join(" ")} failed`, stdout, stderr]
        .filter(Boolean)
        .join("\n"),
      { cause: error },
    );
  }
}

async function writeCompatibilityProject(plan, projectRoot) {
  const dependencies = {
    "@types/node": "22.13.10",
    "@useamplio/amplio": pathToFileURL(coreRoot).href,
    typescript: "5.8.3",
  };
  for (const item of plan.closure) {
    for (const spec of [
      ...(item.dependencies ?? []),
      ...(item.devDependencies ?? []),
    ]) {
      const [name, version] = splitPackageSpec(spec);
      if (name !== "@useamplio/amplio" && name !== plan.provider) {
        dependencies[name] = version;
      }
    }
  }
  dependencies[plan.provider] = plan.version;
  const nextBundler = plan.plugin === "plugin-next";

  await writeFile(
    path.join(projectRoot, "package.json"),
    `${JSON.stringify(
      {
        name: `amplio-${plan.plugin}-${plan.slot}-compatibility`,
        private: true,
        type: "module",
        dependencies,
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(projectRoot, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: nextBundler ? "ESNext" : "NodeNext",
          moduleResolution: nextBundler ? "Bundler" : "NodeNext",
          lib: ["ES2022", "DOM", "DOM.Iterable"],
          strict: true,
          skipLibCheck: true,
          noUncheckedIndexedAccess: true,
          exactOptionalPropertyTypes: false,
          esModuleInterop: true,
          forceConsistentCasingInFileNames: true,
          rootDir: ".",
          outDir: "dist",
        },
        include: ["compatibility.ts", "telemetry/**/*.ts"],
      },
      null,
      2,
    )}\n`,
  );
  for (const item of plan.closure) {
    const target = path.join(projectRoot, item.target);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(
      target,
      await readFile(path.join(registryRoot, item.source), "utf8"),
    );
  }
  await writeFile(
    path.join(projectRoot, "compatibility.ts"),
    await readFile(path.join(fixtureRoot, `${plan.plugin}.ts`), "utf8"),
  );
}

export async function runProviderCompatibility(manifest, pluginName, slot) {
  const plan = compatibilityPlan(manifest, pluginName, slot);
  await access(path.join(coreRoot, "dist/index.js")).catch(() => {
    throw new Error(
      "Amplio core must be built before provider compatibility runs: pnpm --filter @useamplio/amplio build",
    );
  });
  const projectRoot = await mkdtemp(
    path.join(os.tmpdir(), `amplio-${pluginName}-${slot}-`),
  );
  let passed = false;
  try {
    await writeCompatibilityProject(plan, projectRoot);
    await runCommand(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
      ],
      projectRoot,
    );
    const installed = JSON.parse(
      await readFile(
        path.join(projectRoot, "node_modules", plan.provider, "package.json"),
        "utf8",
      ),
    ).version;
    if (installed !== plan.version) {
      throw new Error(
        `${plan.provider}: expected exact ${plan.version}, installed ${installed}`,
      );
    }
    await runCommand(
      process.execPath,
      [path.join(projectRoot, "node_modules/typescript/bin/tsc")],
      projectRoot,
    );
    await runCommand(process.execPath, ["dist/compatibility.js"], projectRoot);
    passed = true;
    process.stdout.write(
      `PASS ${plan.plugin} ${plan.slot}: ${plan.provider}@${plan.version}\n`,
    );
  } finally {
    if (passed && process.env.AMPLIO_KEEP_COMPAT_FIXTURE !== "1") {
      await rm(projectRoot, { recursive: true, force: true });
    } else if (!passed) {
      console.error(`Compatibility fixture retained at ${projectRoot}`);
    }
  }
}

async function main() {
  const [command, plugin, slot] = process.argv.slice(2);
  const manifest = await readProviderCompatibilityManifest();
  if (command === "matrix") {
    process.stdout.write(
      `${JSON.stringify({ include: providerCompatibilityMatrix(manifest) })}\n`,
    );
    return;
  }
  if (command === "verify-latest") {
    await verifyLatestProviderVersions(manifest);
    process.stdout.write("Provider latest-version metadata is current.\n");
    return;
  }
  if (command === "run" && plugin && slot) {
    await runProviderCompatibility(manifest, plugin, slot);
    return;
  }
  if (command === "run-all") {
    for (const entry of providerCompatibilityMatrix(manifest)) {
      await runProviderCompatibility(manifest, entry.plugin, entry.slot);
    }
    return;
  }
  throw new Error(
    "Usage: provider-compatibility.mjs <matrix|verify-latest|run-all|run <plugin> <minimum|latest>>",
  );
}

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
