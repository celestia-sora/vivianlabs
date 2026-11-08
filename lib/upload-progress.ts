/**
 * Smooth upload progress simulation (ease-out / asymptotic).
 *
 * The bar starts fast, slows down, and never reaches 100% until the real
 * upload completes. When real progress is known, the bar tracks it via
 * `Math.max(simulated, actual)` so a fast upload can outrun the simulation,
 * while a stalled/slow upload keeps moving on its own toward the cap.
 */
export const UPLOAD_SIMULATION_CAP = 95;

/** Time constant (ms) for the simulated curve approaching the cap. */
const SIM_TAU_MS = 2600;
/** Time constant (ms) for displayed value easing toward its desired target. */
const DISPLAY_TAU_MS = 180;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Advance the pure simulation toward the cap using a frame-independent
 * exponential ease-out. Returns the new simulated value.
 */
export function stepSimulation(current: number, dtMs: number, cap = UPLOAD_SIMULATION_CAP): number {
  const dt = clamp(Number.isFinite(dtMs) ? dtMs : 16, 0, 100);
  const safeCurrent = clamp(Number.isFinite(current) ? current : 0, 0, cap);
  const factor = 1 - Math.exp(-dt / SIM_TAU_MS);
  return clamp(safeCurrent + (cap - safeCurrent) * factor, 0, cap);
}

/**
 * Ease the displayed percent toward `desired` without going backward.
 * `desired` should already be monotonic within one upload stage.
 */
export function easeDisplayed(current: number, desired: number, dtMs: number): number {
  const dt = clamp(Number.isFinite(dtMs) ? dtMs : 16, 0, 100);
  const safeCurrent = Number.isFinite(current) ? current : 0;
  const safeDesired = clamp(Number.isFinite(desired) ? desired : 0, 0, 100);
  if (safeDesired <= safeCurrent) return safeCurrent;
  const factor = 1 - Math.exp(-dt / DISPLAY_TAU_MS);
  return clamp(safeCurrent + (safeDesired - safeCurrent) * factor, safeCurrent, safeDesired);
}

/**
 * Desired (pre-smoothing) percent for one frame:
 * - indeterminate stages (actual === null): pure simulation
 * - determinate stages: at least simulated, at most capped actual
 */
export function desiredUploadPercent(simulated: number, actual: number | null): number {
  const sim = clamp(Number.isFinite(simulated) ? simulated : 0, 0, UPLOAD_SIMULATION_CAP);
  if (typeof actual !== "number" || !Number.isFinite(actual)) return sim;
  return Math.max(sim, clamp(actual, 0, UPLOAD_SIMULATION_CAP));
}
