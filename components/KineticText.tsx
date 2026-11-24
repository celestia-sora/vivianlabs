"use client";

import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import type { KineticStore, KineticWord } from "@/lib/kinetic/types";

const EASE = "cubic-bezier(.16, 1, .3, 1)";
const MOVE_MS = 420;

/**
 * Kinetic Center Build — one component for both Vivian (TTS) and the user (STT).
 * New words enter from the right, the centered row slides left (FLIP, transform
 * only), the active word is emphasised and older words fade. Frames arrive via
 * an external store so the parent never re-renders per word.
 */
export function KineticText({ store, variant, label }: { store: KineticStore; variant: "vivian" | "user"; label?: string }) {
  const words = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const rowRef = useRef<HTMLSpanElement>(null);
  const lefts = useRef(new Map<string, number>());
  const anims = useRef(new WeakMap<HTMLElement, Animation>());

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const next = new Map<string, number>();
    const previous = lefts.current;
    for (const el of Array.from(row.children) as HTMLElement[]) {
      const id = el.dataset.id ?? "";
      let activeDx = 0;
      const prevAnim = anims.current.get(el);
      if (prevAnim) {
        if (typeof getComputedStyle === "function" && typeof DOMMatrix !== "undefined") {
          const t = getComputedStyle(el).transform;
          if (t && t !== "none") {
            try { activeDx = new DOMMatrix(t).m41; } catch { activeDx = 0; }
          }
        }
        prevAnim.cancel();
        anims.current.delete(el);
      }
      const left = el.getBoundingClientRect().left;
      next.set(id, left);
      if (reduce || typeof el.animate !== "function") continue;
      const before = previous.get(id);
      if (before === undefined) {
        // Incoming word: enter from the right.
        const anim = el.animate(
          [{ transform: "translateX(28px) scale(.92)", opacity: 0 }, { transform: "translateX(0) scale(1)", opacity: 1 }],
          { duration: MOVE_MS, easing: EASE },
        );
        anims.current.set(el, anim);
      } else {
        const delta = before + activeDx - left;
        if (Math.abs(delta) > 0.5) {
          const anim = el.animate([{ transform: `translateX(${delta}px)` }, { transform: "translateX(0)" }], { duration: MOVE_MS, easing: EASE });
          anims.current.set(el, anim);
        }
      }
    }
    lefts.current = next;
  }, [words]);

  const count = words.length;
  return (
    <span className={`kinetic-text kinetic-${variant}${count ? "" : " is-empty"}`} aria-hidden={count ? undefined : true}>
      {label ? <small className="kinetic-label">{label}</small> : null}
      <span className="kinetic-row" ref={rowRef}>
        {words.map((word: KineticWord, index: number) => (
          <span
            key={word.id}
            data-id={word.id}
            className={`kinetic-word is-${word.state}`}
            style={{ ["--age" as string]: String(count - 1 - index) }}
          >
            {word.text}
          </span>
        ))}
      </span>
    </span>
  );
}
