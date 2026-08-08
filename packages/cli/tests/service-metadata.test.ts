import type { LogRecord } from "@amplio/core";
import { afterEach, describe, expect, it } from "vitest";
import { serviceMetadata } from "../../../registry/enrichers/service-metadata.ts";

const ENV_KEYS = ["AMPLIO_SERVICE", "AMPLIO_SERVICE_VERSION", "AMPLIO_REGION"] as const;

describe("serviceMetadata", () => {
  const previous = new Map<string, string | undefined>();

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    previous.clear();
  });

  function setEnv(vars: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>) {
    for (const key of ENV_KEYS) {
      if (!previous.has(key)) {
        previous.set(key, process.env[key]);
      }
    }
    for (const key of Object.keys(vars) as Array<(typeof ENV_KEYS)[number]>) {
      const value = vars[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }

  it("writes service.name/version/region from AMPLIO_* env and preserves other fields", () => {
    setEnv({
      AMPLIO_SERVICE: "billing-api",
      AMPLIO_SERVICE_VERSION: "2.4.1",
      AMPLIO_REGION: "us-west-2",
    });

    const record: LogRecord = {
      event: "order.created",
      env: "production",
      custom_field: "keep-me",
      nested: { a: 1 },
    };

    const out = serviceMetadata(record);

    expect(out.event).toBe("order.created");
    expect(out.env).toBe("production");
    expect(out.custom_field).toBe("keep-me");
    expect(out.nested).toEqual({ a: 1 });

    expect(out.service).toEqual({
      name: "billing-api",
      version: "2.4.1",
      region: "us-west-2",
    });
  });
  it("uses record.service as service.name when AMPLIO_SERVICE is unset", () => {
    setEnv({
      AMPLIO_SERVICE: undefined,
      AMPLIO_SERVICE_VERSION: "1.0.0",
      AMPLIO_REGION: "eu-west-1",
    });

    const record: LogRecord = {
      event: "checkout.started",
      service: "checkout-worker",
    };

    const out = serviceMetadata(record);

    expect(out.service).toEqual({
      name: "checkout-worker",
      version: "1.0.0",
      region: "eu-west-1",
    });
  });

  it("omits version/region keys when AMPLIO_SERVICE_VERSION and AMPLIO_REGION are unset", () => {
    setEnv({
      AMPLIO_SERVICE: "api",
      AMPLIO_SERVICE_VERSION: undefined,
      AMPLIO_REGION: undefined,
    });

    const record: LogRecord = {
      event: "request.handled",
    };

    const out = serviceMetadata(record);
    const service = out.service as Record<string, unknown>;

    expect(service).toEqual({ name: "api" });
    expect(Object.prototype.hasOwnProperty.call(service, "version")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(service, "region")).toBe(false);
    expect("version" in service).toBe(false);
    expect("region" in service).toBe(false);
  });

  it("uses record.service as service.name when AMPLIO_SERVICE is empty string", () => {
    setEnv({
      AMPLIO_SERVICE: "",
      AMPLIO_SERVICE_VERSION: "1.0.0",
      AMPLIO_REGION: "eu-west-1",
    });

    const record: LogRecord = {
      event: "checkout.started",
      service: "checkout-worker",
    };

    const out = serviceMetadata(record);

    expect(out.service).toEqual({
      name: "checkout-worker",
      version: "1.0.0",
      region: "eu-west-1",
    });
  });

  it("omits version/region keys when AMPLIO_SERVICE_VERSION and AMPLIO_REGION are empty strings", () => {
    setEnv({
      AMPLIO_SERVICE: "api",
      AMPLIO_SERVICE_VERSION: "",
      AMPLIO_REGION: "",
    });

    const record: LogRecord = {
      event: "request.handled",
    };

    const out = serviceMetadata(record);
    const service = out.service as Record<string, unknown>;

    expect(service).toEqual({ name: "api" });
    expect(Object.prototype.hasOwnProperty.call(service, "version")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(service, "region")).toBe(false);
    expect("version" in service).toBe(false);
    expect("region" in service).toBe(false);
  });

});
