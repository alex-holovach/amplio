export function isDevelopment(): boolean {
  const env = globalThis.process?.env?.NODE_ENV;
  return env === undefined || env === "development" || env === "test";
}

export function isTest(): boolean {
  return globalThis.process?.env?.NODE_ENV === "test";
}

/**
 * Blunt escape hatch: AMPLIO_DISABLED=1 (or "true") drops every emit before
 * sinks run. Intended for CI (e.g. `next build` prerender executing RSC pages)
 * where telemetry output is never wanted.
 */
export function isAmplioDisabled(): boolean {
  const value = globalThis.process?.env?.AMPLIO_DISABLED;
  return value === "1" || value === "true";
}

/**
 * Next.js sets NEXT_PHASE during `next build`; static generation executes RSC
 * pages there, so emits fire from the build. Records are tagged (build_phase)
 * rather than dropped — silent dropping would hide real SSG behavior from
 * people who want it.
 */
export function isNextBuildPhase(): boolean {
  return globalThis.process?.env?.NEXT_PHASE === "phase-production-build";
}
