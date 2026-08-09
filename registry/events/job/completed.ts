import { defineEvent } from "@useamplio/amplio";
import { z } from "zod";

export const JobCompleted = defineEvent(
  "job.completed",
  z.object({
    job: z.object({
      name: z.string(),
      // Queue-assigned id (BullMQ, Inngest, pg-boss, …) when you have one.
      id: z.union([z.string(), z.number()]).optional(),
      queue: z.string().optional(),
    }),
    result: z.object({
      status: z.enum(["success", "failed", "cancelled"]),
      attempt: z.number().int().positive().optional(),
      // Domain-level count ("rows synced"), not a timing — the auto
      // duration_ms field already times the logger's lifetime.
      records_processed: z.number().int().nonnegative().optional(),
    }),
  }),
);
