import { loadRegistry, assertRegistryExists } from "../registry/resolve.js";
import type { RegistryItem } from "../registry/types.js";
import { resolveRegistryPath } from "../utils/config.js";

const KINDS = ["event", "plugin", "sink", "enricher"] as const;
type Kind = (typeof KINDS)[number];

export interface ListItem {
  id: string;
  kind: Kind;
  name: string;
  title?: string;
  description?: string;
}

export interface ListOptions {
  cwd: string;
  kind?: string;
  json?: boolean;
}

function kindOf(item: RegistryItem): Kind | undefined {
  const declared = item.kind;
  if (KINDS.includes(declared as Kind)) return declared as Kind;
  return KINDS.find((kind) => item.name.startsWith(`${kind}-`));
}

function idOf(item: RegistryItem, kind: Kind): string {
  if (kind === "event" && item.events?.[0]?.id) return item.events[0].id;
  return item.name.slice(kind.length + 1);
}

function normalizeKind(value: string | undefined): Kind | undefined {
  if (!value) return undefined;
  const singular = value.endsWith("s") ? value.slice(0, -1) : value;
  if (!KINDS.includes(singular as Kind)) {
    throw new Error(`Unknown kind "${value}". Use: ${KINDS.join(", ")}`);
  }
  return singular as Kind;
}

export async function runList(options: ListOptions): Promise<void> {
  const registryPath = await resolveRegistryPath(options.cwd);
  await assertRegistryExists(registryPath);
  const manifest = await loadRegistry(registryPath);
  const filter = normalizeKind(options.kind);
  const items: ListItem[] = manifest.items.flatMap((item) => {
    const kind = kindOf(item);
    if (!kind || (filter && kind !== filter)) return [];
    return [
      {
        id: idOf(item, kind),
        kind,
        name: item.name,
        ...(item.title ? { title: item.title } : {}),
        ...(item.description ? { description: item.description } : {}),
      },
    ];
  });
  items.sort(
    (left, right) =>
      KINDS.indexOf(left.kind) - KINDS.indexOf(right.kind) ||
      left.name.localeCompare(right.name),
  );

  if (options.json) {
    console.log(JSON.stringify(items, null, 2));
    return;
  }
  for (const kind of KINDS) {
    const group = items.filter((item) => item.kind === kind);
    if (group.length === 0) continue;
    console.log(`${kind}s:`);
    for (const item of group) {
      const description = item.description ? ` — ${item.description}` : "";
      console.log(
        `  ${item.id}${item.title ? ` — ${item.title}` : ""} (${item.name})${description}`,
      );
    }
    console.log("");
  }
  console.log(`Total: ${items.length}`);
  console.log("Add with: amplio add <event|plugin|sink|enricher> <id>");
}
