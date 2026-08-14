import "../telemetry/runtime.js";
import { reconcileBilling } from "../telemetry/plugins/billing-worker.js";

await reconcileBilling({ jobId: "job_demo_1", queue: "billing" });

console.log("standalone ok");
