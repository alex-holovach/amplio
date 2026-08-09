import { defineEvent } from "@useamplio/amplio";
import { z } from "zod";

export const AuthUserSignedIn = defineEvent(
  "auth.user.signed_in",
  z.object({
    user: z.object({
      id: z.string(),
      email: z.string().email().optional(),
    }),
    session: z.object({
      // Optional: auth providers fire sign-in events before a session row exists
      // (NextAuth `events.signIn`, Clerk webhooks, Better Auth hooks).
      id: z.string().optional(),
      method: z.enum(["password", "oauth", "magic_link", "sso"]),
      mfa: z.boolean().optional(),
    }),
  }),
);
