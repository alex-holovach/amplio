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

const DEFINE_EVENT_NAME_RE = /defineEvent\s*\(\s*["']([^"']+)["']/;

/**
 * Events are added by dot name (`amplio add event auth.user.signed_in`), not
 * by hyphenated registry id — print the dot name so the "Add with" hint works
 * verbatim. Read it from the item's defineEvent call (hyphen→dot mapping is
 * ambiguous with underscores).
 */
function listId(item: RegistryItem, kind: Kind | "other"): string {
  if (kind === "event") {
    for (const file of item.files) {
      const match = file.content ? DEFINE_EVENT_NAME_RE.exec(file.content) : null;
      if (match) {
        return match[1]!;
      }
    }
  }
  return shortId(item.name, kind);
}

export interface ListItem {
  id: string;
  kind: Kind | "other";
  name: string;
  title?: string;
  description?: string;
}

export interface ListOptions {
  cwd: string;
  kind?: string;
  json?: boolean;
}

function collectListItems(
  manifest: Awaited<ReturnType<typeof loadRegistry>>,
  kindFilter?: string,
): ListItem[] {
  const normalizedKind = kindFilter?.replace(/s$/, "");
  if (normalizedKind && !KINDS.includes(normalizedKind as Kind) && normalizedKind !== "other") {
    throw new Error(
      `Unknown kind "${kindFilter}". Use: ${KINDS.join(", ")}`,
    );
  }

  const items: ListItem[] = [];
  for (const item of manifest.items) {
    const kind = kindOf(item.name);
    if (normalizedKind && kind !== normalizedKind) continue;
    items.push({
      id: listId(item, kind),
      kind,
      name: item.name,
      ...(item.title ? { title: item.title } : {}),
      ...(item.description ? { description: item.description } : {}),
    });
  }

  items.sort((a, b) => {
    const kindOrder = kindOf(a.name) === kindOf(b.name)
      ? 0
      : KINDS.indexOf(kindOf(a.name) as Kind) - KINDS.indexOf(kindOf(b.name) as Kind);
    if (kindOrder !== 0) {
      return kindOrder;
    }
    return a.name.localeCompare(b.name);
  });

  return items;
}

export async function runList(options: ListOptions): Promise<void> {
  const registryPath = await resolveRegistryPath(options.cwd);
  await assertRegistryExists(registryPath);
  const manifest = await loadRegistry(registryPath);
  const items = collectListItems(manifest, options.kind);

  if (options.json) {
    console.log(JSON.stringify(items, null, 2));
    return;
  }

  const kindFilter = options.kind?.replace(/s$/, "");
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
      const id = listId(item, kind);
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
