#!/usr/bin/env node
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const registryRoot = path.join(root, "registry");
const publicDir = path.join(root, "public", "r");

const TITLE_ACRONYMS = new Map([
  ["json", "JSON"],
  ["next", "Next.js"],
  ["otlp", "OTLP"],
]);

const KIND_SUFFIXES = ["sink", "middleware", "enricher", "integration"];

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

  const kind = KIND_SUFFIXES.find((prefix) => name.startsWith(`${prefix}-`));
  if (kind) {
    const restTitle = titleCaseWords(segments.slice(1));
    const kindTitle = titleCasePart(kind);
    return `${restTitle} ${kindTitle}`;
  }

  return titleCaseWords(segments);
}

function toRegistryTarget(target) {
  if (target.startsWith("telemetry/")) {
    return `~/${target.slice("telemetry/".length)}`;
  }
  return target;
}

async function buildItem(item) {
  const sourcePath = path.join(registryRoot, item.source);
  const content = await readFile(sourcePath, "utf8");
  const fileType = item.source.endsWith(".json") ? "registry:file" : "registry:lib";

  return {
    $schema: "https://ui.shadcn.com/schema/registry-item.json",
    name: item.name,
    title: item.title ?? titleFromName(item.name),
    description: item.description ?? `amplio registry item: ${item.name}`,
    type: "registry:lib",
    dependencies: item.dependencies ?? ["@useamplio/core"],
    ...(item.devDependencies ? { devDependencies: item.devDependencies } : {}),
    ...(item.registryDependencies ? { registryDependencies: item.registryDependencies } : {}),
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

async function main() {
  const manifest = JSON.parse(
    await readFile(path.join(registryRoot, "registry.manifest.json"), "utf8"),
  );

  await mkdir(publicDir, { recursive: true });
  await cleanOrphanedPublicItems(manifest.items.map((item) => item.name));

  const builtItems = [];
  for (const item of manifest.items) {
    const payload = await buildItem(item);
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

  console.log(`Built ${builtItems.length} registry items → registry/registry.json and public/r/`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
