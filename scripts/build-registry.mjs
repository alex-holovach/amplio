#!/usr/bin/env node
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hydrateRegistryPluginContracts } from "../packages/cli/src/registry/plugin-contracts.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const registryRoot = path.join(root, "registry");
const publicDir = path.join(root, "public", "r");

const TITLE_ACRONYMS = new Map([
  ["json", "JSON"],
  ["next", "Next.js"],
  ["otlp", "OTLP"],
]);

const KIND_PREFIXES = ["plugin", "sink", "enricher"];

function titleCasePart(part) {
  const lower = part.toLowerCase();
  if (TITLE_ACRONYMS.has(lower)) {
    return TITLE_ACRONYMS.get(lower);
  }
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function titleCaseWords(segments) {
  return segments.map(titleCasePart).join(" ");
}

function titleFromName(name) {
  const segments = name.split("-");

  if (name.startsWith("event-")) {
    return titleCaseWords(segments.slice(1));
  }

  const kind = KIND_PREFIXES.find((prefix) => name.startsWith(`${prefix}-`));
  if (kind) {
    const restTitle = titleCaseWords(segments.slice(1));
    const kindTitle = titleCasePart(kind);
    return `${restTitle} ${kindTitle}`;
  }

  return titleCaseWords(segments);
}

const REGISTRY_PREFIX = "@useamplio/";

function prefixRegistryDependencies(deps) {
  if (!deps) {
    return undefined;
  }
  return deps.map((dep) =>
    dep.startsWith(REGISTRY_PREFIX) ? dep : `${REGISTRY_PREFIX}${dep}`,
  );
}

function toRegistryTarget(target) {
  if (target.startsWith("~/")) {
    return target;
  }
  return `~/${target}`;
}

function pinAmplioDependencies(deps, amplioVersion) {
  return (deps ?? ["@useamplio/amplio"]).map((dep) =>
    dep === "@useamplio/amplio" ? `@useamplio/amplio@^${amplioVersion}` : dep,
  );
}

async function buildItem(item, amplioVersion) {
  const sourcePath = path.join(registryRoot, item.source);
  const content = await readFile(sourcePath, "utf8");
  const fileType = item.source.endsWith(".json")
    ? "registry:file"
    : "registry:lib";

  return {
    $schema: "https://ui.shadcn.com/schema/registry-item.json",
    name: item.name,
    title: item.title ?? titleFromName(item.name),
    description: item.description ?? `amplio registry item: ${item.name}`,
    type: "registry:lib",
    ...(item.docs ? { docs: item.docs } : {}),
    dependencies: pinAmplioDependencies(item.dependencies, amplioVersion),
    ...(item.devDependencies ? { devDependencies: item.devDependencies } : {}),
    ...(item.registryDependencies
      ? {
          registryDependencies: prefixRegistryDependencies(
            item.registryDependencies,
          ),
        }
      : {}),
    ...(item.kind === "plugin"
      ? {
          meta: {
            amplio: {
              kind: item.kind,
              role: item.role,
              recipeVersion: item.recipeVersion,
              coreRange: item.coreRange,
              providerRanges: item.providerRanges,
              testedProviderVersions: item.testedProviderVersions,
              events: item.events,
              semanticDigest: item.semanticDigest,
              nativeTransform: item.nativeTransform,
              ...(item.placement ? { placement: item.placement } : {}),
              ...(item.provider ? { provider: item.provider } : {}),
              wiringActions: item.wiringActions,
              privacy: item.privacy,
            },
          },
        }
      : {}),
    files: [
      {
        path: path.posix.join("registry", item.source),
        target: toRegistryTarget(item.target),
        type: fileType,
        content,
      },
    ],
  };
}

async function cleanOrphanedPublicItems(manifestItemNames) {
  const expected = new Set([...manifestItemNames, "registry"]);
  const existing = await readdir(publicDir).catch(() => []);

  for (const file of existing) {
    if (!file.endsWith(".json")) {
      continue;
    }
    const name = file.replace(/\.json$/, "");
    if (!expected.has(name)) {
      await unlink(path.join(publicDir, file));
      console.log(`Removed orphaned public/r/${file}`);
    }
  }
}

const PAGE_STYLE = `      :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
      body { margin: 2rem auto; max-width: 40rem; line-height: 1.5; padding: 0 1rem; }
      code { font-family: ui-monospace, monospace; }
      a { color: inherit; }`;

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// Browsable /r index: humans who hit the registry URL (or a 404 that links
// here) can see exactly which item names exist.
function renderRegistryIndexHtml(items) {
  const rows = items
    .map(
      (item) =>
        `      <li><a href="/r/${item.name}.json"><code>${item.name}</code></a> — ${escapeHtml(item.description)}</li>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>amplio registry items</title>
    <style>
${PAGE_STYLE}
    </style>
  </head>
  <body>
    <h1>amplio registry items</h1>
    <p><a href="/r/registry.json"><code>/r/registry.json</code></a> is the machine-readable index.</p>
    <ul>
${rows}
    </ul>
    <p>Install and compose a Plugin with
    <code>npx @useamplio/cli@alpha add plugin &lt;name&gt; --event &lt;event-id&gt;</code>.
    Create a project Event with <code>npx @useamplio/cli@alpha add event &lt;event-id&gt;</code>.</p>
    <p><code>npx shadcn@latest add @useamplio/&lt;item&gt;</code> copies open-code source only;
    use the Amplio CLI for a complete, tracked installation.</p>
    <p><strong>Not listed?</strong> Project Events live in your repository and do not need a hosted
    registry item.</p>
  </body>
</html>
`;
}

// Vercel serves this for any missing path — most commonly a /r/<name>.json
// miss (e.g. a generated starter event that was never a hosted registry item).
function render404Html() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>amplio registry — not found</title>
    <style>
${PAGE_STYLE}
    </style>
  </head>
  <body>
    <h1>404 — not a registry item</h1>
    <p>If you were looking for <code>/r/&lt;name&gt;.json</code>: only hosted registry items live here
    — see the <a href="/r/">item index</a> or <a href="/r/registry.json"><code>/r/registry.json</code></a>.</p>
    <p>A project Event created with
    <code>npx @useamplio/cli@alpha add event &lt;event-id&gt;</code> lives in your repository and does not
    have a registry URL. Install a listed Plugin with
    <code>npx @useamplio/cli@alpha add plugin &lt;name&gt; --event &lt;event-id&gt;</code>.</p>
  </body>
</html>
`;
}

async function main() {
  const rootPkg = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  );
  const amplioVersion = rootPkg.version;

  const manifest = JSON.parse(
    await readFile(path.join(registryRoot, "registry.manifest.json"), "utf8"),
  );
  const hydratedItems = hydrateRegistryPluginContracts(
    await Promise.all(
      manifest.items.map(async (item) => ({
        ...item,
        files: [
          {
            path: path.posix.join("registry", item.source),
            content: await readFile(
              path.join(registryRoot, item.source),
              "utf8",
            ),
          },
        ],
      })),
    ),
  );

  await mkdir(publicDir, { recursive: true });
  await cleanOrphanedPublicItems(manifest.items.map((item) => item.name));

  const builtItems = [];
  for (const item of hydratedItems) {
    const payload = await buildItem(item, amplioVersion);
    builtItems.push(payload);
    await writeFile(
      path.join(publicDir, `${item.name}.json`),
      `${JSON.stringify(payload, null, 2)}\n`,
      "utf8",
    );
  }

  const registryIndex = {
    $schema: "https://ui.shadcn.com/schema/registry.json",
    name: manifest.name,
    homepage: manifest.homepage,
    items: builtItems,
  };

  await writeFile(
    path.join(registryRoot, "registry.json"),
    `${JSON.stringify(registryIndex, null, 2)}\n`,
    "utf8",
  );

  await writeFile(
    path.join(publicDir, "registry.json"),
    `${JSON.stringify(
      {
        $schema: "https://ui.shadcn.com/schema/registry.json",
        name: manifest.name,
        homepage: manifest.homepage,
        items: builtItems.map(({ name, type, title, description }) => ({
          name,
          type,
          title,
          description,
        })),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const indexHtml = renderRegistryIndexHtml(
    builtItems.map(({ name, description }) => ({ name, description })),
  );
  await writeFile(path.join(publicDir, "index.html"), indexHtml, "utf8");
  await writeFile(path.join(root, "public", "index.html"), indexHtml, "utf8");

  await writeFile(
    path.join(root, "public", "404.html"),
    render404Html(),
    "utf8",
  );

  console.log(
    `Built ${builtItems.length} registry items → registry/registry.json, public/r/, public/index.html, and public/404.html`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
