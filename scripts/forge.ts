// Thin wrapper so `npm run …` works whether forge is on PATH or only in ~/.foundry/bin.
import { spawnSync } from "node:child_process";
import { foundryBin } from "./lib/foundry.ts";

const res = spawnSync(foundryBin("forge"), process.argv.slice(2), { stdio: "inherit" });
process.exit(res.status ?? 1);
