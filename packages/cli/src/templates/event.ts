import { eventNameToExport } from "../utils/event-name.js";

export function renderEventTemplate(eventName: string, exportName?: string): string {
  const exportSymbol = exportName ?? eventNameToExport(eventName);
  const segments = eventName.split(".");
  // The payload namespace is the entity the event is about: the second-to-last
  // segment for 3+-segment names (ui.feedback.submitted → feedback), the first
  // for 2-segment names (email.sent → email).
  const entity = segments.length >= 3 ? segments[segments.length - 2]! : segments[0]!;

  return `import { defineEvent } from "@useamplio/amplio";
import { z } from "zod";

// Starter shape — edit this schema to match your domain (e.g. extra fields).
// '${entity}' is a guess from the event name; rename it to your real entity.
// 'amplio add event' will not overwrite your edits; re-run with --force to regenerate.
//
// Emitting (inside a request): getLogger().child(${exportSymbol}).set({ ${entity}: { id } }).emit()
// Create the child *before* the work if you want duration_ms to time the work.
// Outside a request: logger.event(${exportSymbol}); spine fields: getLogger().set().
export const ${exportSymbol} = defineEvent(
  "${eventName}",
  z.object({
    ${entity}: z.object({
      // Tighten to z.string() or z.number() once you know your id type
      // (e.g. Drizzle/Prisma integer PKs are numbers).
      id: z.union([z.string(), z.number()]),
    }),
    // Optional so the obvious first call — .set({ ${entity}: { id } }).emit() —
    // validates clean without a context wrapper.
    context: z
      .object({
        source: z.string().optional(),
      })
      .optional(),
  }),
);
`;
}

export function renderAuthUserSignedUpEvent(): string {
  return `import { defineEvent } from "@useamplio/amplio";
import { z } from "zod";

export const AuthUserSignedUp = defineEvent(
  "auth.user.signed_up",
  z.object({
    user: z.object({
      id: z.string(),
      email: z.string().email().optional(),
    }),
    signup: z.object({
      method: z.enum(["email", "oauth", "invite"]),
      referrer: z.string().optional(),
    }),
  }),
);
`;
}
