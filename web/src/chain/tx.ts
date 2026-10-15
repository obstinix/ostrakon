// Transactions as a first-class UI state:
//   simulating -> awaiting-signature -> pending(hash) -> confirmed(block, confirmations) | failed
// Every write is simulated against the chain first, so predictable reverts never reach the wallet.
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import type { ContractFunctionArgs, ContractFunctionName, Hash, TransactionReceipt } from "viem";
import { useConnection } from "wagmi";
import { writeContract } from "wagmi/actions";
import { ostrakonAbi } from "../generated/ostrakonAbi";
import { decodeError, type Curated } from "./errors";
import { useRuntime } from "./runtime";

type WriteName = ContractFunctionName<typeof ostrakonAbi, "nonpayable">;
type WriteArgs<N extends WriteName> = ContractFunctionArgs<typeof ostrakonAbi, "nonpayable", N>;

export type TxState =
  | { status: "idle" }
  | { status: "simulating" }
  | { status: "awaiting-signature" }
  | { status: "pending"; hash: Hash }
  | { status: "confirmed"; hash: Hash; blockNumber: bigint }
  | { status: "failed"; error: Curated; hash?: Hash };

export interface TxCall<N extends WriteName = WriteName> {
  functionName: N;
  args: WriteArgs<N>;
}

export function useTx() {
  const { runtime } = useRuntime();
  const connection = useConnection();
  const qc = useQueryClient();
  const [state, setState] = useState<TxState>({ status: "idle" });
  const busy = useRef(false);

  const run = useCallback(
    async <N extends WriteName>(call: TxCall<N>): Promise<TransactionReceipt | null> => {
      if (busy.current) return null;
      if (connection.status !== "connected") {
        setState({ status: "failed", error: { code: "no-account", message: "Connect a wallet first." } });
        return null;
      }
      if (connection.chainId !== runtime.chain.id) {
        setState({
          status: "failed",
          error: { code: "wrong-chain", message: `Switch your wallet to ${runtime.chain.name} first.` },
        });
        return null;
      }
      busy.current = true;
      let hash: Hash | undefined;
      try {
        setState({ status: "simulating" });
        const { request } = await runtime.client.simulateContract({
          address: runtime.deployment.address,
          abi: ostrakonAbi,
          functionName: call.functionName,
          args: call.args,
          account: connection.address,
        } as never);
        setState({ status: "awaiting-signature" });
        hash = await writeContract(runtime.wagmi, { ...(request as object), chainId: runtime.chain.id } as never);
        setState({ status: "pending", hash });
        const receipt = await runtime.client.waitForTransactionReceipt({ hash, pollingInterval: 500 });
        if (receipt.status !== "success") {
          setState({
            status: "failed",
            hash,
            error: { code: "reverted", message: "The transaction was mined but reverted. Nothing was changed." },
          });
          return null;
        }
        setState({ status: "confirmed", hash, blockNumber: receipt.blockNumber });
        await qc.invalidateQueries({ queryKey: ["ostrakon"] });
        return receipt;
      } catch (err) {
        setState({ status: "failed", error: decodeError(err), ...(hash ? { hash } : {}) });
        return null;
      } finally {
        busy.current = false;
      }
    },
    [connection, runtime, qc],
  );

  const reset = useCallback(() => setState({ status: "idle" }), []);
  return { state, run, reset };
}

export function isBusy(s: TxState): boolean {
  return s.status === "simulating" || s.status === "awaiting-signature" || s.status === "pending";
}
