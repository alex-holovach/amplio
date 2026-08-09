import { defineEvent } from "@useamplio/core";
import { z } from "zod";

export const EmailSent = defineEvent(
  "email.sent",
  z.object({
    email: z.object({
      id: z.string(),
      template: z.string(),
      to: z.string().email(),
      subject: z.string(),
    }),
    delivery: z.object({
      provider: z.enum(["resend", "sendgrid", "ses", "postmark", "other"]),
      status: z.enum(["queued", "sent", "failed"]),
    }),
  }),
);
