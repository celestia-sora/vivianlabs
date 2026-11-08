// Tactile feedback for the voice orb. The Vibration API is the only web-level
// haptic channel (Android browsers only); it degrades silently elsewhere
// (iOS Safari and reduced-motion contexts are a no-op) so orb widgets can
// call this unconditionally without perf or error costs.
export const hapticPatterns = {
  arm: [40, 30, 40] as const, // push-to-talk confirmed — a double beat, clearly stronger than a tap
  confirm: 35, // recording stopped / action accepted
  pick: 18, // quick-action selected
  tick: 12, // toolbar opened / discrete tap feedback
} as const;

let lastHapticAt = 0;

export function hapticFeedback(pattern: number | readonly number[] = hapticPatterns.tick): void {
  try {
    if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
    // Debounce repeated ticks (e.g. quick successive taps) to avoid buzz churn.
    const nowDate = Date.now();
    const isHeavy = Array.isArray(pattern);
    if (!isHeavy && nowDate - lastHapticAt < 60) return;
    lastHapticAt = nowDate;
    navigator.vibrate(pattern as number | number[]);
  } catch {
    // Unsupported hardware/browser: silently no-op. Never break interaction.
  }
}
