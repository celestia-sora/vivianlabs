"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { authFetch } from "@/lib/auth/fetch";
import { notifyStorageChanged } from "@/lib/storage-status";
import type { SceneDecision, ScenePreferences, VivianScene } from "@/lib/scenes";
import { AUTO_SCENE_ENABLED } from "@/lib/scenes";

import { startTiming, cancelTiming, type LocalTiming } from "@/lib/performance";
import { preloadSceneLibrary } from "@/lib/scene-preload";
export { preloadSceneImage } from "@/lib/scene-preload";

export class SceneRequestError extends Error {
  constructor(
    message: string,
    public status?: number,
    public code?: string,
    public requiredTier?: string,
  ) {
    super(message);
  }
}

export async function sceneRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await authFetch(path, { ...options, signal: options?.signal ?? AbortSignal.timeout(25_000) });
  const data = await response.json();
  if (!response.ok) {
    throw new SceneRequestError(
      data.error ?? "เซฟฉากไม่ติดแฮะ ลองกดใหม่อีกรอบน้า",
      response.status,
      typeof data.code === "string" ? data.code : undefined,
      typeof data.requiredTier === "string" ? data.requiredTier : undefined,
    );
  }
  if (options?.method && options.method !== "GET") notifyStorageChanged();
  return data as T;
}
const SCENE_TOKEN_REFRESH_BUFFER_MS = 60_000;

export function hasFreshSceneToken(rawUrl: unknown, now = Date.now()): boolean {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) return false;
  if (!rawUrl.startsWith("/api/scenes/")) return true;
  try {
    const parsed = new URL(rawUrl, "https://vivian.local");
    const token = parsed.searchParams.get("token")?.trim();
    if (!token) return false;
    const dot = token.indexOf(".");
    if (dot <= 0) return false;
    const payloadB64 = token.slice(0, dot).replaceAll("-", "+").replaceAll("_", "/");
    const padded = payloadB64 + "=".repeat((4 - (payloadB64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded)) as { exp?: unknown };
    return typeof payload.exp === "number" && Number.isFinite(payload.exp) && payload.exp > now + SCENE_TOKEN_REFRESH_BUFFER_MS;
  } catch {
    return false;
  }
}

const defaults: ScenePreferences = { autoScene: false, activeSceneId: null, preset: null, revision: "" };
const noPresetImages: string[] = [];
export function useSceneLibrary(presetImages: string[] = noPresetImages, accountId = "default", backgroundReady = true) {
  const [scenes, setScenes] = useState<VivianScene[]>([]);
  const [preferences, setPreferences] = useState<ScenePreferences>(defaults);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectionTiming, setSelectionTiming] = useState<LocalTiming>();
  const timingRef = useRef<LocalTiming | undefined>(undefined);
  const writeQueue = useRef(Promise.resolve());
  const pending = useRef(0);
  const cacheKey = `vivian-scenes:${accountId}`;
  const generation = useRef(0);
  const mounted = useRef(true);
  const preferencesRef = useRef(preferences);
  const scenesRef = useRef(scenes);
  const refresh = useCallback(async () => {
    const version = generation.current;
    const data = await sceneRequest<{ scenes: VivianScene[]; preferences: ScenePreferences }>("/api/scenes");
    if (mounted.current) {
      scenesRef.current = data.scenes; setScenes(data.scenes); setReady(true);
      if (version === generation.current && !pending.current) { preferencesRef.current = data.preferences; setPreferences(data.preferences); setNotice(null); }
    }
  }, []);
  const invalidateRequests = useCallback(() => { generation.current++; }, []);
  useEffect(() => {
    mounted.current = true;
    queueMicrotask(() => {
      if (!mounted.current) return;
      try {
        const saved = JSON.parse(localStorage.getItem(cacheKey) ?? "null");
        if (saved && Array.isArray(saved.scenes) && saved.preferences && typeof saved.preferences.autoScene === "boolean") {
          const freshScenes = (saved.scenes as VivianScene[]).filter(
            (scene) => hasFreshSceneToken(scene?.imageUrl) && hasFreshSceneToken(scene?.thumbnailUrl),
          );
          preferencesRef.current = saved.preferences;
          setPreferences(saved.preferences);
          if (freshScenes.length > 0 || saved.scenes.length === 0) {
            scenesRef.current = freshScenes;
            setScenes(freshScenes);
            setReady(true);
          }
        }
      } catch { /* Optional metadata cache. */ }
      void refresh().catch((error: Error) => { if (mounted.current) setNotice(error.message); });
    });
    return () => { mounted.current = false; invalidateRequests(); cancelTiming(timingRef.current); };
  }, [refresh, invalidateRequests, cacheKey]);
  useEffect(() => {
    if (!backgroundReady) return;
    const abort = new AbortController();
    const active = scenes.find((scene) => scene.id === preferences.activeSceneId);
    const index = scenes.findIndex((scene) => scene.id === preferences.activeSceneId);
    const upcoming = [...scenes.slice(index + 1), ...scenes.slice(0, Math.max(0, index))].slice(0, 2);
    const urls = [...(active ? [active.imageUrl] : []), ...presetImages, ...upcoming.map((scene) => scene.imageUrl)].filter((url) => hasFreshSceneToken(url));
    void preloadSceneLibrary(urls, abort.signal);
    return () => { abort.abort(); };
  }, [scenes, preferences.activeSceneId, presetImages, backgroundReady]);
  useEffect(() => {
    if (!ready) return;
    try { localStorage.setItem(cacheKey, JSON.stringify({ scenes, preferences })); } catch { /* Optional cache. */ }
  }, [cacheKey, scenes, preferences, ready]);
  function updatePreferences(value: Partial<ScenePreferences>) {
    const version = ++generation.current;
    const selection = value.activeSceneId !== undefined || value.preset !== undefined;
    if (selection) {
      cancelTiming(timingRef.current);
      timingRef.current = startTiming("scene_click_to_visible");
      setSelectionTiming(timingRef.current);
    }
    const patch = { ...value, ...(value.preset ? { activeSceneId: null } : {}), ...(value.activeSceneId ? { preset: null } : {}) };
    const next = { ...preferencesRef.current, ...patch };
    preferencesRef.current = next; setPreferences(next); setNotice(null);
    pending.current++; setBusy(true);
    // Ordered writes prevent an older PATCH from becoming the final server state.
    // Presentation is already committed, independently of the persistence queue.
    writeQueue.current = writeQueue.current.then(async () => {
      try {
        const saved = await sceneRequest<{ preferences: ScenePreferences }>("/api/scenes/preferences", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
        if (mounted.current && version === generation.current) { preferencesRef.current = saved.preferences; setPreferences(saved.preferences); }
      } catch (error) {
        if (mounted.current && version === generation.current) setNotice(`${(error as Error).message} โชว์ฉากให้บนเครื่องนี้ก่อนนะ ถ้าจะเซฟขึ้นคลาวด์ลองกดเลือกอีกทีได้เลย`);
      } finally { pending.current--; if (mounted.current && !pending.current) setBusy(false); }
    });
    return writeQueue.current;
  }
  function selectScene(id: string) {
    if (!scenesRef.current.some((item) => item.id === id)) return;
    return updatePreferences({ activeSceneId: id });
  }
  function applyChatScene(decision: SceneDecision | undefined, requestGeneration: number) {
    if (!AUTO_SCENE_ENABLED || generation.current !== requestGeneration || !preferencesRef.current.autoScene || !decision?.change) return;
    const scene = scenesRef.current.find((item) => item.id === decision.id);
    if (!scene) return;
    // Server decisions already persisted the preference; presentation stays local.
    const next = { ...preferencesRef.current, activeSceneId: scene.id, preset: null };
    preferencesRef.current = next; setPreferences(next);
  }
  return { scenes, preferences, ready, busy, notice, selectionTiming, getGeneration: () => generation.current, invalidateRequests, setNotice, refresh, selectScene, updatePreferences, applyChatScene };
}
export type SceneLibrary = ReturnType<typeof useSceneLibrary>;
