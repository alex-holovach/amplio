import { resolveRegistryPath } from "../utils/config.js";
import { assertRegistryExists, loadRegistry } from "../registry/resolve.js";
import type { RegistryItem } from "../registry/types.js";

const KINDS = ["event", "middleware", "sink", "enricher", "integration"] as const;
type Kind = (typeof KINDS)[number];

function kindOf(name: string): Kind | "other" {
  for (const kind of KINDS) {
    if (name.startsWith(`${kind}-`)) return kind;
  }
  return "other";
}

function shortId(name: string, kind: Kind | "other"): string {
  if (kind === "other") return name;
  return name.slice(kind.length + 1);
}

export interface ListOptions {
  cwd: string;
  kind?: string;
}

export async function runList(options: ListOptions): Promise<void> {
  const kindFilter = options.kind?.replace(/s$/, "");
  if (kindFilter && !KINDS.includes(kindFilter as Kind) && kindFilter !== "other") {
    throw new Error(
      `Unknown kind "${options.kind}". Use: ${KINDS.join(", ")}`,
    );
  }

  const registryPath = await resolveRegistryPath(options.cwd);
  await assertRegistryExists(registryPath);
  const manifest = await loadRegistry(registryPath);

  const grouped = new Map<string, RegistryItem[]>();
  for (const item of manifest.items) {
    const kind = kindOf(item.name);
    if (kindFilter && kind !== kindFilter) continue;
    const list = grouped.get(kind) ?? [];
    list.push(item);
    grouped.set(kind, list);
  }

  const order: Array<Kind | "other"> = [...KINDS, "other"];
  let total = 0;
  for (const kind of order) {
    const list = grouped.get(kind);
    if (!list?.length) continue;
    list.sort((a, b) => a.name.localeCompare(b.name));
    console.log(`${kind}s:`);
    for (const item of list) {
      const id = shortId(item.name, kind);
      const desc = item.description ? ` — ${item.description}` : "";
      if (item.title) {
        console.log(`  ${id} — ${item.title} (${item.name})${desc}`);
      } else {
        console.log(`  ${id}  (${item.name})${desc}`);
      }
    }
    console.log("");
    total += list.length;
  }

  if (total === 0) {
    console.log(kindFilter ? `No ${kindFilter} items in registry.` : "Registry is empty.");
    return;
  }

  console.log(`Total: ${total}`);
  console.log(`Add with: amplio add <kind> <id>`);
}
