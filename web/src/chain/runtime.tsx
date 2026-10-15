// The single chain layer: clients, wagmi config, chain health and live event subscription.
// Everything chain-related in the UI reads from here; listeners are created once and torn down
// on unmount.
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  createPublicClient,
  defineChain,
  fallback,
  http,
  webSocket,
  type Chain,
  type PublicClient,
  type WatchContractEventReturnType,
} from "viem";
import { createConfig, WagmiProvider, type Config, type CreateConnectorFn } from "wagmi";
import { ostrakonAbi } from "../generated/ostrakonAbi";
import type { Deployment } from "./deployment";
import { decodeLogs, type AuditEntry } from "./reads";

export interface Runtime {
  deployment: Deployment;
  chain: Chain;
  client: PublicClient;
  /** Fail-fast HTTP client for liveness checks (no retries, short timeout). */
  health: PublicClient;
  wagmi: Config;
  deployBlock: bigint;
}

export function createRuntime(deployment: Deployment, connectors: CreateConnectorFn[]): Runtime {
  const chain = defineChain({
    id: deployment.chainId,
    name: deployment.chainName,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: {
      default: { http: [deployment.rpcUrl], ...(deployment.wsUrl ? { webSocket: [deployment.wsUrl] } : {}) },
    },
    testnet: true,
  });
  const transport = deployment.wsUrl
    ? fallback([webSocket(deployment.wsUrl, { retryCount: 1 }), http(deployment.rpcUrl)])
    : http(deployment.rpcUrl);
  const client = createPublicClient({ chain, transport, pollingInterval: 1_000 }) as PublicClient;
  const health = createPublicClient({
    chain,
    transport: http(deployment.rpcUrl, { retryCount: 0, timeout: 2_500 }),
  }) as PublicClient;
  const wagmi = createConfig({
    chains: [chain],
    connectors,
    transports: { [chain.id]: http(deployment.rpcUrl) },
    multiInjectedProviderDiscovery: true,
  });
  return { deployment, chain, client, health, wagmi, deployBlock: BigInt(deployment.deployBlock) };
}

// ------------------------------------------------------------------ health

export type RpcState = "checking" | "up" | "down";
export type CodeState = "checking" | "present" | "missing";

export interface Health {
  rpc: RpcState;
  code: CodeState;
  block: bigint | null;
  /** Bumped whenever the chain is detected to have reset (block number went backwards). */
  resets: number;
}

interface Ctx {
  runtime: Runtime;
  health: Health;
  /** Most recent live events (newest first), for the audit feed's "just in" markers. */
  live: AuditEntry[];
}

const RuntimeContext = createContext<Ctx | null>(null);

export function useRuntime(): Ctx {
  const ctx = useContext(RuntimeContext);
  if (!ctx) throw new Error("useRuntime outside RuntimeProvider");
  return ctx;
}

/** Stable query-key prefix: everything under it is invalidated on contract events. */
export function useKeyBase(): readonly [string, string, number] {
  const { runtime } = useRuntime();
  return ["ostrakon", runtime.deployment.address, runtime.deployment.chainId] as const;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false },
  },
});

export function RuntimeProvider({ runtime, children }: { runtime: Runtime; children: ReactNode }) {
  return (
    <WagmiProvider config={runtime.wagmi}>
      <QueryClientProvider client={queryClient}>
        <ChainWatcher runtime={runtime}>{children}</ChainWatcher>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

function ChainWatcher({ runtime, children }: { runtime: Runtime; children: ReactNode }) {
  const qc = useQueryClient();
  const [health, setHealth] = useState<Health>({ rpc: "checking", code: "checking", block: null, resets: 0 });
  const [live, setLive] = useState<AuditEntry[]>([]);
  const lastBlock = useRef<bigint | null>(null);
  const rpcUp = useRef<boolean | null>(null);
  const { client, deployment } = runtime;

  // Block number + chain reset detection + code presence. One eth_blockNumber per second on a
  // no-retry HTTP client, so an outage shows within ~2s. viem's watchBlockNumber is not used here:
  // it ignores block numbers that go backwards, which is exactly what a restarted chain does.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polls = 0;
    const { health: probe } = runtime;
    const checkCode = async () => {
      try {
        const code = await probe.getCode({ address: deployment.address });
        if (!cancelled) setHealth((h) => ({ ...h, code: code && code !== "0x" ? "present" : "missing" }));
      } catch (err) {
        console.error("[ostrakon] getCode failed", err);
      }
    };
    const tick = async () => {
      try {
        const block = await probe.getBlockNumber({ cacheTime: 0 });
        if (cancelled) return;
        const prev = lastBlock.current;
        lastBlock.current = block;
        const reset = prev !== null && block < prev;
        const recovering = !rpcUp.current;
        rpcUp.current = true;
        // (Re)check the deployment on first contact, after an outage, after a reset, and every 10s.
        if (reset || recovering || polls % 10 === 0) void checkCode();
        if (reset || recovering) {
          setLive([]);
          void qc.invalidateQueries({ queryKey: ["ostrakon"] });
        }
        if (block !== prev || recovering) {
          setHealth((h) => ({ ...h, rpc: "up", block, resets: reset ? h.resets + 1 : h.resets }));
        }
      } catch (err) {
        if (cancelled) return;
        if (rpcUp.current !== false) console.error("[ostrakon] chain unreachable", err);
        rpcUp.current = false;
        setHealth((h) => (h.rpc === "down" ? h : { ...h, rpc: "down" }));
      } finally {
        polls++;
        if (!cancelled) timer = setTimeout(() => void tick(), 1_000);
      }
    };
    void tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [runtime, deployment.address, qc]);

  // Contract events: subscription over WebSocket when available, polling fallback otherwise.
  useEffect(() => {
    let unwatch: WatchContractEventReturnType | null = null;
    let usePoll = !deployment.wsUrl;
    let disposed = false;
    const start = () => {
      unwatch?.();
      unwatch = client.watchContractEvent({
        address: deployment.address,
        abi: ostrakonAbi,
        ...(usePoll ? { poll: true as const, pollingInterval: 1_000 } : {}),
        onLogs: (logs) => {
          const entries = decodeLogs(logs);
          if (entries.length === 0) return;
          setLive((prev) => [...entries.reverse(), ...prev].slice(0, 50));
          void qc.invalidateQueries({ queryKey: ["ostrakon"] });
        },
        onError: (err) => {
          console.error("[ostrakon] event watch error", err);
          if (!usePoll && !disposed) {
            usePoll = true; // fall back to log polling
            start();
          }
        },
      });
    };
    start();
    return () => {
      disposed = true;
      unwatch?.();
    };
  }, [client, deployment.address, deployment.wsUrl, qc]);

  const value = useMemo(() => ({ runtime, health, live }), [runtime, health, live]);
  return <RuntimeContext.Provider value={value}>{children}</RuntimeContext.Provider>;
}
