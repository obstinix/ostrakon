// Motion primitives, dependency-free. Rules: animate transform/opacity only, never hide content a
// reader needs (final values are always in the DOM), and render statically under reduced motion.
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from "react";

// ------------------------------------------------------------------ environment

const reduceQuery = "(prefers-reduced-motion: reduce)";
function subscribeReduce(cb: () => void) {
  const mq = window.matchMedia(reduceQuery);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReduce, () => window.matchMedia(reduceQuery).matches, () => false);
}

function subscribeVisibility(cb: () => void) {
  document.addEventListener("visibilitychange", cb);
  return () => document.removeEventListener("visibilitychange", cb);
}
/** Background tabs pause requestAnimationFrame; callers show final values instead of a stalled frame. */
function useDocumentVisible(): boolean {
  return useSyncExternalStore(subscribeVisibility, () => document.visibilityState === "visible", () => true);
}

/** True once the element has entered the viewport (with an optional bottom inset). */
export function useInViewOnce(ref: RefObject<Element | null>, bottomInset = "-10%"): boolean {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      { rootMargin: `0px 0px ${bottomInset} 0px` },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref, seen, bottomInset]);
  return seen;
}

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

// ------------------------------------------------------------------ components

/** Integer that counts up from its previous value once it scrolls into view. */
export function CountUp({ value, className }: { value: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInViewOnce(ref);
  const reduce = useReducedMotion();
  const visible = useDocumentVisible();
  const shown = useRef(0);
  const [display, setDisplay] = useState(0);
  const instant = reduce || !visible;

  useEffect(() => {
    if (instant || !inView) return;
    const from = shown.current;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / 800);
      const v = from + (value - from) * easeOut(t);
      shown.current = v;
      setDisplay(Math.round(v));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, inView, instant]);

  return (
    <span ref={ref} className={className}>
      {/* Screen readers always get the real value, never an intermediate frame. */}
      <span aria-hidden="true">{instant ? value : display}</span>
      <span className="sr-only">{value}</span>
    </span>
  );
}

/** Horizontal bar that fills (scaleX, CSS transition) to `share` once in view. */
export function FillBar({ share, tone = "clay" }: { share: number; tone?: "clay" | "olive" | "ink" }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInViewOnce(ref);
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
  const inView = useInViewOnce(ref, "-5%");
  const reduce = useReducedMotion();
  const Tag = as;
  const delay = Math.min(index, 12) * 45;
  const style: CSSProperties | undefined = reduce
    ? undefined
    : {
        opacity: inView ? 1 : 0,
        transform: inView ? "none" : "translateY(10px)",
        transition: `opacity var(--t-slow) var(--ease-out) ${delay}ms, transform var(--t-slow) var(--ease-out) ${delay}ms`,
      };
  return (
    <Tag ref={ref as never} className={className} style={style}>
      {children}
    </Tag>
  );
}

/**
 * Scroll-linked progress of `target` through the viewport, 0 when its top reaches `start` (fraction
 * of viewport height) and 1 when its bottom reaches `end`. `apply` runs at most once per frame from
 * a passive scroll listener and should only write transforms. Native scrolling is never altered.
 */
export function useScrollProgress(
  target: RefObject<HTMLElement | null>,
  apply: (progress: number) => void,
  { start = 0.75, end = 0.55, enabled = true } = {},
) {
  const applyRef = useRef(apply);
  useEffect(() => {
    applyRef.current = apply;
  });
  useEffect(() => {
    const el = target.current;
    if (!el || !enabled) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const r = el.getBoundingClientRect();
      const vh = window.innerHeight;
      const from = r.top - vh * start; // distance until the start line
      const total = r.height + vh * start - vh * end;
      const p = total <= 0 ? 1 : Math.min(1, Math.max(0, -from / total));
      applyRef.current(p);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [target, start, end, enabled]);
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
