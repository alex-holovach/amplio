import { defineEvent } from "@useamplio/amplio";
import { z } from "zod";

export const PaymentRefunded = defineEvent(
  "payment.refunded",
  z.object({
    refund: z.object({
      id: z.string(),
      currency: z.string().length(3),
      amount_cents: z.number().int().nonnegative(),
      // Partial refunds: amount_cents < the original order amount.
      reason: z
        .enum(["requested_by_customer", "duplicate", "fraud", "other"])
        .optional(),
    }),
    order: z.object({
      id: z.string(),
    }),
    payment: z.object({
      provider: z.enum(["stripe", "polar", "paddle", "other"]),
    }),
  }),
);
