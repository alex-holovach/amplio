const EVENT_NAME_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

const EVENT_NAME_RULE =
  "Event ids need 2+ lowercase dot-separated semantic segments (for example http.request or order.paid).";

export function assertValidEventName(name: string): void {
  if (EVENT_NAME_RE.test(name)) return;
  if (/[A-Z]/.test(name)) {
    throw new Error(
      `Event ids must be lowercase (got "${name}"; try "${name.toLowerCase()}").`,
    );
  }
  throw new Error(`Invalid Event id "${name}". ${EVENT_NAME_RULE}`);
}

export function eventNameToRegistryId(name: string): string {
  assertValidEventName(name);
  return `event-${name.replace(/[._]/g, "-")}`;
}

export function eventNameToRelativePath(name: string): string {
  assertValidEventName(name);
  return `events/${name.replace(/[._]/g, "-")}.ts`;
}

export function eventNameToExport(name: string): string {
  assertValidEventName(name);
  return name
    .split(".")
    .map((segment) =>
      segment
        .split("_")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(""),
    )
    .join("");
}
