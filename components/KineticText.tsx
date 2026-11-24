"use client";

import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import type { KineticStore, KineticWord } from "@/lib/kinetic/types";

const EASE = "cubic-bezier(.16, 1, .3, 1)";
const MOVE_MS = 420;

interface Pos { left: number; top: number }

/**
 * Kinetic Center Build — one component for both Vivian (TTS) and the user (STT).
 * New words enter from the right, existing words shift smoothly (2D FLIP,
 * transform only), the active word is emphasised and older words fade gently.
 * Frames arrive via an external store so the parent never re-renders per word.
 */
export function KineticText({ store, variant, label }: { store: KineticStore; variant: "vivian" | "user"; label?: string }) {
  const words = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const rowRef = useRef<HTMLSpanElement>(null);
  const positions = useRef(new Map<string, Pos>());
  const anims = useRef(new WeakMap<HTMLElement, Animation>());

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const next = new Map<string, Pos>();
    const previous = positions.current;
    for (const el of Array.from(row.children) as HTMLElement[]) {
      const id = el.dataset.id ?? "";
      let activeDx = 0;
      let activeDy = 0;
      const prevAnim = anims.current.get(el);
      if (prevAnim) {
        if (typeof getComputedStyle === "function" && typeof DOMMatrix !== "undefined") {
          const t = getComputedStyle(el).transform;
          if (t && t !== "none") {
            try {
              const m = new DOMMatrix(t);
              activeDx = m.m41;
              activeDy = m.m42;
            } catch {
              activeDx = 0;
              activeDy = 0;
            }
          }
        }
        prevAnim.cancel();
        anims.current.delete(el);
      }
      const rect = el.getBoundingClientRect();
      next.set(id, { left: rect.left, top: rect.top });
      if (reduce || typeof el.animate !== "function") continue;
      const before = previous.get(id);
      if (before === undefined) {
        // Incoming word: enter from the right.
        const anim = el.animate(
          [{ transform: "translate(24px, 0) scale(.94)", opacity: 0 }, { transform: "translate(0, 0) scale(1)", opacity: 1 }],
          { duration: MOVE_MS, easing: EASE },
        );
        anims.current.set(el, anim);
      } else {
        const dx = before.left + activeDx - rect.left;
        const dy = before.top + activeDy - rect.top;
        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
          const anim = el.animate(
            [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }],
            { duration: MOVE_MS, easing: EASE },
          );
          anims.current.set(el, anim);
        }
      }
    }
    positions.current = next;
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
            className={`kinetic-word is-${word.state}${word.spaceBefore ? " has-space" : ""}`}
            style={{ ["--age" as string]: String(count - 1 - index) }}
          >
            {word.text}
          </span>
        ))}
      </span>
    </span>
  );
}
