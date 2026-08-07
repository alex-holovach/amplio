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

const createRecord = records.find((r) => r.worker?.name === "billing-reconcile");
const eventRecord = records.find((r) => r.event === "job.completed");

if (!createRecord) fail(`missing logger.create() record in:\n${stdout}`);
if (!eventRecord) fail(`missing logger.event(JobCompleted) record in:\n${stdout}`);
if (createRecord.service !== "example-standalone") {
  fail(`expected service example-standalone, got ${createRecord.service}`);
}
if (typeof eventRecord.event !== "string") fail(`event must be string, got ${JSON.stringify(eventRecord.event)}`);
if (!eventRecord.job?.id) fail("event record missing nested job.id");

console.log("example-standalone ok");
console.log(
  JSON.stringify({
    create: { service: createRecord.service, worker: createRecord.worker },
    event: { event: eventRecord.event ?? eventRecord.name, job: eventRecord.job },
  }),
);
