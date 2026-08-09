import { defineEvent } from "@useamplio/core";
import { z } from "zod";

export const AuthUserSignedIn = defineEvent(
  "auth.user.signed_in",
  z.object({
    user: z.object({
      id: z.string(),
      email: z.string().email().optional(),
    }),
    session: z.object({
      id: z.string(),
      method: z.enum(["password", "oauth", "magic_link", "sso"]),
      mfa: z.boolean().optional(),
    }),
  }),
);
