import fs from "node:fs/promises";
import path from "node:path";
import {
  renderAmplioConfig,
  renderConsoleSinkTemplate,
  renderRuntimeTemplate,
} from "../templates/init.js";
import { renderHttpRequestEventTemplate } from "../templates/vnext.js";
import {
  assertRegistryExists,
  findRegistryItem,
  loadRegistry,
  readRegistryFileContent,
} from "../registry/resolve.js";
import {
  codeMask,
  hasLiveNamedImport,
  importedProviderBindings,
  planBoundaryPluginWiring,
} from "../registry/plugin-install.js";
import {
  assertPluginCacheContained,
  assertPluginStatePathsContained,
  contentHash,
  planPluginState,
  type PluginInstallMetadata,
} from "../registry/plugin-state.js";
import { resolveRegistryPath, resolveTelemetryDir } from "../utils/config.js";
import { getCliVersion } from "../utils/cli-version.js";
import { detectFramework } from "../utils/detect-framework.js";
import { detectPackageManager } from "../utils/detect-package-manager.js";
import { ensureDir, pathExists } from "../utils/fs.js";
import { normalizeGeneratedLocalImports } from "../utils/generated-imports.js";
import { ensureRuntimeDependencies } from "../utils/install-deps.js";
import {
  restorePackageMutationFiles,
  snapshotPackageMutationFiles,
} from "../utils/package-mutation.js";
import { resolveProjectPaths } from "../utils/paths.js";
import { registryPathForConfig } from "../utils/registry-path.js";
import { writeTsconfigPathsAlias } from "../utils/tsconfig-paths.js";

const DEFAULT_SERVICE = "my-app";

interface InitFileSnapshot {
  path: string;
  existed: boolean;
  content?: string;
}

interface ScaffoldFileMetadata {
  path: string;
  installedDigest: string;
}

interface ScaffoldMetadata {
  version: 1;
  files: Record<string, ScaffoldFileMetadata>;
}

export interface InitOptions {
  cwd: string;
  service?: string;
  packageManager?: "pnpm" | "npm" | "yarn" | "bun";
  yes?: boolean;
  skipInstall?: boolean;
  paths?: boolean;
  verbose?: boolean;
  force?: boolean;
}

async function assertInitManagedFileAdoptable(options: {
  cwd: string;
  file: string;
  expected: string;
  tracked: boolean;
  supportsExisting?: (source: string) => boolean;
  force?: boolean;
}): Promise<void> {
  if (!(await pathExists(options.file))) return;
  let existing: string;
  try {
    existing = await fs.readFile(options.file, "utf8");
  } catch {
    throw new Error(
      `${path.relative(options.cwd, options.file)} already exists but is not an adoptable generated source file. Move it or rerun init with a regular file. No files were changed.`,
    );
  }
  if (
    existing === options.expected ||
    (options.tracked && options.supportsExisting?.(existing) === true) ||
    options.force
  )
    return;
  throw new Error(
    `${path.relative(options.cwd, options.file)} is an untracked generated file that differs from the Amplio template. Rerun with --force to overwrite it transactionally. No files were changed.`,
  );
}

function hasGeneratedScaffoldProvenance(
  scaffold: ScaffoldMetadata | undefined,
  key: string,
  cwd: string,
  file: string,
): boolean {
  const metadata = scaffold?.files[key];
  return (
    metadata?.path === path.relative(cwd, file).replace(/\\/g, "/") &&
    /^sha256-[a-f0-9]{64}$/.test(metadata.installedDigest)
  );
}

async function defaultService(cwd: string): Promise<string> {
  try {
    const pkg = JSON.parse(
      await fs.readFile(path.join(cwd, "package.json"), "utf8"),
    ) as { name?: string };
    return pkg.name?.trim().replace(/^@[^/]+\//, "") || DEFAULT_SERVICE;
  } catch {
    return DEFAULT_SERVICE;
  }
}

function scriptCommand(packageManager: string, script: string): string {
  return packageManager === "npm" || packageManager === "bun"
    ? `${packageManager} run ${script}`
    : `${packageManager} ${script}`;
}

function cliInstallCommand(packageManager: string): string {
  const cli = `@useamplio/cli@${getCliVersion()}`;
  if (packageManager === "npm") return `npm install -D ${cli}`;
  if (packageManager === "bun") return `bun add -d ${cli}`;
  return `${packageManager} add -D ${cli}`;
}

async function ensureAmplioScript(
  cwd: string,
  packageManager: string,
): Promise<void> {
  const packagePath = path.join(cwd, "package.json");
  if (!(await pathExists(packagePath))) return;
  try {
    const raw = await fs.readFile(packagePath, "utf8");
    const pkg = JSON.parse(raw) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    if (!pkg.scripts?.amplio) {
      pkg.scripts = { ...pkg.scripts, amplio: "amplio" };
      await fs.writeFile(
        packagePath,
        `${JSON.stringify(pkg, null, 2)}\n`,
        "utf8",
      );
      console.log(
        `  ✓ package.json (run \`${scriptCommand(packageManager, "amplio doctor")}\`)`,
      );
    }
    const hasCli =
      pkg.dependencies?.["@useamplio/cli"] !== undefined ||
      pkg.devDependencies?.["@useamplio/cli"] !== undefined;
    if (!hasCli) {
      console.log(
        `\nInstall the CLI for the generated script:\n  ${cliInstallCommand(packageManager)}`,
      );
    }
  } catch {
    // A malformed host package stays application-owned.
  }
}

async function snapshot(filePath: string): Promise<InitFileSnapshot> {
  const existed = await pathExists(filePath);
  return {
    path: filePath,
    existed,
    ...(existed ? { content: await fs.readFile(filePath, "utf8") } : {}),
  };
}

async function restore(snapshots: InitFileSnapshot[]): Promise<void> {
  for (const entry of [...snapshots].reverse()) {
    if (entry.existed) {
      await fs.writeFile(entry.path, entry.content!, "utf8");
    } else {
      await fs.rm(entry.path, { force: true });
    }
  }
}

export async function runInit(options: InitOptions): Promise<void> {
  const telemetryDir = await resolveTelemetryDir(options.cwd);
  const packageManager =
    options.packageManager ?? (await detectPackageManager(options.cwd));
  const service =
    options.service?.trim() || (await defaultService(options.cwd));
  const registryPath = await resolveRegistryPath(options.cwd);
  const registry = registryPathForConfig(options.cwd, registryPath);
  const paths = resolveProjectPaths(options.cwd, telemetryDir);
  const detected = await detectFramework(options.cwd);
  const extensionlessGeneratedImports = detected === "next";
  const includeHono = options.yes === true && detected === "hono";

  const boundaryPlan = includeHono
    ? await (async () => {
        await assertRegistryExists(registryPath);
        const manifest = await loadRegistry(registryPath);
        const item = findRegistryItem(manifest, "plugin-hono");
        if (!item) {
          throw new Error(
            'Detected Hono, but the registry has no "plugin-hono" recipe. No files were changed.',
          );
        }
        const sourceFile = item.files.find(
          (file) =>
            file.target?.replace(/\\/g, "/") === "plugins/hono.ts" ||
            file.target?.replace(/\\/g, "/").endsWith("/plugins/hono.ts") ===
              true,
        );
        if (!sourceFile) {
          throw new Error(
            'Detected Hono, but the "plugin-hono" recipe has no editable source. No files were changed.',
          );
        }
        const wiring = await planBoundaryPluginWiring({
          cwd: options.cwd,
          telemetryDir,
          item,
          allowMissingDependencies: true,
          deferEventContractValidation: true,
          // Exact-byte adoption is checked centrally below, before dependency
          // installation. Seam discovery must not preempt the --force path.
          allowPluginOverwrite: true,
        });
        return {
          item,
          wiring,
          recipePath: sourceFile.path,
          recipeSource: normalizeGeneratedLocalImports(
            await readRegistryFileContent(
              registryPath,
              sourceFile.path,
              sourceFile.content,
            ),
            extensionlessGeneratedImports,
          ),
        };
      })()
    : undefined;
  if (boundaryPlan) await assertPluginCacheContained(options.cwd);

  const defaultConfigSource = renderAmplioConfig({
    ...(registry ? { registry } : {}),
    packageManager,
    telemetryDir,
  });
  const existingConfigSource = (await pathExists(paths.config))
    ? await fs.readFile(paths.config, "utf8")
    : undefined;
  const config = JSON.parse(
    existingConfigSource ?? defaultConfigSource,
  ) as Record<string, unknown>;
  const existingScaffold = config.scaffold as ScaffoldMetadata | undefined;
  const existingHono = (
    config.plugins as Record<string, PluginInstallMetadata> | undefined
  )?.hono;
  const plannedCompositionRoot = boundaryPlan
    ? path
        .relative(options.cwd, boundaryPlan.wiring.compositionPath)
        .replace(/\\/g, "/")
    : undefined;
  if (
    boundaryPlan &&
    existingHono &&
    existingHono.sourceOnly !== true &&
    existingHono.compositionRoot !== plannedCompositionRoot
  ) {
    throw new Error(
      `Plugin "hono" is already active at ${existingHono.compositionRoot}; refusing to retarget it to ${plannedCompositionRoot}. Remove and reinstall the Plugin explicitly. No files were changed.`,
    );
  }

  const runtimeSource = normalizeGeneratedLocalImports(
    renderRuntimeTemplate(
      service,
      scriptCommand(packageManager, "amplio doctor"),
    ),
    extensionlessGeneratedImports,
  );
  const consoleSinkSource = normalizeGeneratedLocalImports(
    renderConsoleSinkTemplate(),
    extensionlessGeneratedImports,
  );
  const httpRequestSource = normalizeGeneratedLocalImports(
    renderHttpRequestEventTemplate(),
    extensionlessGeneratedImports,
  );
  const managedClosure = [
    {
      key: "runtime",
      file: paths.runtime,
      expected: runtimeSource,
      tracked: hasGeneratedScaffoldProvenance(
        existingScaffold,
        "runtime",
        options.cwd,
        paths.runtime,
      ),
      supportsExisting: (source: string) => {
        const mask = codeMask(source);
        return (
          importedProviderBindings(source, "@useamplio/amplio", "init").some(
            (binding) => binding === "init",
          ) &&
          ["./sinks/console", "./sinks/console.js"].some((specifier) =>
            hasLiveNamedImport(source, specifier, "consoleSink"),
          ) &&
          /\binit\s*\(\s*\{[\s\S]*?\bservice\s*:[\s\S]*?\benv\s*:[\s\S]*?\bsinks\s*:\s*\[[^\]]*\bconsoleSink\b/.test(
            mask,
          )
        );
      },
    },
    {
      key: "consoleSink",
      file: path.join(paths.sinks, "console.ts"),
      expected: consoleSinkSource,
      tracked: hasGeneratedScaffoldProvenance(
        existingScaffold,
        "consoleSink",
        options.cwd,
        path.join(paths.sinks, "console.ts"),
      ),
      supportsExisting: (source: string) =>
        /\bexport\s+const\s+consoleSink\s*:\s*Sink\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(
          codeMask(source),
        ),
    },
    {
      key: "httpRequest",
      file: path.join(paths.events, "http-request.ts"),
      expected: httpRequestSource,
      tracked: hasGeneratedScaffoldProvenance(
        existingScaffold,
        "httpRequest",
        options.cwd,
        path.join(paths.events, "http-request.ts"),
      ),
      supportsExisting: (source: string) => {
        const mask = codeMask(source);
        return (
          /\bexport\s+const\s+HttpRequest\s*=\s*event\s*\(\s*\{/.test(mask) &&
          /\bid\s*:\s*["']http\.request["']/.test(source) &&
          /\bversion\s*:\s*\d+/.test(mask) &&
          /\bschema\s*:\s*z\.object\s*\(\s*\{[\s\S]*?\brequest_id\s*:[\s\S]*?\bhttp\s*:\s*z\.object\s*\(\s*\{[\s\S]*?\bmethod\s*:[\s\S]*?\broute\s*:[\s\S]*?\bstatus\s*:/.test(
            mask,
          ) &&
          /\btree\s*:\s*\{/.test(mask) &&
          /\bexport\s+function\s+resolveRequestId\s*\(/.test(mask) &&
          /^[ \t]*\/\/ amplio:plugin-imports[ \t]*$/m.test(source) &&
          /^[ \t]*\/\/ amplio:plugins[ \t]*$/m.test(source)
        );
      },
    },
    ...(boundaryPlan
      ? [
          {
            key: "honoPlugin",
            file: path.join(paths.plugins, "hono.ts"),
            expected: boundaryPlan.recipeSource,
            tracked: existingHono !== undefined,
            supportsExisting: (source: string) =>
              /\bexport\s+(?:(?:async\s+)?function|const|let|var)\s+HonoPlugin\b/.test(
                codeMask(source),
              ),
          },
        ]
      : []),
  ];
  for (const entry of managedClosure) {
    await assertInitManagedFileAdoptable({
      cwd: options.cwd,
      ...entry,
      force: options.force,
    });
  }
  config.scaffold = {
    version: 1,
    files: Object.fromEntries(
      managedClosure
        .filter((entry) => entry.key !== "honoPlugin")
        .map((entry) => [
          entry.key,
          {
            path: path.relative(options.cwd, entry.file).replace(/\\/g, "/"),
            installedDigest: contentHash(entry.expected),
          },
        ]),
    ),
  } satisfies ScaffoldMetadata;

  const initSnapshotPaths = [
    paths.config,
    ...managedClosure.map((entry) => entry.file),
    path.join(options.cwd, "tsconfig.json"),
    ...(boundaryPlan
      ? [
          boundaryPlan.wiring.compositionPath,
          path.join(
            options.cwd,
            ".amplio",
            "bases",
            `${contentHash(boundaryPlan.recipeSource)}.json`,
          ),
          path.join(options.cwd, ".amplio", "installs", "hono.json"),
        ]
      : []),
  ];
  const initSnapshots = await Promise.all(
    [...new Set(initSnapshotPaths)].map((file) => snapshot(file)),
  );

  const packageSnapshots = await snapshotPackageMutationFiles(
    options.cwd,
    packageManager,
    "init dependency install",
  );
  try {
    const dependencyStatus = await ensureRuntimeDependencies({
      cwd: options.cwd,
      packageManager,
      skipInstall: options.skipInstall,
      withCliDevDependency: true,
      verbose: options.verbose,
    });
    if (dependencyStatus === "manual") {
      throw new Error(
        "Runtime dependencies are not installed; init aborted before writing files.",
      );
    }

    await Promise.all([
      ensureDir(paths.telemetry),
      ensureDir(paths.events),
      ensureDir(paths.plugins),
      ensureDir(paths.sinks),
    ]);

    const generated: Array<{
      file: string;
      status: "created" | "updated" | "skipped";
    }> = [];
    const write = async (
      file: string,
      source: string,
      overwrite = false,
    ): Promise<void> => {
      const existed = await pathExists(file);
      const existing = existed ? await fs.readFile(file, "utf8") : undefined;
      const status = !existed
        ? "created"
        : existing === source
          ? "skipped"
          : options.force || overwrite
            ? "updated"
            : "skipped";
      if (status === "created" || status === "updated") {
        await ensureDir(path.dirname(file));
        await fs.writeFile(file, source, "utf8");
      }
      generated.push({ file, status });
    };
    let boundaryState: ReturnType<typeof planPluginState> | undefined;
    if (boundaryPlan) {
      const existing = existingHono;
      const compositionRoot = plannedCompositionRoot!;
      const pluginPath = path.join(paths.plugins, "hono.ts");
      const compositionBefore = await fs.readFile(
        boundaryPlan.wiring.compositionPath,
        "utf8",
      );
      boundaryState =
        existing?.recipeDigest &&
        existing.baseArchive &&
        existing.stateArchive &&
        existing.sourceOnly !== true
          ? undefined
          : planPluginState({
              cwd: options.cwd,
              slug: "hono",
              item: boundaryPlan.item,
              role: "boundary",
              sourcePath: pluginPath,
              recipePath: boundaryPlan.recipePath,
              recipeSource: boundaryPlan.recipeSource,
              ...(boundaryPlan.item.events?.[0]?.id
                ? { event: boundaryPlan.item.events[0].id }
                : {}),
              compositionRoot,
              wiring: [
                {
                  file: compositionRoot,
                  kind: "boundary-registration",
                  anchor: "HonoPlugin",
                  before: compositionBefore,
                  installed: boundaryPlan.wiring.compositionSource,
                },
              ],
            });
      if (boundaryState) {
        await assertPluginStatePathsContained(options.cwd, boundaryState);
      }
      config.plugins = {
        ...((config.plugins as Record<string, unknown> | undefined) ?? {}),
        hono: boundaryState?.metadata ?? existing!,
      };
    }
    const configSource = `${JSON.stringify(config, null, 2)}\n`;
    if (!boundaryPlan) await write(paths.config, configSource, true);
    await write(paths.runtime, runtimeSource);
    await write(path.join(paths.sinks, "console.ts"), consoleSinkSource);
    await write(path.join(paths.events, "http-request.ts"), httpRequestSource);
    if (boundaryPlan) {
      const writes = [
        { path: paths.config, content: configSource, preserveExisting: false },
        {
          path: path.join(paths.plugins, "hono.ts"),
          content: boundaryPlan.recipeSource,
          preserveExisting: options.force !== true,
        },
        {
          path: boundaryPlan.wiring.compositionPath,
          content: boundaryPlan.wiring.compositionSource,
          preserveExisting: false,
        },
        ...(boundaryState
          ? [
              {
                path: boundaryState.baseArchivePath,
                content: boundaryState.baseArchiveContent,
                preserveExisting: true,
              },
              {
                path: boundaryState.stateArchivePath,
                content: boundaryState.stateArchiveContent,
                preserveExisting: true,
              },
            ]
          : []),
      ];
      const snapshots = await Promise.all(
        writes.map((entry) => snapshot(entry.path)),
      );
      try {
        for (const [index, entry] of writes.entries()) {
          const before = snapshots[index]!;
          const content =
            before.existed && entry.preserveExisting
              ? before.content!
              : entry.content;
          const status = !before.existed
            ? "created"
            : before.content === content
              ? "skipped"
              : "updated";
          if (status !== "skipped") {
            await ensureDir(path.dirname(entry.path));
            await fs.writeFile(entry.path, content, "utf8");
          }
          generated.push({ file: entry.path, status });
        }
      } catch (error) {
        await restore(snapshots);
        throw error;
      }
    }

    console.log("amplio init");
    for (const { file, status } of generated) {
      console.log(
        `  ${status === "created" ? "✓" : status === "updated" ? "↻" : "·"} ${path.relative(options.cwd, file)}`,
      );
    }
    if (options.yes && detected && detected !== "hono") {
      console.log(
        `  ! ${detected} detected, but this slice only ships the Hono boundary Plugin`,
      );
    }

    await ensureAmplioScript(options.cwd, packageManager);

    const applyPaths =
      options.paths ??
      (options.yes === true &&
        (await pathExists(path.join(options.cwd, "tsconfig.json"))));
    if (applyPaths) await writeTsconfigPathsAlias(options.cwd, telemetryDir);
  } catch (error) {
    try {
      await restore(initSnapshots);
    } finally {
      await restorePackageMutationFiles(packageSnapshots);
    }
    throw error;
  }
}
