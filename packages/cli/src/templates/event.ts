import { eventNameToExport } from "../utils/event-name.js";

export function renderEventTemplate(eventName: string, exportName?: string): string {
  const exportSymbol = exportName ?? eventNameToExport(eventName);
  const [domain] = eventName.split(".");

  return `import { defineEvent } from "@useamplio/amplio";
import { z } from "zod";

// Starter shape — edit this schema to match your domain (e.g. extra fields).
// 'amplio add event' will not overwrite your edits; re-run with --force to regenerate.
export const ${exportSymbol} = defineEvent(
  "${eventName}",
  z.object({
    ${domain}: z.object({
      // Tighten to z.string() or z.number() once you know your id type
      // (e.g. Drizzle/Prisma integer PKs are numbers).
      id: z.union([z.string(), z.number()]),
    }),
    // Optional so the obvious first call — .set({ ${domain}: { id } }).emit() —
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
