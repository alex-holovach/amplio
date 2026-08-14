import { reconcileBilling as reconcileBillingNative } from "../../src/reconcile.js";
import { BillingReconciliation } from "../events/billing-reconciliation.js";

/** Worker boundary Plugin: one invocation owns one root Event. */
export const reconcileBilling = BillingReconciliation.handle(
  reconcileBillingNative,
  {
    input: ({ args: [input] }) => ({
      worker: { name: "billing-reconcile" },
      job: { id: input.jobId, queue: input.queue },
    }),
    result: ({ result }) => ({
      records_processed: result.recordsProcessed,
    }),
  },
);
