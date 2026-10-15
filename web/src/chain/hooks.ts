import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import type { Address, EIP1193Provider } from "viem";
import { useConnect, useConnection, useConnectors, useDisconnect, useSwitchChain } from "wagmi";
import { decodeError, type Curated } from "./errors";
import {
  findMyVotes,
  getAllVoters,
  getAuditLog,
  getElectionDetail,
  getVoterStatus,
  listElections,
  listVoterStatuses,
} from "./reads";
import { useKeyBase, useRuntime } from "./runtime";

/** Reads only run while the contract is known to exist at the configured address. */
function useReady(): boolean {
  const { health } = useRuntime();
  return health.rpc === "up" && health.code === "present";
}

export function useElections() {
  const { runtime } = useRuntime();
  const base = useKeyBase();
  return useQuery({
    queryKey: [...base, "elections"],
    queryFn: () => listElections(runtime.client, runtime.deployment.address),
    enabled: useReady(),
  });
}

export function useMyStatuses(account: Address | undefined) {
  const { runtime } = useRuntime();
  const base = useKeyBase();
  return useQuery({
    queryKey: [...base, "statuses", account],
    queryFn: () => listVoterStatuses(runtime.client, runtime.deployment.address, account!),
    enabled: useReady() && !!account,
  });
}

export function useElection(id: bigint | null) {
  const { runtime } = useRuntime();
  const base = useKeyBase();
  return useQuery({
    queryKey: [...base, "election", id?.toString()],
    queryFn: () => getElectionDetail(runtime.client, runtime.deployment.address, id!),
    enabled: useReady() && id !== null,
  });
}

export function useVoterStatus(id: bigint | null, account: Address | undefined) {
  const { runtime } = useRuntime();
  const base = useKeyBase();
  return useQuery({
    queryKey: [...base, "status", id?.toString(), account],
    queryFn: () => getVoterStatus(runtime.client, runtime.deployment.address, id!, account!),
    enabled: useReady() && id !== null && !!account,
  });
}

export function useVoters(id: bigint | null) {
  const { runtime } = useRuntime();
  const base = useKeyBase();
  return useQuery({
    queryKey: [...base, "voters", id?.toString()],
    queryFn: () => getAllVoters(runtime.client, runtime.deployment.address, id!),
    enabled: useReady() && id !== null,
  });
}

export function useAuditLog(electionId?: bigint) {
  const { runtime } = useRuntime();
  const base = useKeyBase();
  return useQuery({
    queryKey: [...base, "audit", electionId?.toString() ?? "all"],
    queryFn: () =>
      getAuditLog(runtime.client, runtime.deployment.address, runtime.deployBlock, { electionId }),
    enabled: useReady(),
  });
}

export function useMyVotes(account: Address | undefined) {
  const { runtime } = useRuntime();
  const base = useKeyBase();
  return useQuery({
    queryKey: [...base, "myVotes", account],
    queryFn: () => findMyVotes(runtime.client, runtime.deployment.address, runtime.deployBlock, account!),
    enabled: useReady() && !!account,
  });
}

// ------------------------------------------------------------------ wallet

export type WalletState =
  | { kind: "no-wallet" }
  | { kind: "locked" }
  | { kind: "disconnected" }
  | { kind: "connecting" }
  | { kind: "wrong-chain"; address: Address; chainId: number }
  | { kind: "connected"; address: Address; chainId: number };

type MaybeMetaMask = EIP1193Provider & { _metamask?: { isUnlocked?: () => Promise<boolean> } };

/** Derived wallet state plus the three actions the UI needs. */
export function useWalletController() {
  const { runtime } = useRuntime();
  const connection = useConnection();
  const connectors = useConnectors();
  const connect = useConnect();
  const disconnect = useDisconnect();
  const switchChain = useSwitchChain();
  const [hasProvider, setHasProvider] = useState<boolean | null>(null);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState<Curated | null>(null);

  // Detect whether any wallet is installed, and whether an installed MetaMask is locked.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let found = false;
      let isLocked = false;
      for (const c of connectors) {
        try {
          const p = (await c.getProvider()) as MaybeMetaMask | undefined;
          if (!p) continue;
          found = true;
          const unlocked = await p._metamask?.isUnlocked?.();
          if (unlocked === false) isLocked = true;
        } catch (err) {
          console.error("[ostrakon] provider probe failed", err);
        }
      }
      if (!cancelled) {
        setHasProvider(found);
        setLocked(isLocked);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connectors, connection.status]);

  let state: WalletState;
  if (connection.status === "connected") {
    state =
      connection.chainId === runtime.chain.id
        ? { kind: "connected", address: connection.address, chainId: connection.chainId }
        : { kind: "wrong-chain", address: connection.address, chainId: connection.chainId };
  } else if (connection.status === "connecting" || connection.status === "reconnecting" || connect.isPending) {
    state = { kind: "connecting" };
  } else if (hasProvider === false) {
    state = { kind: "no-wallet" };
  } else if (locked) {
    state = { kind: "locked" };
  } else {
    state = { kind: "disconnected" };
  }

  const doConnect = useCallback(async () => {
    setError(null);
    const connector = connectors[0];
    if (!connector) return;
    try {
      await connect.mutateAsync({ connector, chainId: runtime.chain.id });
    } catch (err) {
      setError(decodeError(err));
    }
  }, [connect, connectors, runtime.chain.id]);

  const doSwitch = useCallback(async () => {
    setError(null);
    try {
      // wagmi falls back to wallet_addEthereumChain when the wallet doesn't know the chain.
      await switchChain.mutateAsync({ chainId: runtime.chain.id });
    } catch (err) {
      setError(decodeError(err));
    }
  }, [switchChain, runtime.chain.id]);

  const doDisconnect = useCallback(() => {
    setError(null);
    disconnect.mutate();
  }, [disconnect]);

  return { state, error, connect: doConnect, switchChain: doSwitch, disconnect: doDisconnect };
}

/** Address of the connected account when it is on the right chain, else undefined. */
export function useAccount(): Address | undefined {
  const { runtime } = useRuntime();
  const c = useConnection();
  return c.status === "connected" && c.chainId === runtime.chain.id ? c.address : undefined;
}
