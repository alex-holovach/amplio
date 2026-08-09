import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function resolveCliPackageJson(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "package.json");
    if (fs.existsSync(candidate)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(candidate, "utf8")) as { name?: string };
        if (pkg.name === "@useamplio/cli") {
          return candidate;
        }
      } catch {
        // keep walking
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error("Could not locate @useamplio/cli package.json");
}

const { version } = JSON.parse(fs.readFileSync(resolveCliPackageJson(), "utf8")) as {
  version: string;
};

export function getCliVersion(): string {
  return version;
}
