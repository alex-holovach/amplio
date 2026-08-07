export function isDevelopment(): boolean {
  const env = globalThis.process?.env?.NODE_ENV;
  return env === undefined || env === "development" || env === "test";
}
