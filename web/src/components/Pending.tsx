import { useRuntime } from "../chain/runtime";

/** Loading line that says why nothing is arriving when the chain or contract is unavailable. */
export function Pending({ what }: { what: string }) {
  const { health } = useRuntime();
  const text =
    health.rpc === "down"
      ? `Can't read the ${what} while the chain is unreachable.`
      : health.code === "missing"
        ? `Can't read the ${what}: there is no contract at the saved address.`
        : `Reading the ${what}…`;
  return (
    <section className="page">
      <p className="muted" role="status">
        {text}
      </p>
    </section>
  );
}
