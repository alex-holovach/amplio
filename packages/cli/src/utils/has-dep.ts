import { readFile } from "node:fs/promises";
import path from "node:path";

export async function hasDependency(cwd: string, name: string): Promise<boolean> {
  const pkgPath = path.join(cwd, "package.json");
  try {
    const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    return name in deps;
  } catch {
    return false;
  }
}
