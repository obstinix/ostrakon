// Allowlist membership for a voter: load the admin's published Merkle tree (from the link the admin
// set on chain, a file, or a paste), check it against the on-chain root, and derive this account's
// proof. Everything is computed locally; the list is cached per election in this browser.
import { useEffect, useState } from "react";
import { zeroHash, type Address, type Hex } from "viem";
import type { ElectionDetail } from "../chain/reads";
import { useRuntime } from "../chain/runtime";

export type Membership =
  | { status: "none" } // election has no allowlist
  | { status: "need-list" } // allowlist exists, but this browser has no copy of the tree
  | { status: "checking" }
  | { status: "member"; proof: Hex[] }
  | { status: "not-member" };

const MAX_BYTES = 5_000_000;

export function useAllowlistMembership(e: ElectionDetail, account: Address | undefined) {
  const { runtime } = useRuntime();
  const hasList = e.allowlistRoot !== zeroHash;
  const chainId = runtime.chain.id;
  const contract = runtime.deployment.address;
  const [treeJson, setTreeJson] = useState<string | null>(() => {
    try {
      return localStorage.getItem(`ostrakon:allowlist:${chainId}:${contract.toLowerCase()}:${e.id.toString()}`);
    } catch {
      return null;
    }
  });
  const [result, setResult] = useState<{ key: string; m: Membership } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const resultKey = `${treeJson?.length ?? 0}:${account ?? ""}:${e.allowlistRoot}`;

  useEffect(() => {
    if (!hasList || !treeJson || !account) return;
    let cancelled = false;
    void (async () => {
      const { loadAllowlist, proofFor, verifyMember } = await import("../lib/allowlist");
      const tree = loadAllowlist(treeJson);
      let m: Membership;
      if (!tree || tree.root.toLowerCase() !== e.allowlistRoot.toLowerCase()) {
        m = { status: "need-list" };
      } else {
        const proof = proofFor(tree, account);
        m = proof && verifyMember(e.allowlistRoot, account, proof) ? { status: "member", proof } : { status: "not-member" };
      }
      if (!cancelled) setResult({ key: resultKey, m });
    })();
    return () => {
      cancelled = true;
    };
  }, [hasList, treeJson, account, e.allowlistRoot, resultKey]);

  let membership: Membership;
  if (!hasList) membership = { status: "none" };
  else if (!treeJson) membership = { status: "need-list" };
  else if (!account) membership = { status: "checking" };
  else membership = result?.key === resultKey ? result.m : { status: "checking" };

  /** Accept a tree only if it is well-formed and matches the root published on chain. */
  const offer = async (text: string): Promise<boolean> => {
    setProblem(null);
    if (text.length > MAX_BYTES) {
      setProblem("That file is too large to be an allowlist (over 5 MB).");
      return false;
    }
    const { loadAllowlist, saveTree } = await import("../lib/allowlist");
    const tree = loadAllowlist(text);
    if (!tree) {
      setProblem("That isn't a valid allowlist file.");
      return false;
    }
    if (tree.root.toLowerCase() !== e.allowlistRoot.toLowerCase()) {
      setProblem("That list doesn't match the allowlist published on chain for this election.");
      return false;
    }
    saveTree(chainId, contract, e.id, text);
    setTreeJson(text);
    return true;
  };

  const fetchFrom = async (uri: string) => {
    setProblem(null);
    try {
      const res = await fetch(uri, { credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await offer(await res.text());
    } catch (err) {
      console.error("[ostrakon] allowlist fetch failed", err);
      setProblem("Couldn't load the list from that link. Ask the admin for the file and load it below.");
    }
  };

  return { membership, problem, offer, fetchFrom };
}

/** Only http(s) links are fetched; other schemes (ipfs://, etc.) are shown for the voter to open. */
export function fetchableUri(uri: string): boolean {
  return /^https?:\/\//i.test(uri) || uri.startsWith("/");
}

export function AllowlistLoader({
  uri,
  problem,
  offer,
  fetchFrom,
}: {
  uri: string;
  problem: string | null;
  offer: (text: string) => Promise<boolean>;
  fetchFrom: (uri: string) => Promise<void>;
}) {
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="allowlist-loader" data-testid="allowlist-loader">
      <p className="small">
        This election uses an allowlist: the admin published a fingerprint (Merkle root) of every eligible address.
        Load the full list to check whether this account is on it. It's checked in your browser.
      </p>
      {uri && fetchableUri(uri) && (
        <button
          type="button"
          className="btn btn-quiet"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await fetchFrom(uri);
            setBusy(false);
          }}
        >
          Load the list from the admin's link
        </button>
      )}
      {uri && !fetchableUri(uri) && (
        <p className="small">
          The admin published it at <code className="break">{uri}</code>. Download it, then load the file here.
        </p>
      )}
      <label className="field">
        <span>Allowlist file</span>
        <input
          type="file"
          accept="application/json,.json"
          onChange={async (ev) => {
            const f = ev.target.files?.[0];
            if (f) await offer(await f.text());
          }}
        />
      </label>
      <label className="field">
        <span>Or paste its contents</span>
        <textarea rows={3} className="mono" value={pasted} onChange={(ev) => setPasted(ev.target.value)} spellCheck={false} />
      </label>
      <button type="button" className="btn btn-quiet" disabled={!pasted.trim()} onClick={() => void offer(pasted)}>
        Check this list
      </button>
      {problem && <p className="inline-error">{problem}</p>}
    </div>
  );
}
