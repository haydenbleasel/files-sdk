"use client";

import {
  cubicBezier,
  transform,
  useInView,
  useReducedMotion,
} from "motion/react";
import { useEffect, useRef, useState } from "react";

// All ported scene logic is authored at 30fps (matching the Remotion sources in
// packages/1.6-video), so frame thresholds copy over unchanged.
const FPS = 30;

type Easing = (t: number) => number;

// Mirror the easing curves used across the release-video scenes.
export const EASE_OUT = cubicBezier(0.16, 1, 0.3, 1);
export const EASE_PROGRESS = cubicBezier(0.33, 1, 0.68, 1);
export const EASE_SCRUB = cubicBezier(0.4, 0, 0.2, 1);

/**
 * Map `frame` from an input range to an output range, clamped at both ends —
 * a drop-in for Remotion's `interpolate(..., { extrapolate: "clamp" })`.
 */
export const interpolate = (
  frame: number,
  input: readonly [number, number],
  output: readonly [number, number],
  ease?: Easing
): number =>
  transform(frame, [input[0], input[1]], [output[0], output[1]], {
    clamp: true,
    ...(ease ? { ease } : {}),
  });

/**
 * Replaces Remotion's `useCurrentFrame()`: advances a 30fps frame counter while
 * the returned ref is in view. By default it plays through once each time the
 * panel enters view and settles on the final frame; pass `loop: true` to instead
 * hold on the last frame for `holdFrames`, then restart. Reduced motion pins to
 * the final frame so panels render their settled end state.
 */
export const useSceneFrame = (
  totalFrames: number,
  holdFrames = 36,
  loop = false
) => {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.4 });
  const reduced = useReducedMotion();
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (reduced) {
      setFrame(totalFrames);
      return;
    }
    if (!inView) {
      // Rewind so a non-looping scene replays from the start next time it
      // scrolls back into view.
      if (!loop) {
        setFrame(0);
      }
      return;
    }

    const cycle = totalFrames + holdFrames;
    let raf = 0;
    let start = 0;

    const tick = (now: number) => {
      if (!start) {
        start = now;
      }
      const elapsed = ((now - start) / 1000) * FPS;

      if (loop) {
        setFrame(Math.min(Math.floor(elapsed % cycle), totalFrames));
        raf = requestAnimationFrame(tick);
        return;
      }

      const next = Math.floor(elapsed);
      setFrame(Math.min(next, totalFrames));
      if (next < totalFrames) {
        raf = requestAnimationFrame(tick);
      }
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [inView, reduced, totalFrames, holdFrames, loop]);

  return { frame, ref };
};
