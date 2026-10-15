import { useEffect, useState } from "react";
import { short } from "../lib/format";

/** Copy-to-clipboard button with an announced confirmation. */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      className="copy"
      aria-label={`Copy ${label}`}
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
        } catch (err) {
          console.error("[ostrakon] clipboard", err);
        }
      }}
    >
      <span aria-hidden="true">{copied ? "copied" : "copy"}</span>
      <span className="sr-only" aria-live="polite">
        {copied ? `${label} copied` : ""}
      </span>
    </button>
  );
}

/** Monospace, truncated hex value (address or hash) with full value on hover/focus and a copy button. */
export function Hex({ value, label, head, tail, copy = true }: {
  value: string;
  label: string;
  head?: number;
  tail?: number;
  copy?: boolean;
}) {
  return (
    <span className="hex">
      <code title={value}>
        <span className="sr-only">{label}: </span>
        {short(value, head, tail)}
      </code>
      {copy && <CopyButton value={value} label={label} />}
    </span>
  );
}
