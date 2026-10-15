import { phasesFor, type PhaseName } from "../chain/reads";

/**
 * Phase label with one notch per phase this election goes through (three for open ballots, four
 * for secret ballots), filled up to the current one, like tally marks scratched on a shard.
 */
export function PhaseMark({ phase, secret, finalized }: { phase: PhaseName; secret: boolean; finalized?: boolean }) {
  const list = phasesFor({ secret });
  const step = list.indexOf(phase);
  return (
    <span className={`phase phase-${phase}`}>
      <span className="phase-notches" aria-hidden="true">
        {list.map((p, i) => (
          <i key={p} className={i <= step ? "on" : ""} />
        ))}
      </span>
      {phase}
      {finalized ? <span className="phase-final">· final</span> : null}
    </span>
  );
}
