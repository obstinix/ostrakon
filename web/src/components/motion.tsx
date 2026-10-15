// Motion primitives. Rules: animate transform/opacity only, never hide content that a reader
// needs (final values are always in the DOM), and render statically under reduced motion.
import { animate, useInView, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type PointerEvent, type ReactNode } from "react";

const subscribeVisibility = (cb: () => void) => {
  document.addEventListener("visibilitychange", cb);
  return () => document.removeEventListener("visibilitychange", cb);
};
const getVisible = () => document.visibilityState === "visible";

/** Integer that counts up from its previous value the first time it scrolls into view. */
export function CountUp({ value, className }: { value: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: "0px 0px -10% 0px" });
  const reduce = useReducedMotion();
  // Background tabs pause requestAnimationFrame: show the real value rather than a stalled frame.
  const visible = useSyncExternalStore(subscribeVisibility, getVisible, () => true);
  const shown = useRef(0);
  const [display, setDisplay] = useState(0);
  const instant = reduce || !visible;

  useEffect(() => {
    if (instant || !inView) return;
    const controls = animate(shown.current, value, {
      duration: 0.8,
      ease: [0.2, 0.7, 0.2, 1],
      onUpdate: (v) => {
        shown.current = v;
        setDisplay(Math.round(v));
      },
    });
    return () => controls.stop();
  }, [value, inView, instant]);

  return (
    <span ref={ref} className={className}>
      {/* Screen readers always get the real value, never an intermediate frame. */}
      <span aria-hidden="true">{instant ? value : display}</span>
      <span className="sr-only">{value}</span>
    </span>
  );
}

/** Horizontal bar that fills (scaleX) to `share` when in view. */
export function FillBar({ share, tone = "clay" }: { share: number; tone?: "clay" | "olive" | "ink" }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: "0px 0px -10% 0px" });
  const reduce = useReducedMotion();
  const scale = reduce || inView ? share : 0;
  return (
    <span className="bar" ref={ref} aria-hidden="true">
      <span className={`bar-fill tone-${tone}`} style={{ transform: `scaleX(${scale})` }} />
    </span>
  );
}

/** Fades/lifts children in once, staggered by `index`. Content is in the DOM from the start. */
export function Reveal({ index = 0, children, as = "div", className }: {
  index?: number;
  children: ReactNode;
  as?: "div" | "li" | "section";
  className?: string;
}) {
  const ref = useRef<HTMLElement>(null);
  const inView = useInView(ref, { once: true, margin: "0px 0px -5% 0px" });
  const reduce = useReducedMotion();
  const Tag = as;
  const style: CSSProperties | undefined = reduce
    ? undefined
    : {
        opacity: inView ? 1 : 0,
        transform: inView ? "none" : "translateY(10px)",
        transition: `opacity var(--t-slow) var(--ease-out) ${Math.min(index, 12) * 45}ms, transform var(--t-slow) var(--ease-out) ${Math.min(index, 12) * 45}ms`,
      };
  return (
    <Tag ref={ref as never} className={className} style={style}>
      {children}
    </Tag>
  );
}

/**
 * Subtle pointer-tracked tilt for a card. Writes a transform directly on the element (no React
 * re-render per pointer move). Mouse only: touch, pen and reduced motion get no tilt.
 */
export function useTilt<T extends HTMLElement>(max = 3) {
  const reduce = useReducedMotion();
  const frame = useRef(0);
  const onPointerMove = (e: PointerEvent<T>) => {
    if (reduce || e.pointerType !== "mouse") return;
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5;
    const y = (e.clientY - r.top) / r.height - 0.5;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      el.style.transform = `perspective(900px) rotateX(${(-y * max).toFixed(2)}deg) rotateY(${(x * max).toFixed(2)}deg)`;
    });
  };
  const onPointerLeave = (e: PointerEvent<T>) => {
    cancelAnimationFrame(frame.current);
    e.currentTarget.style.transform = "";
  };
  return { onPointerMove, onPointerLeave };
}
