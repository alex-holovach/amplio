import { event } from "@useamplio/amplio";
import { z } from "zod";

export const BillingReconciliation = event({
  id: "worker.billing.reconcile",
  version: 1,
  schema: z.object({
    worker: z.object({ name: z.string() }),
    job: z.object({
      id: z.string(),
      queue: z.string(),
    }),
    records_processed: z.number().int().nonnegative().optional(),
  }),
});
