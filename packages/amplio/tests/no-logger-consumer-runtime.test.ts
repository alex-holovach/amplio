import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@useamplio/amplio", async () => import("../src/index.js"));
vi.mock("@useamplio/amplio/plugin", async () => import("../src/plugin.js"));

import type { Sink, SinkRecord } from "../src/index.js";
import { resetConfigForTests } from "../src/legacy.js";
import { createPlaceOrder } from "./fixtures/no-logger-consumer/domain/place-order.js";
import { createPlaceOrderRoute } from "./fixtures/no-logger-consumer/app/place-order-route.js";
import { configureTelemetry } from "./fixtures/no-logger-consumer/telemetry/init.js";
import {
  instrumentDependencies,
  observePlaceOrderRoute,
} from "./fixtures/no-logger-consumer/telemetry/place-order.js";

const capture = (): { records: SinkRecord[]; sink: Sink } => {
  const records: SinkRecord[] = [];
  return {
    records,
    sink(record) {
      records.push(record as SinkRecord);
    },
  };
};

const request = (userId: string, totalCents = 4_200) => ({
  async json() {
    return { userId, totalCents };
  },
});

beforeEach(() => {
  resetConfigForTests();
  vi.restoreAllMocks();
});

describe("no-logger consumer runtime", () => {
  it("keeps business behavior unchanged when boundary and provider wrappers are removed", async () => {
    const { records, sink } = capture();
    configureTelemetry([sink]);
    const calls: string[] = [];
    const dependencies = () => ({
      async loadUser(id: string) {
        calls.push(`load:${id}`);
        return { id, plan: "pro" as const };
      },
      async charge(input: { userId: string; totalCents: number }) {
        calls.push(`charge:${input.userId}:${input.totalCents}`);
        return { id: `pay_${input.userId}` };
      },
      async saveOrder(input: { userId: string; totalCents: number }) {
        calls.push(`save:${input.userId}:${input.totalCents}`);
        return { id: `ord_${input.userId}`, ...input };
      },
    });

    const direct = createPlaceOrderRoute({
      placeOrder: createPlaceOrder(dependencies()),
    });
    const directResult = await direct(request("u_equivalent", 1_200));
    const directCalls = calls.splice(0);

    expect(records).toEqual([]);

    const wrapped = observePlaceOrderRoute(
      createPlaceOrderRoute({
        placeOrder: createPlaceOrder(instrumentDependencies(dependencies())),
      }),
    );
    const wrappedResult = await wrapped(request("u_equivalent", 1_200));

    expect(wrappedResult).toEqual(directResult);
    expect(calls).toEqual(directCalls);
    expect(records).toHaveLength(1);
  });

  it("composes ordinary provider calls into one route Event", async () => {
    const { records, sink } = capture();
    configureTelemetry([sink]);
    vi.spyOn(Date, "now").mockReturnValue(1_000);

    const placeOrder = createPlaceOrder(
      instrumentDependencies({
        async loadUser(id) {
          return { id, plan: "pro" };
        },
        async charge(input) {
          vi.mocked(Date.now).mockReturnValue(1_080);
          return { id: `pay_${input.userId}` };
        },
        async saveOrder(input) {
          return { id: `ord_${input.userId}`, ...input };
        },
      }),
    );
    const post = observePlaceOrderRoute(createPlaceOrderRoute({ placeOrder }));

    await expect(post(request("u_1"))).resolves.toEqual({
      body: { id: "ord_u_1", userId: "u_1", totalCents: 4_200 },
      status: 201,
    });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      "@event": "api.order.place",
      success: true,
      dependencies: {
        user_load: {
          user_id: "u_1",
          plan: "pro",
          found: true,
          success: true,
        },
        payment_attempts: [
          {
            user_id: "u_1",
            total_cents: 4_200,
            payment_id: "pay_u_1",
            duration_ms: 80,
            success: true,
          },
        ],
        order_save: {
          user_id: "u_1",
          total_cents: 4_200,
          order_id: "ord_u_1",
          success: true,
        },
      },
    });
  });

  it("records a provider failure and rethrows the original error by identity", async () => {
    const { records, sink } = capture();
    configureTelemetry([sink]);
    vi.spyOn(Date, "now").mockReturnValue(2_000);
    const declined = Object.assign(new Error("card declined"), {
      code: "do_not_honor",
    });
    const placeOrder = createPlaceOrder(
      instrumentDependencies({
        async loadUser(id) {
          return { id, plan: "free" };
        },
        async charge() {
          vi.mocked(Date.now).mockReturnValue(2_025);
          throw declined;
        },
        async saveOrder(input) {
          return { id: "unreachable", ...input };
        },
      }),
    );
    const post = observePlaceOrderRoute(createPlaceOrderRoute({ placeOrder }));

    await expect(post(request("u_declined", 900))).rejects.toBe(declined);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      "@event": "api.order.place",
      success: false,
      dependencies: {
        payment_attempts: [
          {
            user_id: "u_declined",
            total_cents: 900,
            decline_code: "do_not_honor",
            duration_ms: 25,
            success: false,
            error: { type: "Error" },
          },
        ],
      },
    });
  });

  it("isolates interleaved request trees", async () => {
    const { records, sink } = capture();
    configureTelemetry([sink]);
    const releases = new Map<string, () => void>();
    const placeOrder = createPlaceOrder(
      instrumentDependencies({
        async loadUser(id) {
          return { id, plan: id === "u_a" ? "pro" : "free" };
        },
        charge(input) {
          return new Promise((resolve) => {
            releases.set(input.userId, () =>
              resolve({ id: `pay_${input.userId}` }),
            );
          });
        },
        async saveOrder(input) {
          return { id: `ord_${input.userId}`, ...input };
        },
      }),
    );
    const post = observePlaceOrderRoute(createPlaceOrderRoute({ placeOrder }));

    const a = post(request("u_a", 100));
    const b = post(request("u_b", 200));
    await vi.waitFor(() => expect(releases.size).toBe(2));
    releases.get("u_b")?.();
    await b;
    releases.get("u_a")?.();
    await a;

    expect(records).toHaveLength(2);
    const byUser = new Map(
      records.map((record) => {
        const dependencies = record.dependencies as {
          user_load: { user_id: string };
        };
        return [dependencies.user_load.user_id, record] as const;
      }),
    );
    expect(byUser.get("u_a")).toMatchObject({
      dependencies: {
        user_load: { user_id: "u_a", plan: "pro" },
        payment_attempts: [{ user_id: "u_a", payment_id: "pay_u_a" }],
      },
    });
    expect(byUser.get("u_b")).toMatchObject({
      dependencies: {
        user_load: { user_id: "u_b", plan: "free" },
        payment_attempts: [{ user_id: "u_b", payment_id: "pay_u_b" }],
      },
    });
  });
});
