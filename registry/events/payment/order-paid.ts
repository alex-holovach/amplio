import { defineEvent } from "@useamplio/amplio";
import { z } from "zod";

export const PaymentOrderPaid = defineEvent(
  "payment.order.paid",
  z.object({
    order: z.object({
      id: z.string(),
      currency: z.string().length(3),
      amount_cents: z.number().int().nonnegative(),
    }),
    customer: z.object({
      id: z.string(),
      email: z.string().email().optional(),
    }),
    payment: z.object({
      provider: z.enum(["stripe", "polar", "paddle", "other"]),
      method: z.enum(["card", "bank", "wallet", "other"]).optional(),
    }),
  }),
);
