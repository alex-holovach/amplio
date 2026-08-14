import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  console.error(`smoke failed: ${message}`);
  process.exit(1);
}

const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
  cwd: root,
  env: { ...process.env, SERVICE_NAME: "example-standalone", NODE_ENV: "test" },
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (c) => {
  stdout += c;
});
child.stderr.on("data", (c) => {
  stderr += c;
});

const code = await new Promise((resolve) => child.on("exit", resolve));
if (code !== 0) fail(`process exited ${code}: ${stderr || stdout}`);

const records = stdout
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l.startsWith("{") && l.endsWith("}"))
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

const eventName = (record) => record["@event"];
const eventRecord = records.find(
  (record) => eventName(record) === "worker.billing.reconcile",
);

if (!eventRecord) fail(`missing billing reconciliation Event in:\n${stdout}`);
if (records.length !== 1)
  fail(`expected one wide event, got ${records.length}:\n${stdout}`);
if (eventRecord.service !== "example-standalone") {
  fail(`expected service example-standalone, got ${eventRecord.service}`);
}
if (eventRecord.job?.id !== "job_demo_1")
  fail("Event missing stable job identity");
if (eventRecord.records_processed !== 1)
  fail("Event missing reconciled record count");

console.log("example-standalone ok");
console.log(
  JSON.stringify({
    event: eventName(eventRecord),
    worker: eventRecord.worker,
    job: eventRecord.job,
    records_processed: eventRecord.records_processed,
  }),
);
