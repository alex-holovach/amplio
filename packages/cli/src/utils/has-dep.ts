import { readFile } from "node:fs/promises";
import path from "node:path";

function readPackageDeps(pkg: {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}): Record<string, string> {
  return { ...pkg.dependencies, ...pkg.devDependencies };
}

export async function hasDependency(cwd: string, name: string): Promise<boolean> {
  const pkgPath = path.join(cwd, "package.json");
  try {
    const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = readPackageDeps(pkg);
    return name in deps;
  } catch {
    return false;
  }
}

/** Dependency each registry integration targets — shared by init's
 * suggestions and add's absent-dependency heads-up. */
export const INTEGRATION_DEP_RULES: Array<{
  integration: string;
  depLabel: string;
  matches: (depName: string) => boolean;
}> = [
  { integration: "next-auth", depLabel: "next-auth", matches: (name) => name === "next-auth" },
  { integration: "better-auth", depLabel: "better-auth", matches: (name) => name === "better-auth" },
  { integration: "clerk", depLabel: "@clerk/*", matches: (name) => name.startsWith("@clerk/") },
  { integration: "resend", depLabel: "resend", matches: (name) => name === "resend" },
  { integration: "polar", depLabel: "@polar-sh/*", matches: (name) => name.startsWith("@polar-sh/") },
];

/** First dependency (dep or devDep) matching the predicate, or null. */
export async function findDependency(
  cwd: string,
  matches: (name: string) => boolean,
): Promise<string | null> {
  const pkgPath = path.join(cwd, "package.json");
  try {
    const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return Object.keys(readPackageDeps(pkg)).find(matches) ?? null;
  } catch {
    return null;
  }
}

const AUTH_EXACT_DEPS = new Set(["better-auth", "next-auth", "lucia"]);

function isAuthScopedDep(name: string): boolean {
  if (name.startsWith("@auth/")) {
    return true;
  }
  if (name.startsWith("@clerk/")) {
    return true;
  }
  return false;
}

export async function hasAuthDependency(cwd: string): Promise<boolean> {
  const pkgPath = path.join(cwd, "package.json");
  try {
    const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = readPackageDeps(pkg);
    for (const name of Object.keys(deps)) {
      if (AUTH_EXACT_DEPS.has(name) || isAuthScopedDep(name)) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}
