export function isDevelopment(): boolean {
  const env = globalThis.process?.env?.NODE_ENV;
  return env === undefined || env === "development" || env === "test";
}

export function isTest(): boolean {
  return globalThis.process?.env?.NODE_ENV === "test";
}
