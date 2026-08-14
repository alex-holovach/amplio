import { event, init, type SinkRecord } from "@useamplio/amplio";
import { resetConfigForTests } from "@useamplio/amplio/legacy";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { serviceMetadata } from "../../../registry/enrichers/service-metadata.ts";

const ENV_KEYS = [
  "AMPLIO_SERVICE",
  "AMPLIO_SERVICE_VERSION",
  "AMPLIO_REGION",
] as const;
const previous = new Map<string, string | undefined>();

function setEnv(
  values: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>,
) {
  for (const key of ENV_KEYS) {
    if (!previous.has(key)) previous.set(key, process.env[key]);
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = previous.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  previous.clear();
  resetConfigForTests();
});

describe("serviceMetadata ResourceEnricher", () => {
  it("adds bounded flat resource attributes and preserves existing resources", () => {
    setEnv({
      AMPLIO_SERVICE: "billing-api",
      AMPLIO_SERVICE_VERSION: "2.4.1",
      AMPLIO_REGION: "us-west-2",
    });
    expect(serviceMetadata({ host: "worker-1" })).toEqual({
      host: "worker-1",
      "deployment.name": "billing-api",
      "deployment.version": "2.4.1",
      "deployment.region": "us-west-2",
    });
  });

  it("omits empty optional attributes", () => {
    setEnv({
      AMPLIO_SERVICE: "",
      AMPLIO_SERVICE_VERSION: undefined,
      AMPLIO_REGION: "",
    });
    expect(serviceMetadata({ host: "worker-1" })).toEqual({ host: "worker-1" });
  });

  it("delivers deployment metadata only under the runtime-owned resource envelope", () => {
    setEnv({
      AMPLIO_SERVICE: "billing-api",
      AMPLIO_SERVICE_VERSION: "2.4.1",
      AMPLIO_REGION: "us-west-2",
    });
    let delivered: SinkRecord | undefined;
    init({
      service: "configured-service",
      env: "test",
      enrichers: [serviceMetadata],
      sinks: [(record) => (delivered = record)],
    });
    const Delivery = event({
      id: "service.metadata_delivery",
      version: 1,
      schema: z.object({ kind: z.literal("test") }),
    });
    const run = Delivery.handle(() => "application-result", {
      input: () => ({ kind: "test" }),
    });

    expect(run()).toBe("application-result");
    expect(delivered?.service).toBe("configured-service");
    expect(delivered?.resource).toEqual({
      "deployment.name": "billing-api",
      "deployment.version": "2.4.1",
      "deployment.region": "us-west-2",
    });
    expect(delivered).not.toHaveProperty("deployment");
  });
});
