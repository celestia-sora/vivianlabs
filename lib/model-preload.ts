import type { ModelPackage } from "./local-models";

interface Flight<T> {
  controller: AbortController;
  promise: Promise<T>;
  consumers: number;
  settled: boolean;
}

const flights = new Map<string, Flight<unknown>>();

/** Share one package hydration/download between startup preload and rendering. */
export function singleFlightModel<T>(
  key: string,
  operation: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  let flight = flights.get(key) as Flight<T> | undefined;
  if (!flight) {
    const controller = new AbortController();
    const created: Flight<T> = { controller, consumers: 0, settled: false, promise: Promise.resolve().then(() => operation(controller.signal)) };
    flight = created;
    flights.set(key, created as Flight<unknown>);
    void created.promise.finally(() => {
      created.settled = true;
      if (flights.get(key) === created) flights.delete(key);
    }).catch(() => {});
  }
  const shared = flight;
  shared.consumers++;
  return new Promise<T>((resolve, reject) => {
    let finished = false;
    const release = () => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener("abort", abort);
      shared.consumers--;
      if (!shared.settled && shared.consumers === 0) shared.controller.abort();
    };
    const abort = () => {
      release();
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    shared.promise.then((value) => { if (!finished) { release(); resolve(value); } }, (error) => { if (!finished) { release(); reject(error); } });
  });
}

export interface PreloadModelPackagesOptions {
  /** Returns true while the active/selected model is loading or switching. */
  isActiveBusy?: () => boolean;
}

function delayWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Yield before the next background package so the active model's
 * rendering, input and speech keep priority. Prefers requestIdleCallback
 * when available (browser), otherwise falls back to a short timer.
 */
function idleYield(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  const requestIdle = (globalThis as unknown as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  }).requestIdleCallback;
  if (typeof requestIdle === "function") {
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        if (typeof (globalThis as unknown as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback === "function") {
          (globalThis as unknown as { cancelIdleCallback: (id: number) => void }).cancelIdleCallback(id);
        }
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      };
      const id = requestIdle.call(globalThis, () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, { timeout: 800 });
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
  return delayWithAbort(350, signal);
}

async function waitForLowPriorityWindow(signal: AbortSignal, isActiveBusy?: () => boolean): Promise<void> {
  // Pause while the selected model owns initialization (assets, textures,
  // GPU resources). Poll abortably so a new selection pauses immediately.
  while (isActiveBusy?.()) {
    signal.throwIfAborted();
    await delayWithAbort(150, signal);
  }
  signal.throwIfAborted();
  await idleYield(signal);
}

/**
 * Background queue for non-selected packages.
 *
 * The selected model is intentionally excluded: it is owned by the render
 * path with maximum priority (hydrate -> texture planning -> Live2DModel.from
 * -> first frame). This queue only warms the remaining packages sequentially
 * with low priority, reusing singleFlightModel deduplication and skipping
 * packages that already hold in-memory assets.
 */
export async function preloadModelPackages(
  packages: ModelPackage[], selectedModelId: string | null,
  load: (pack: ModelPackage, signal: AbortSignal) => Promise<unknown>, signal: AbortSignal,
  options?: PreloadModelPackagesOptions,
): Promise<void> {
  const selectedPack = packages.find((pack) => pack.models.some((model) => model.id === selectedModelId));
  const seen = new Set<string>();
  const queue: ModelPackage[] = [];
  // Catalog arrays are oldest -> newest (resolveStartupModel defaults to the
  // last entry), so walk newest-first for background warming.
  for (const pack of [...packages].reverse()) {
    if (pack === selectedPack) continue;
    // Already hydrated in memory: do not re-probe or re-download.
    if (pack.assets.length > 0) continue;
    if (seen.has(pack.id)) continue;
    seen.add(pack.id);
    queue.push(pack);
  }
  for (const pack of queue) {
    signal.throwIfAborted();
    await waitForLowPriorityWindow(signal, options?.isActiveBusy);
    signal.throwIfAborted();
    await load(pack, signal).catch((error: unknown) => {
      if (signal.aborted) throw error;
      // Continue the queue after individual failures.
    });
  }
}
