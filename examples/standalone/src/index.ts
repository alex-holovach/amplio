import { logger } from "../telemetry/logger";
import { JobCompleted } from "../telemetry/events/job/completed";

const started = Date.now();

// Standalone wide event for scripts / workers (no HTTP middleware).
logger
  .create()
  .set({
    worker: { name: "billing-reconcile" },
    batch: { size: 1 },
  })
  .set({ phase: "start" })
  .emit();

logger
  .event(JobCompleted)
  .set({
    job: { id: "job_demo_1", queue: "billing" },
    result: { ok: true, duration_ms: Date.now() - started },
  })
  .emit();

console.log("standalone ok");
