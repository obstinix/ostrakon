import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const exe = process.platform === "win32" ? ".exe" : "";

/**
 * Locate a Foundry binary (forge, anvil, cast).
 * Order: $FOUNDRY_BIN dir, PATH, ~/.foundry/bin (the foundryup default).
 */
export function foundryBin(name: "forge" | "anvil" | "cast"): string {
  const fromEnv = process.env.FOUNDRY_BIN;
  if (fromEnv) {
    const p = join(fromEnv, name + exe);
    if (existsSync(p)) return p;
  }
  const onPath = spawnSync(name, ["--version"], { stdio: "ignore", shell: false });
  if (onPath.status === 0) return name;
  const home = join(homedir(), ".foundry", "bin", name + exe);
  if (existsSync(home)) return home;
  console.error(
    `\n  Could not find "${name}". Ostrakon needs Foundry (forge + anvil).\n` +
      `  Install it: https://getfoundry.sh  (curl -L https://foundry.paradigm.xyz | bash && foundryup)\n` +
      `  or set FOUNDRY_BIN to the folder that contains ${name}${exe}.\n`,
  );
  process.exit(127);
}
