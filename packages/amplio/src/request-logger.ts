import { createLogger } from "./logger.js";
import { createRequestId } from "./request-id.js";
import type { Logger, RequestLoggerOptions } from "./types.js";

export function createRequestLogger(options: RequestLoggerOptions): Logger {
  return createLogger({
    event: "http.request",
    "@event": "http.request",
    request_id: options.requestId ?? createRequestId(),
    http: {
      method: options.method,
      path: options.path,
    },
  });
}
