// Transactions as a first-class UI state:
//   simulating -> awaiting-signature -> pending(hash) -> confirmed(block, confirmations) | failed
// Every write is simulated against the chain first, so predictable reverts never reach the wallet.
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import type { ContractFunctionArgs, ContractFunctionName, Hash, ReplacementReason, TransactionReceipt } from "viem";
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

/**
 * What a wallet-side replacement means for the user's action. viem resolves with the replacement's
 * receipt in every case, but only a "repriced" replacement (same call, higher fee) did what the
 * user asked; "cancelled" and "replaced" (a different call) mean the action never happened.
 */
export function replacementOutcome(reason: ReplacementReason): "same-action" | "did-not-happen" {
  return reason === "repriced" ? "same-action" : "did-not-happen";
}

/** How long to wait for inclusion before telling the user to check back. */
export const RECEIPT_TIMEOUT_MS = 180_000;

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
        let replaced: ReplacementReason | null = null;
        const receipt = await runtime.client.waitForTransactionReceipt({
          hash,
          pollingInterval: 500,
          timeout: RECEIPT_TIMEOUT_MS,
          onReplaced: (r) => {
            replaced = r.reason;
          },
        });
        if (replaced !== null && replacementOutcome(replaced) === "did-not-happen") {
          setState({
            status: "failed",
            hash: receipt.transactionHash,
            error: {
              code: "replaced",
              message:
                replaced === "cancelled"
                  ? "You cancelled this transaction in your wallet, so it didn't happen."
                  : "Your wallet replaced this transaction with a different one, so this action didn't happen.",
            },
          });
          await qc.invalidateQueries({ queryKey: ["ostrakon"] });
          return null;
        }
        hash = receipt.transactionHash; // a repriced (sped-up) replacement has a new hash
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
