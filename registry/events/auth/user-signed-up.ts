import { defineEvent } from "@useamplio/amplio";
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
