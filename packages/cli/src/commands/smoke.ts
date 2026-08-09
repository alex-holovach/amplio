import fs from "node:fs/promises";
import path from "node:path";
import { readAmplioConfig } from "../utils/config.js";
import { pathExists } from "../utils/fs.js";
import { resolveProjectPaths } from "../utils/paths.js";

/**
 * `amplio smoke <url>` — close the verification loop the init epilogue asks
 * the user to walk manually: hit a wrapped route, watch for an emitted row,
 * report PASS/FAIL. The port trap (stale server on :3000, dev on :3001, curl
 * "succeeds" with zero events) becomes un-hittable: the request and the
 * emission check happen against the same reality.
 *
 * Emission is observed through the JSON file sink (amplio*.jsonl growing) —
 * the CLI cannot see the dev server's stdout, so the console sink alone is
 * not verifiable and the command says so instead of guessing.
 */

export interface SmokeOptions {
  cwd: string;
  url: string;
  /** Seconds to wait for a new JSONL row after the response (default 10). */
  timeoutSeconds?: number;
}

const POLL_INTERVAL_MS = 200;

const JSONL_FILE_RE = /^amplio.*\.jsonl$/;

async function listJsonlFiles(cwd: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(cwd, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && JSONL_FILE_RE.test(entry.name))
      .map((entry) => path.join(cwd, entry.name));
  } catch {
    return [];
  }
}

async function snapshotSizes(cwd: string): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  for (const file of await listJsonlFiles(cwd)) {
    try {
      sizes.set(file, (await fs.stat(file)).size);
    } catch {
      // deleted between readdir and stat — treat as absent
    }
  }
  return sizes;
}

interface NewRow {
  file: string;
  record: Record<string, unknown> | null;
  raw: string;
}

/** Rows appended to any amplio*.jsonl since the snapshot (new files included). */
async function readNewRows(cwd: string, before: Map<string, number>): Promise<NewRow[]> {
  const rows: NewRow[] = [];
  for (const file of await listJsonlFiles(cwd)) {
    let content: Buffer;
    try {
      content = await fs.readFile(file);
    } catch {
      continue;
    }
    const offset = before.get(file) ?? 0;
    if (content.length <= offset) {
      continue;
    }
    const fresh = content.subarray(offset).toString("utf8");
    for (const line of fresh.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      let record: Record<string, unknown> | null = null;
      try {
        record = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        // partial line still being written — report it raw
      }
      rows.push({ file, record, raw: trimmed });
    }
  }
  return rows;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function describeRow(row: NewRow, cwd: string): string {
  const rel = path.relative(cwd, row.file);
  if (!row.record) {
    return `partial line in ${rel}`;
  }
  const record = row.record;
  const eventName =
    typeof record["@event"] === "string"
      ? record["@event"]
      : typeof record.event === "string"
        ? record.event
        : "(unnamed)";
  const details: string[] = [];
  if (typeof record.request_id === "string") {
    details.push(`request_id ${record.request_id}`);
  }
  if (record.status !== undefined) {
    details.push(`status ${String(record.status)}`);
  }
  if (typeof record.duration_ms === "number") {
    details.push(`${record.duration_ms}ms`);
  }
  return `${eventName}${details.length > 0 ? ` (${details.join(", ")})` : ""} → ${rel}`;
}

function printNoEventDiagnosis(): void {
  console.log("\nThe response arrived but no event landed. Likely causes, most common first:");
  console.log(
    "  - Wrong port: a stale server may hold the port you curled while your dev server moved to 3001+ — a wrong-port response looks identical to dropped events. Check the port in the dev server's startup output.",
  );
  console.log("  - The route you hit is not wrapped with amplio middleware (run: amplio doctor).");
  console.log(
    "  - init() never ran (Next.js: instrumentation.ts must import telemetry/logger; restart the dev server after wiring).",
  );
  console.log("  - AMPLIO_DISABLED is set in this environment.");
}

export async function runSmoke(options: SmokeOptions): Promise<number> {
  const { cwd, url } = options;
  const timeoutMs = Math.max(1, options.timeoutSeconds ?? 10) * 1000;

  const config = await readAmplioConfig(cwd);
  const telemetryDir = config?.telemetryDir ?? "telemetry";
  const paths = resolveProjectPaths(cwd, telemetryDir);

  console.log(`amplio smoke ${url}\n`);

  let jsonSinkWired = false;
  if (await pathExists(path.join(paths.sinks, "json.ts"))) {
    if (await pathExists(paths.logger)) {
      const loggerSource = await fs.readFile(paths.logger, "utf8");
      jsonSinkWired = loggerSource.includes("sinks/json");
    }
  }

  if (!jsonSinkWired) {
    console.log("✗ FAIL — nothing to watch: the JSON file sink is not installed and wired.");
    console.log(
      "  smoke verifies emission by watching amplio*.jsonl grow; the console sink writes to the dev server's stdout, which the CLI cannot see.",
    );
    console.log("  fix: amplio add sink json (auto-wires logger.ts), restart dev, re-run smoke.");
    return 1;
  }

  const before = await snapshotSizes(cwd);

  const requestStarted = Date.now();
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause;
    console.log(`✗ FAIL — request to ${url} failed: ${error instanceof Error ? error.message : String(error)}`);
    if (cause?.code === "ECONNREFUSED") {
      console.log(
        "  Nothing is listening there. Is the dev server running? Next.js silently moves to 3001+ when 3000 is busy — check the port in its startup output.",
      );
    }
    return 1;
  }

  try {
    // Drain so streamed responses finish server-side (emit happens at the end).
    await response.text();
  } catch {
    // body errors don't change the verdict — the status line already arrived
  }
  console.log(
    `✓ response: ${response.status} ${response.statusText || ""}`.trimEnd() +
      ` in ${Date.now() - requestStarted}ms`,
  );

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await readNewRows(cwd, before);
    if (rows.length > 0) {
      const shown = rows.slice(0, 5);
      for (const row of shown) {
        console.log(`✓ event emitted: ${describeRow(row, cwd)}`);
      }
      if (rows.length > shown.length) {
        console.log(`  … and ${rows.length - shown.length} more row(s)`);
      }
      console.log("\nPASS — response received and event(s) emitted.");
      return 0;
    }
    if (Date.now() >= deadline) {
      break;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  console.log(
    `✗ FAIL — no new row in amplio*.jsonl within ${Math.round(timeoutMs / 1000)}s of the response.`,
  );
  printNoEventDiagnosis();
  return 1;
}
