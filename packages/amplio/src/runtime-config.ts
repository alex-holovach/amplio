import { getGlobalState } from "./global-state.js";
import { installSinkGeneration, resetPendingSinksForTests } from "./sinks.js";
import type { AmplioConfig } from "./semantic-types.js";

const clonePattern = (pattern: RegExp): RegExp =>
  new RegExp(pattern.source, pattern.flags);

export const cloneRuntimeConfig = (config: AmplioConfig): AmplioConfig => ({
  ...config,
  sinks: [...config.sinks],
  ...(config.enrichers ? { enrichers: [...config.enrichers] } : {}),
  ...(config.redact !== undefined
    ? {
        redact:
          config.redact === false
            ? false
            : {
                ...(config.redact.fields
                  ? { fields: [...config.redact.fields] }
                  : {}),
                ...(config.redact.patterns
                  ? { patterns: config.redact.patterns.map(clonePattern) }
                  : {}),
              },
      }
    : {}),
  ...(config.sampling
    ? {
        sampling: {
          ...config.sampling,
          ...(config.sampling.keep
            ? {
                keep: config.sampling.keep.map((rule) => ({
                  ...rule,
                  ...(rule.matches
                    ? { matches: clonePattern(rule.matches) }
                    : {}),
                })),
              }
            : {}),
        },
      }
    : {}),
  ...(config.eventRuntime
    ? {
        eventRuntime: {
          ...config.eventRuntime,
          ...(config.eventRuntime.enrichers
            ? { enrichers: [...config.eventRuntime.enrichers] }
            : {}),
          ...(config.eventRuntime.limits
            ? { limits: { ...config.eventRuntime.limits } }
            : {}),
          ...(config.eventRuntime.delivery
            ? { delivery: { ...config.eventRuntime.delivery } }
            : {}),
        },
      }
    : {}),
});

export const installRuntimeConfig = (config: AmplioConfig): boolean => {
  const service = config.service?.trim();
  const env = config.env?.trim();
  if (!service) throw new Error("init(): service is required");
  if (!env) throw new Error("init(): env is required");
  if (!Array.isArray(config.sinks) || config.sinks.length === 0) {
    throw new Error("init(): at least one sink is required");
  }
  const next = cloneRuntimeConfig({ ...config, service, env });
  if (!installSinkGeneration(next)) return false;
  getGlobalState().activeConfig = next;
  return true;
};

export const getRuntimeConfig = (): AmplioConfig => {
  const config = getGlobalState().activeConfig;
  if (!config) throw new Error("amplio is not initialized — call init() first");
  return cloneRuntimeConfig(config);
};

export const resolveRuntimeConfig = (): AmplioConfig =>
  getGlobalState().activeConfig ?? { service: "", env: "", sinks: [] };

export const clearRuntimeConfig = (): void => {
  getGlobalState().activeConfig = null;
  resetPendingSinksForTests();
};
