const EVENT_NAME_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$/;

export function assertValidEventName(name: string): void {
  if (typeof name !== "string" || !name) {
    throw new Error("defineEvent(): name must be a non-empty string");
  }
  if (!EVENT_NAME_RE.test(name)) {
    throw new Error(
      `Invalid event name "${name}". Expected dot-separated segments (e.g. auth.user.signed_up or email.sent).`,
    );
  }
}
