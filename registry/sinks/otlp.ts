import type { JsonValue, LogRecord, Sink } from "@useamplio/amplio";

export interface OtlpSinkOptions {
  endpoint?: string;
  headers?: Record<string, string>;
  throwOnError?: boolean;
}

const ATTRIBUTE_FIELDS = [
  "service",
  "event",
  "status",
  "duration_ms",
  "request_id",
  "success",
] as const;

type OtlpAttributeValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: number }
  | { doubleValue: number };

interface OtlpAttribute {
  key: string;
  value: OtlpAttributeValue;
}

const parseOtlpHeaders = (raw: string | undefined): Record<string, string> => {
  if (!raw) {
    return {};
  }

  const headers: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const trimmed = pair.trim();
    if (!trimmed) {
      continue;
    }

    const eq = trimmed.indexOf("=");
    if (eq === -1) {
      continue;
    }

    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key) {
      headers[key] = value;
    }
  }

  return headers;
};

const toOtlpAttribute = (key: string, value: JsonValue | undefined): OtlpAttribute | undefined => {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value === "string") {
    return { key, value: { stringValue: value } };
  }

  if (typeof value === "boolean") {
    return { key, value: { boolValue: value } };
  }

  if (typeof value === "number") {
    if (Number.isInteger(value)) {
      return { key, value: { intValue: value } };
    }
    return { key, value: { doubleValue: value } };
  }

  return undefined;
};

const toTimeUnixNano = (timestamp: JsonValue | undefined): string => {
  let ms: number;

  if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
    ms = timestamp;
  } else if (typeof timestamp === "string" && timestamp.length > 0) {
    const parsed = Date.parse(timestamp);
    ms = Number.isNaN(parsed) ? Date.now() : parsed;
  } else {
    ms = Date.now();
  }

  return `${Math.trunc(ms)}000000`;
};

const buildAttributes = (record: LogRecord): OtlpAttribute[] => {
  const attributes: OtlpAttribute[] = [];

  for (const field of ATTRIBUTE_FIELDS) {
    const attr = toOtlpAttribute(field, record[field]);
    if (attr) {
      attributes.push(attr);
    }
  }

  return attributes;
};

export function otlpSink(options: OtlpSinkOptions = {}): Sink {
  const endpoint = options.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const throwOnError = options.throwOnError ?? true;
  const headers = {
    "content-type": "application/json",
    ...parseOtlpHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS),
    ...(options.headers ?? {}),
  };

  if (!endpoint) {
    let warned = false;
    return async () => {
      if (!warned) {
        warned = true;
        console.warn(
          "otlpSink: OTEL_EXPORTER_OTLP_ENDPOINT is not set; OTLP export is disabled",
        );
      }
    };
  }

  const base = endpoint.replace(/\/$/, "");
  const url = base.endsWith("/v1/logs") ? base : `${base}/v1/logs`;

  return async (record: LogRecord) => {
    const attributes = buildAttributes(record);
    const serviceName =
      typeof record.service === "string" && record.service.length > 0
        ? record.service
        : undefined;
    const deploymentEnvironment =
      typeof record.env === "string" && record.env.length > 0
        ? record.env
        : undefined;

    const resourceAttributes: OtlpAttribute[] = [];
    if (serviceName) {
      resourceAttributes.push({
        key: "service.name",
        value: { stringValue: serviceName },
      });
    }
    if (deploymentEnvironment) {
      resourceAttributes.push({
        key: "deployment.environment",
        value: { stringValue: deploymentEnvironment },
      });
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          resourceLogs: [
            {
              ...(resourceAttributes.length > 0
                ? {
                    resource: {
                      attributes: resourceAttributes,
                    },
                  }
                : {}),
              scopeLogs: [
                {
                  logRecords: [
                    {
                      timeUnixNano: toTimeUnixNano(record.timestamp),
                      body: { stringValue: JSON.stringify(record) },
                      ...(attributes.length > 0 ? { attributes } : {}),
                    },
                  ],
                },
              ],
            },
          ],
        }),
      });
    } catch (error) {
      if (throwOnError) {
        throw error;
      }
      return;
    }

    if (!response.ok) {
      if (throwOnError) {
        throw new Error(`OTLP export failed with status ${response.status}`);
      }
      return;
    }
  };
}
