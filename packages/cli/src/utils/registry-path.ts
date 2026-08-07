import path from "node:path";

export function registryPathForConfig(cwd: string, registryPath: string): string | undefined {
  const resolvedCwd = path.resolve(cwd);
  const resolvedRegistry = path.resolve(registryPath);
  const relative = path.relative(resolvedCwd, resolvedRegistry);

  if (!relative || relative.startsWith("..")) {
    const parts = relative.split(path.sep);
    const ups = parts.filter((part) => part === "..").length;
    const rest = parts.slice(ups).join("/");
    if (ups > 0 && ups <= 3 && rest === "registry/registry.json") {
      return relative;
    }
    return undefined;
  }

  return `./${relative}`;
}
