import { z } from "zod";
import { defineEvent } from "@useamplio/core";

export const JobCompleted = defineEvent(
  "job.completed",
  z.object({
    job: z.object({
      id: z.string(),
      queue: z.string(),
    }),
    result: z.object({
      ok: z.boolean(),
      duration_ms: z.number().nonnegative(),
    }),
  }),
);
