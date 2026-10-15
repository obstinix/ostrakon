import { isAddress, type Address, type Hash } from "viem";

/** Written by scripts/dev.ts after deploy; served as /deployment.json. */
export interface Deployment {
  chainId: number;
  chainName: string;
  rpcUrl: string;
  wsUrl?: string;
  address: Address;
  deployBlock: string; // decimal string (JSON has no bigint)
  deployTx: Hash;
  deployedAt: string; // ISO time
}

export type DeploymentLoad =
  | { status: "ok"; deployment: Deployment }
  | { status: "missing" } // file absent: dev script not run / no build-time config
  | { status: "invalid" }; // file present but malformed

export function parseDeployment(raw: unknown): Deployment | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  if (
    typeof d.chainId !== "number" ||
    typeof d.chainName !== "string" ||
    typeof d.rpcUrl !== "string" ||
    typeof d.address !== "string" ||
    !isAddress(d.address) ||
    typeof d.deployBlock !== "string" ||
    !/^\d+$/.test(d.deployBlock) ||
    typeof d.deployTx !== "string" ||
    typeof d.deployedAt !== "string"
  ) {
    return null;
  }
  if (d.wsUrl !== undefined && typeof d.wsUrl !== "string") return null;
  return d as unknown as Deployment;
}

export async function loadDeployment(url = "/deployment.json"): Promise<DeploymentLoad> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return { status: "missing" };
    const type = res.headers.get("content-type") ?? "";
    if (!type.includes("json")) return { status: "missing" };
    const parsed = parseDeployment(await res.json());
    return parsed ? { status: "ok", deployment: parsed } : { status: "invalid" };
  } catch (err) {
    console.error("deployment: failed to load", err);
    return { status: "missing" };
  }
}
