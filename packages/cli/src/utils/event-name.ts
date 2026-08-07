const EVENT_NAME_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$/;

export function assertValidEventName(name: string): void {
  if (!EVENT_NAME_RE.test(name)) {
    throw new Error(
      `Invalid event name "${name}". Expected dot-separated segments (e.g. auth.user.signed_up or email.sent).`,
    );
  }
}

export function eventNameToRegistryId(name: string): string {
  assertValidEventName(name);
  return `event-${name.replace(/\./g, "-").replace(/_/g, "-")}`;
}

export function eventNameToRelativePath(name: string): string {
  assertValidEventName(name);
  const segments = name.split(".");
  const domain = segments[0]!;

  if (segments.length === 2) {
    const action = segments[1]!.replace(/_/g, "-");
    return `events/${domain}/${domain}-${action}.ts`;
  }

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
