// First-run config bootstrap for source and portable-bundle installs: Docker mounts a real
// config/portfolio.yaml read-only, but those two distribution modes start from nothing. Copies the example
// config into place the first time the server starts, and never touches a file that already exists.
import { copyFile, access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname } from "node:path";

export type ConfigBootstrapResult = "existing" | "created" | "missing";

/**
 * Ensures a config file exists at `path`, copying it from `examplePath` on first run.
 * - "existing": `path` was already there; left untouched.
 * - "created": `path` did not exist and was copied from `examplePath`.
 * - "missing": neither `path` nor `examplePath` exists; caller is responsible for the resulting failure mode.
 */
export async function ensureConfigFile(path: string, examplePath: string): Promise<ConfigBootstrapResult> {
  if (await pathExists(path)) return "existing";
  if (!(await pathExists(examplePath))) return "missing";
  await mkdir(dirname(path), { recursive: true });
  try {
    // COPYFILE_EXCL: never overwrite a config that appeared between the check above and this call.
    await copyFile(examplePath, path, constants.COPYFILE_EXCL);
    return "created";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return "existing";
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
