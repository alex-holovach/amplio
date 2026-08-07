import { cp, mkdir, open, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRegistry = path.resolve(cliRoot, "../../registry");
const dest = path.join(cliRoot, "registry");
const lockPath = path.join(cliRoot, ".registry-copy.lock");

async function withLock(fn) {
  await mkdir(cliRoot, { recursive: true });
  let handle;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      handle = await open(lockPath, "wx");
      break;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
        await new Promise((r) => setTimeout(r, 25 + attempt * 10));
        continue;
      }
      throw error;
    }
  }
  if (!handle) {
    throw new Error(`Could not acquire registry copy lock at ${lockPath}`);
  }
  try {
    return await fn();
  } finally {
    await handle.close();
    await rm(lockPath, { force: true });
  }
}

await withLock(async () => {
  const staging = path.join(cliRoot, `.registry-staging-${process.pid}-${Date.now()}`);
  await rm(staging, { recursive: true, force: true });
  await cp(repoRegistry, staging, { recursive: true });
  await rm(dest, { recursive: true, force: true });
  await cp(staging, dest, { recursive: true });
  await rm(staging, { recursive: true, force: true });
  console.log(`Copied registry → ${path.relative(cliRoot, dest)}`);
});
