import { eventNameToExport } from "../utils/event-name.js";

export function renderEventTemplate(eventName: string, exportName?: string): string {
  const exportSymbol = exportName ?? eventNameToExport(eventName);
  const [domain] = eventName.split(".");

  return `import { defineEvent } from "@amplio/amplio";
import { z } from "zod";

export const ${exportSymbol} = defineEvent(
  "${eventName}",
  z.object({
    ${domain}: z.object({
      id: z.string(),
    }),
    context: z.object({
      source: z.string().optional(),
    }),
  }),
);
`;
}

export function renderAuthUserSignedUpEvent(): string {
  return `import { defineEvent } from "@amplio/amplio";
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
