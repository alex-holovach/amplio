import { installRuntimeConfig } from "./runtime-config.js";
import type {
  InitOptions,
  LegacySink,
  RuntimeDiagnostic,
} from "./semantic-types.js";

const TEST_DIAGNOSTIC_HANDLER = Symbol.for(
  "amplio.testing-diagnostic-handler.v2",
);

const diagnosticDispatcher = (
  config: InitOptions,
):
  ((diagnostic: RuntimeDiagnostic) => void | PromiseLike<void>) | undefined => {
  const handlers = [
    ...(config.onDiagnostic ? [config.onDiagnostic] : []),
    ...config.sinks.flatMap((sink) => {
      const handler = (
        sink as typeof sink & {
          [TEST_DIAGNOSTIC_HANDLER]?: (diagnostic: RuntimeDiagnostic) => void;
        }
      )[TEST_DIAGNOSTIC_HANDLER];
      return handler ? [handler] : [];
    }),
  ];
  if (handlers.length === 0) return undefined;
  return (diagnostic): void | PromiseLike<void> => {
    const pending: Promise<void>[] = [];
    for (const handler of handlers) {
      try {
        const result = handler(diagnostic);
        if (
          result !== null &&
          (typeof result === "object" || typeof result === "function")
        ) {
          pending.push(Promise.resolve(result).catch(() => undefined));
        }
      } catch {
        // Diagnostics are out-of-band and cannot affect application behavior.
      }
    }
    return pending.length === 0
      ? undefined
      : Promise.all(pending).then(() => undefined);
  };
};

/** Configure the semantic runtime. Application code receives no logger object. */
export function init(config: InitOptions): void {
  const onDiagnostic = diagnosticDispatcher(config);
  installRuntimeConfig({
    service: config.service,
    env: config.env,
    sinks: config.sinks as LegacySink[],
    canonicalKeyOnly: true,
    redact: config.redact ?? {},
    ...(config.sampling ? { sampling: config.sampling } : {}),
    eventRuntime: {
      ...(config.enrichers ? { enrichers: config.enrichers } : {}),
      ...(config.redactor ? { redactor: config.redactor } : {}),
      ...(config.sampler ? { sampler: config.sampler } : {}),
      ...(onDiagnostic ? { onDiagnostic } : {}),
      ...(config.limits ? { limits: config.limits } : {}),
      ...(config.delivery ? { delivery: config.delivery } : {}),
    },
  });
}
