const EVENT_NAME_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$/;

const EVENT_NAME_RULE =
  "Event names need 2+ dot-separated segments; each segment starts with a lowercase letter, then lowercase alphanumerics and underscores (e.g. auth.user.signed_up or email.sent).";

export function assertValidEventName(name: string): void {
  if (EVENT_NAME_RE.test(name)) {
    return;
  }

  if (/[A-Z]/.test(name)) {
    throw new Error(
      `Event names must be lowercase (got "${name}"; try "${name.toLowerCase()}").`,
    );
  }

  throw new Error(`Invalid event name "${name}". ${EVENT_NAME_RULE}`);
}

export function eventNameToRegistryId(name: string): string {
  assertValidEventName(name);
  return `event-${name.replace(/\./g, "-").replace(/_/g, "-")}`;
}

export function eventNameToRelativePath(name: string): string {
  assertValidEventName(name);
  const segments = name.split(".");
  const domain = segments[0]!;
  const fileName = `${segments.slice(1).join("-").replace(/_/g, "-")}.ts`;
  return `events/${domain}/${fileName}`;
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
