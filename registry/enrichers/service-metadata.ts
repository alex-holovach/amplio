import type { LogRecord } from "@logcn/core";

function envOrUndefined(key: string): string | undefined {
  const value = process.env[key];
  if (value === undefined || value === "") {
    return undefined;
  }
  return value;
}

export function serviceMetadata(record: LogRecord): LogRecord {
  const service: Record<string, unknown> = {
    name: envOrUndefined("LOGCN_SERVICE") ?? record.service,
  };

  const version = envOrUndefined("LOGCN_SERVICE_VERSION");
  if (version !== undefined) {
    service.version = version;
  }

  const region = envOrUndefined("LOGCN_REGION");
  if (region !== undefined) {
    service.region = region;
  }

  return {
    ...record,
    service,
  };
}
