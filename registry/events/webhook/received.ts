import { defineEvent } from "@useamplio/amplio";
import { z } from "zod";

export const WebhookReceived = defineEvent(
  "webhook.received",
  z.object({
    webhook: z.object({
      provider: z.string(), // "stripe", "resend", "github", …
      // The provider's event type ("invoice.paid") — kept separate from the
      // amplio event name so you can group all webhook traffic in one place.
      event_type: z.string(),
      delivery_id: z.string().optional(),
    }),
    verification: z
      .object({
        // Emit failed verifications too — silent signature failures are the
        // webhook bug you want a dashboard for.
        signature_valid: z.boolean(),
      })
      .optional(),
  }),
);
