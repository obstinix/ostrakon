import type { PhaseName } from "../chain/reads";

/** Phase label with a three-notch glyph (like tally marks scratched on a shard). */
export function PhaseMark({ phase, index, finalized }: { phase: PhaseName; index: 0 | 1 | 2; finalized?: boolean }) {
  return (
    <span className={`phase phase-${index}`}>
      <span className="phase-notches" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <i key={i} className={i <= index ? "on" : ""} />
        ))}
      </span>
      {phase}
      {finalized ? <span className="phase-final">· final</span> : null}
    </span>
  );
}
