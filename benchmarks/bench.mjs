#!/usr/bin/env node
import { performance } from "node:perf_hooks";
import { createLogger, init, resetConfigForTests } from "../packages/core/dist/index.js";

const ITERATIONS = 20_000;
const WARMUP = 1_000;

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

function benchLatency(name, fn, iterations = ITERATIONS) {
  for (let i = 0; i < WARMUP; i += 1) {
    fn();
  }

  const samples = new Float64Array(iterations);
  for (let i = 0; i < iterations; i += 1) {
    const start = performance.now();
    fn();
    samples[i] = performance.now() - start;
  }

  const sorted = Array.from(samples).sort((a, b) => a - b);
  const totalMs = sorted.reduce((a, b) => a + b, 0);
  const opsPerSec = (iterations / totalMs) * 1000;
  const median = percentile(sorted, 50);
  const p99 = percentile(sorted, 99);

  console.log(
    `${name}: ${opsPerSec.toFixed(0)} ops/sec | median ${median.toFixed(3)} ms | p99 ${p99.toFixed(3)} ms (${iterations.toLocaleString()} samples)`,
  );

  return { opsPerSec, median, p99 };
}

function nested1kbPayload() {
  return {
    user: { id: "u_1", email: "user@example.com", plan: "pro" },
    cart: {
      id: "cart_1",
      items: Array.from({ length: 14 }, (_, index) => ({
        sku: `sku_${index}`,
        qty: index + 1,
        price_cents: 1999 + index,
        name: `item_${index}`,
      })),
    },
    http: {
      method: "POST",
      path: "/checkout",
      status: 200,
    },
    meta: { tags: Array.from({ length: 2 }, (_, i) => `tag_${i}`) },
  };
}

resetConfigForTests();
init({
  service: "bench",
  env: "test",
  sinks: [() => {}],
});

const sample = nested1kbPayload();
const approxBytes = Buffer.byteLength(JSON.stringify(sample), "utf8");
console.log(`payload ~${approxBytes} bytes (nested set+emit target)`);

benchLatency("set+emit (flat payload)", () => {
  createLogger({ request_id: "req_bench", feature: "checkout" })
    .set({ status: 200, user_id: "u_1" })
    .emit();
});

const nested = benchLatency("set+emit (nested payload ~1KB)", () => {
  createLogger({ request_id: "req_bench" }).set(nested1kbPayload()).emit();
});

if (!(nested.median >= 0 && nested.p99 >= nested.median)) {
  console.error("bench failed: invalid latency percentiles");
  process.exit(1);
}
