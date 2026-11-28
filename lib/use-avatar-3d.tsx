"use client";
/**
 * Self-contained React hook for the 3D Avatar stage (VRM 0.x/1.0, VRMA, FBX).
 *
 * Strictly gated by `enabled` so zero Three.js / WebGL resources are allocated
 * while the user is in Live2D mode, and all GPU/Blob resources are disposed
 * immediately when switching back to Live2D.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import {
  Avatar3DStage,
  loadLightingMode,
  saveLightingMode,
  type LightingMode,
} from "@/lib/avatar-3d-engine";
import type { AvatarEmotion } from "@/lib/avatar-emotion";
import {
  CloudModelError,
  deleteCloudModel,
  getCloudModels,
  isCloudLibraryAllowed,
  saveCloudModelExpressions,
  saveCloudModelPreference,
  type CloudLibrary,
} from "@/lib/cloud-models";
import {
  cloud3DModelPlaceholder,
  downloadCloud3DModel,
  is3DCloudModel,
  uploadCloud3DModel,
} from "@/lib/cloud-models-3d";
import {
  createModelResources,
  hydrateModelPackage,
  importModelFiles,
  loadModelCatalog,
  modelCatalogEntry,
  readModelSelection,
  removeModelPackage,
  resolveStartupModel,
  saveModelPackage,
  writeModelSelection,
  type LocalModel,
  type ModelMotion,
  type ModelPackage,
} from "@/lib/local-models-3d";
import {
  clampModelTransform,
  clearModelTransform,
  loadModelTransform,
  saveModelTransform,
  type ModelTransform,
} from "@/lib/model-position";
import { loadModelPreviews, removeModelPreview, saveModelPreview } from "@/lib/model-preview-cache";
import { preloadThreeModules } from "@/lib/model-runtime-3d";
import { SNAPSHOT_PREVIEW_PATH } from "@/lib/model-snapshot";
import { clearModelLoadState, shouldPauseModelStartup } from "@/lib/model-startup";
import { cancelTiming, finishTiming, startTiming, type LocalTiming } from "@/lib/performance";
import { desiredUploadPercent, easeDisplayed, stepSimulation } from "@/lib/upload-progress";
import { CLOUD_TIER_REQUIRED_MESSAGE, type AccountSummary } from "@/app/components/tier-panel";
import type { CoverflowCarouselItem } from "@/components/ui/smoothui/coverflow-carousel";

export interface UseAvatar3DOptions {
  enabled: boolean;
  accountId: string;
  preferencesReady: boolean;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  cloudLibrary: CloudLibrary | null;
  setCloudLibrary: Dispatch<SetStateAction<CloudLibrary | null>>;
  cloudRequestRef: RefObject<Promise<CloudLibrary | null> | null>;
  accountRef: RefObject<AccountSummary | null>;
  refreshAccount: () => Promise<void>;
}

function is3DModelVisible(pack: ModelPackage, accountId: string): boolean {
  return !pack.cloudOwner || pack.cloudOwner === accountId || pack.cloudOwner === "shared";
}

function model3DExpressionPreferenceKey(packageId: string, manifestPath: string): string {
  return `vivian-model-expressions:${packageId}:${manifestPath}`;
}

export function useAvatar3D({
  enabled,
  accountId,
  preferencesReady,
  canvasRef,
  cloudLibrary,
  setCloudLibrary,
  cloudRequestRef,
  accountRef,
  refreshAccount,
}: UseAvatar3DOptions) {
  const [modelPackages, setModelPackages] = useState<ModelPackage[]>([]);
  const [modelsReady, setModelsReady] = useState(false);
  const [modelSelectionResolved, setModelSelectionResolved] = useState(false);
  const [activeModelId, setActiveModelId] = useState<string | null>(null);
  const [pendingModelId, setPendingModelId] = useState<string | null>(null);
  const [modelStatus, setModelStatus] = useState<"loading" | "ready" | "error" | "empty">("empty");
  const [startupModelPending, setStartupModelPending] = useState(false);
  const [modelSwitchPending, setModelSwitchPending] = useState(false);
  const [modelNotice, setModelNotice] = useState<string | null>(null);
  const [modelImporting, setModelImporting] = useState(false);
  const [modelImportProgress, setModelImportProgress] = useState<{ label: string; percent: number | null } | null>(null);
  const [displayedImportPercent, setDisplayedImportPercent] = useState<number | null>(null);
  const [modelUploadKey, setModelUploadKey] = useState(0);
  const [textureQuality, setTextureQuality] = useState<"auto" | "original">("auto");
  const [lightingMode, setLightingModeState] = useState<LightingMode>("anime");
  const [modelReload, setModelReload] = useState(0);
  const [graphicsLost, setGraphicsLost] = useState(false);
  const [modelPaused, setModelPaused] = useState(false);
  const [modelPreviews, setModelPreviews] = useState<Record<string, string>>({});
  const [activeExpressions, setActiveExpressions] = useState<string[]>([]);
  const [activeExpressionsModelId, setActiveExpressionsModelId] = useState<string | null>(null);
  const [activeMotion, setActiveMotion] = useState<string | null>(null);
  const [runtimeModelMeta, setRuntimeModelMeta] = useState<{
    modelId: string;
    expressions: string[];
    motions: ModelMotion[];
  } | null>(null);

  const stageRef = useRef<Avatar3DStage | null>(null);
  const modelResourcesDisposeRef = useRef<(() => void) | null>(null);
  const modelTransformRef = useRef<ModelTransform>({ x: 0, y: 0, scale: 1 });
  const modelLoadIdRef = useRef(0);
  const modelRenderAbortRef = useRef<AbortController | null>(null);
  const modelSelectionAbortRef = useRef<AbortController | null>(null);
  const modelSelectionTimingRef = useRef<LocalTiming | undefined>(undefined);
  const startupModelResolvedRef = useRef(false);
  const activeModelIdRef = useRef<string | null>(null);
  const activeExpressionsRef = useRef<string[]>([]);
  const activeExpressionModelRef = useRef<string | null>(null);
  const pendingExpressionPreferencesRef = useRef(new Map<string, string[]>());
  const expressionSaveVersionsRef = useRef(new Map<string, number>());
  const expressionSaveQueuesRef = useRef(new Map<string, Promise<void>>());
  const motionActionRef = useRef(0);
  const modelPreviewUrlsRef = useRef(new Map<string, { path: string; url: string }>());
  const snapshotMapRef = useRef<Promise<Map<string, Blob>> | null>(null);
  const inFlightPackagesRef = useRef(new Map<string, Promise<ModelPackage | undefined>>());
  const cloudLibraryRef = useRef<CloudLibrary | null>(cloudLibrary);
  const lightingModeRef = useRef<LightingMode>(lightingMode);
  const textureQualityRef = useRef<"auto" | "original">(textureQuality);
  const importProgressRef = useRef(modelImportProgress);
  const simulatedImportRef = useRef(0);
  const displayedImportRef = useRef(0);
  const lastImportLabelRef = useRef<string | null>(null);

  useEffect(() => {
    cloudLibraryRef.current = cloudLibrary;
    lightingModeRef.current = lightingMode;
    textureQualityRef.current = textureQuality;
    activeModelIdRef.current = activeModelId;
    importProgressRef.current = modelImportProgress;
  });

  // Load persisted lighting mode on mount
  useEffect(() => {
    const saved = loadLightingMode();
    queueMicrotask(() => setLightingModeState(saved));
  }, []);

  const setLightingMode = useCallback((next: LightingMode) => {
    setLightingModeState(next);
    saveLightingMode(next);
    stageRef.current?.setLightingMode(next);
  }, []);

  useEffect(() => {
    stageRef.current?.setLightingMode(lightingMode);
  }, [lightingMode]);

  useEffect(() => {
    stageRef.current?.setQuality(textureQuality);
  }, [textureQuality]);

  const activePackage = useMemo(
    () => modelPackages.find((pack) => pack.models.some((model) => model.id === activeModelId)),
    [modelPackages, activeModelId],
  );
  const activeModel = useMemo(
    () => activePackage?.models.find((model) => model.id === activeModelId),
    [activePackage, activeModelId],
  );
  const activeExpressionsList = useMemo(
    () => (runtimeModelMeta && activeModel && runtimeModelMeta.modelId === activeModel.id
      ? runtimeModelMeta.expressions
      : activeModel?.expressions ?? []),
    [runtimeModelMeta, activeModel],
  );
  const activeMotionsList = useMemo(
    () => (runtimeModelMeta && activeModel && runtimeModelMeta.modelId === activeModel.id
      ? runtimeModelMeta.motions
      : activeModel?.motions ?? []),
    [runtimeModelMeta, activeModel],
  );

  const isBusy = enabled && (startupModelPending || modelSwitchPending || modelStatus === "loading");
  const isBusyRef = useRef(isBusy);
  useEffect(() => {
    isBusyRef.current = isBusy;
  }, [isBusy]);

  // Watchdog: never lock the UI indefinitely on a slow 3D load
  useEffect(() => {
    if (!isBusy) return;
    const timer = window.setTimeout(() => {
      if (!isBusyRef.current) return;
      setModelStatus("error");
      setStartupModelPending(false);
      setModelSwitchPending(false);
      setModelNotice((notice) => notice ?? "โมเดล 3D นี้โหลดนานนิดนึง ระหว่างนี้ทักแชตคุยกับวิเวียนไปก่อนได้เลย!");
    }, 90_000);
    return () => window.clearTimeout(timer);
  }, [isBusy]);

  // Smooth import progress bar
  useEffect(() => {
    if (!modelImporting) {
      queueMicrotask(() => setDisplayedImportPercent(null));
      displayedImportRef.current = 0;
      simulatedImportRef.current = 0;
      lastImportLabelRef.current = null;
      return;
    }
    const reduced = typeof window !== "undefined"
      && typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf: number | undefined;
    let lastTick = 0;
    let lastPaint = 0;
    let lastSet = -1;
    const tick = (now: number) => {
      if (!lastTick) lastTick = now;
      const dt = Math.min(100, now - lastTick);
      lastTick = now;
      const current = importProgressRef.current;
      if (reduced) {
        const next = current?.percent ?? null;
        if (next !== lastSet) { lastSet = next ?? -1; setDisplayedImportPercent(next); }
        raf = requestAnimationFrame(tick);
        return;
      }
      if (current && current.label !== lastImportLabelRef.current) {
        lastImportLabelRef.current = current.label;
        simulatedImportRef.current = 0;
        displayedImportRef.current = 0;
      }
      simulatedImportRef.current = stepSimulation(simulatedImportRef.current, dt);
      const desired = desiredUploadPercent(simulatedImportRef.current, current?.percent ?? null);
      displayedImportRef.current = easeDisplayed(displayedImportRef.current, desired, dt);
      if (now - lastPaint >= 80) {
        lastPaint = now;
        const rounded = Math.round(displayedImportRef.current);
        if (rounded !== lastSet) { lastSet = rounded; setDisplayedImportPercent(rounded); }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      if (raf !== undefined) cancelAnimationFrame(raf);
    };
  }, [modelImporting]);

  const cacheModelPreviews = useCallback((pack: ModelPackage) => {
    const updates: Record<string, string> = {};
    for (const model of pack.models) {
      if (!model.previewPath) continue;
      const current = modelPreviewUrlsRef.current.get(model.id);
      if (current?.path === model.previewPath) continue;
      const asset = pack.assets.find((entry) => entry.path === model.previewPath);
      if (!asset) continue;
      if (current) URL.revokeObjectURL(current.url);
      const url = URL.createObjectURL(asset.blob);
      modelPreviewUrlsRef.current.set(model.id, { path: model.previewPath, url });
      updates[model.id] = url;
    }
    if (Object.keys(updates).length) setModelPreviews((current) => ({ ...current, ...updates }));
  }, []);

  const refreshSnapshots = useCallback((packages: ModelPackage[]) => {
    snapshotMapRef.current ??= loadModelPreviews();
    void snapshotMapRef.current
      .then((blobs) => {
        const known = new Set(packages.flatMap((pack) => pack.models.map((model) => model.id)));
        const updates: Record<string, string> = {};
        for (const [modelId, blob] of blobs) {
          if (!known.has(modelId) || !blob?.size) continue;
          if (modelPreviewUrlsRef.current.has(modelId)) continue;
          const url = URL.createObjectURL(blob);
          modelPreviewUrlsRef.current.set(modelId, { path: SNAPSHOT_PREVIEW_PATH, url });
          updates[modelId] = url;
        }
        if (Object.keys(updates).length) setModelPreviews((current) => ({ ...current, ...updates }));
      })
      .catch(() => { /* Snapshots are optional. */ });
  }, []);

  const cacheSnapshotPreview = useCallback((modelId: string, blob: Blob) => {
    const current = modelPreviewUrlsRef.current.get(modelId);
    if (current && current.path !== SNAPSHOT_PREVIEW_PATH) return;
    if (current) URL.revokeObjectURL(current.url);
    const url = URL.createObjectURL(blob);
    modelPreviewUrlsRef.current.set(modelId, { path: SNAPSHOT_PREVIEW_PATH, url });
    setModelPreviews((existing) => ({ ...existing, [modelId]: url }));
    void saveModelPreview(modelId, blob).catch(() => {});
  }, []);

  const releaseModelPreviews = useCallback((packageId: string) => {
    const prefix = `${packageId}:`;
    const removed: string[] = [];
    for (const [modelId, entry] of modelPreviewUrlsRef.current.entries()) {
      if (!modelId.startsWith(prefix)) continue;
      URL.revokeObjectURL(entry.url);
      modelPreviewUrlsRef.current.delete(modelId);
      removed.push(modelId);
    }
    if (removed.length) {
      setModelPreviews((current) => {
        const next = { ...current };
        for (const modelId of removed) delete next[modelId];
        return next;
      });
    }
  }, []);

  // Release all preview Blob URLs on unmount
  useEffect(() => {
    const previewUrls = modelPreviewUrlsRef.current;
    return () => {
      for (const entry of previewUrls.values()) URL.revokeObjectURL(entry.url);
      previewUrls.clear();
    };
  }, []);

  const available3DPackage = useCallback(async (
    pack: ModelPackage,
    cloud: CloudLibrary | Promise<CloudLibrary | null> | null,
    signal?: AbortSignal,
  ): Promise<ModelPackage | undefined> => {
    signal?.throwIfAborted();
    let promise = inFlightPackagesRef.current.get(pack.id);
    if (!promise) {
      promise = hydrateModelPackage(pack, {
        recover: cloud ? async () => {
          const library = await cloud;
          const remote = library?.models.find((model) => model.id === pack.id && is3DCloudModel(model));
          if (!remote || !library) {
            throw new Error("หาไฟล์โมเดล 3D ในเครื่องไม่เจอแฮะ ลองต่อ Cloud หรือโยนไฟล์ .vrm / .fbx เข้ามาใหม่อีกรอบนะ");
          }
          const downloaded = await downloadCloud3DModel(remote, library.userId);
          await saveModelPackage(downloaded).catch(() => {});
          return downloaded;
        } : undefined,
      }).finally(() => {
        if (inFlightPackagesRef.current.get(pack.id) === promise) {
          inFlightPackagesRef.current.delete(pack.id);
        }
      });
      inFlightPackagesRef.current.set(pack.id, promise);
    }
    const hydrated = await promise;
    signal?.throwIfAborted();
    return hydrated;
  }, []);

  const intentionalSwitchRef = useRef(false);
  // Load 3D IndexedDB catalog + merge 3D cloud models ONLY when 3D mode is enabled
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const skipGuard = intentionalSwitchRef.current;
    if (skipGuard) {
      intentionalSwitchRef.current = false;
      try {
        sessionStorage.removeItem("vivian-model-loading");
        sessionStorage.removeItem("vivian-model-retry");
      } catch { /* Optional crash recovery. */ }
    }
    void preloadThreeModules().catch(() => {});
    void (async () => {
      const local = await loadModelCatalog().catch(() => [] as ModelPackage[]);
      if (cancelled) return;
      const packages = local.filter((pack) => is3DModelVisible(pack, accountId));
      const saved = localStorage.getItem("vivian-local-model-3d");
      const selection = readModelSelection(localStorage);
      let selected = resolveStartupModel(packages, saved, selection);
      const restoreStartup = (targetId: string | null): boolean => {
        let paused = false;
        if (skipGuard) return false;
        try {
          if (shouldPauseModelStartup(sessionStorage, targetId)) {
            paused = true;
            setModelPaused(true);
            setModelStatus("error");
            setModelNotice("โมเดล 3D โหลดสะดุดไปสองรอบอะ กด 'โหลดโมเดลอีกรอบ' เพื่อใช้โหมดอัตโนมัติดูนะ");
          }
        } catch { /* Storage restrictions do not block chat. */ }
        return paused;
      };
      const startupPaused = restoreStartup(selected);
      if (startupPaused) { startupModelResolvedRef.current = true; setStartupModelPending(false); }
      setModelPackages(packages);
      refreshSnapshots(packages);
      setActiveModelId(selected);
      if (selected && !startupModelResolvedRef.current) setStartupModelPending(true);
      setModelSelectionResolved(false);
      if (selected) setModelsReady(true);

      const cloud = cloudLibraryRef.current ?? (await (cloudRequestRef.current ?? Promise.resolve(null)));
      if (cancelled) return;
      if (!cloud) {
        setModelSelectionResolved(true);
        setModelsReady(true);
        return;
      }
      const cloud3DModels = cloud.models.filter(is3DCloudModel);
      const cloud3DIds = new Set(cloud3DModels.map((model) => model.id));
      const sharedIds = new Set(cloud3DModels.filter((model) => model.scope === "shared").map((model) => model.id));
      const cloudPlaceholders = cloud3DModels
        .map(cloud3DModelPlaceholder)
        .filter((entry): entry is ModelPackage => entry !== null);

      setModelPackages((current) => {
        const merged = current
          .filter((pack) => !pack.cloudOwner || cloud3DIds.has(pack.id))
          .map((pack) => (sharedIds.has(pack.id) && pack.cloudOwner !== "shared" ? { ...pack, cloudOwner: "shared" } : pack));
        for (const pack of local.filter((entry) => sharedIds.has(entry.id))) {
          if (!merged.some((entry) => entry.id === pack.id)) merged.push({ ...pack, cloudOwner: "shared" });
        }
        for (const placeholder of cloudPlaceholders) {
          if (!merged.some((pack) => pack.id === placeholder.id)) merged.push(placeholder);
        }
        return merged;
      });

      const sharedCaches = local
        .filter((pack) => sharedIds.has(pack.id))
        .map((pack) => ({ ...pack, cloudOwner: "shared" }));
      const reconciledPackages = packages.filter((pack) => pack.cloudOwner !== "shared" || sharedIds.has(pack.id));
      const allPackages = [
        ...reconciledPackages,
        ...sharedCaches.filter((pack) => !reconciledPackages.some((localPack) => localPack.id === pack.id)),
        ...cloudPlaceholders.filter((pack) => !local.some((localPack) => localPack.id === pack.id)),
      ];
      const globalSelection = cloud.preference?.modelId;
      selected = globalSelection && allPackages.some((pack) => pack.models.some((model) => model.id === globalSelection))
        ? globalSelection
        : resolveStartupModel(allPackages, saved, selection);
      const cloudStartupPaused = restoreStartup(selected);
      if (cloudStartupPaused) { startupModelResolvedRef.current = true; setStartupModelPending(false); }
      setActiveModelId(selected);
      if (selected && !startupModelResolvedRef.current) setStartupModelPending(true);
      setModelSelectionResolved(true);
      refreshSnapshots(allPackages);
    })()
      .catch(() => {
        if (!cancelled) setModelNotice("เข้าคลังโมเดล 3D ในเครื่องไม่ได้แฮะ ลองรีเฟรชอีกทีนะ");
      })
      .finally(() => {
        if (!cancelled) {
          setModelSelectionResolved(true);
          setModelsReady(true);
        }
      });
    return () => { cancelled = true; };
  }, [enabled, accountId, cloudRequestRef, refreshSnapshots]);

  // Keep 3D packages in sync when cloudLibrary refreshes
  useEffect(() => {
    if (!enabled || !cloudLibrary || cloudLibrary.cloudAllowed === false) return;
    const cloud3DModels = cloudLibrary.models.filter(is3DCloudModel);
    const cloud3DIds = new Set(cloud3DModels.map((model) => model.id));
    const sharedIds = new Set(cloud3DModels.filter((model) => model.scope === "shared").map((model) => model.id));
    const placeholders = cloud3DModels
      .map(cloud3DModelPlaceholder)
      .filter((entry): entry is ModelPackage => entry !== null);
    setModelPackages((current) => {
      const merged = current
        .filter((pack) => !pack.cloudOwner || pack.models.some((model) => model.id === activeModelIdRef.current) || cloud3DIds.has(pack.id))
        .map((pack) => (sharedIds.has(pack.id) && pack.cloudOwner !== "shared" && !pack.models.some((model) => model.id === activeModelIdRef.current)
          ? { ...pack, cloudOwner: "shared" }
          : pack));
      for (const placeholder of placeholders) {
        if (!merged.some((pack) => pack.id === placeholder.id)) merged.push(placeholder);
      }
      return merged;
    });
    if (placeholders.length) refreshSnapshots(placeholders);
  }, [enabled, cloudLibrary, refreshSnapshots]);

  useEffect(() => {
    if (!enabled || !modelsReady || !modelSelectionResolved) return;
    if (activeModelId) writeModelSelection(localStorage, activeModelId);
    else localStorage.removeItem("vivian-local-model-3d");
  }, [enabled, modelsReady, modelSelectionResolved, activeModelId]);

  useEffect(() => {
    if (pendingModelId && pendingModelId === activeModelId) {
      queueMicrotask(() => setPendingModelId(null));
    }
  }, [activeModelId, pendingModelId]);

  // Dispose Three.js stage completely whenever 3D mode turns OFF or unmounts
  useEffect(() => {
    if (enabled) return;
    modelSelectionAbortRef.current?.abort();
    modelRenderAbortRef.current?.abort();
    cancelTiming(modelSelectionTimingRef.current);
    modelResourcesDisposeRef.current?.();
    modelResourcesDisposeRef.current = null;
    stageRef.current?.dispose();
    stageRef.current = null;
    startupModelResolvedRef.current = false;
    intentionalSwitchRef.current = true;
    // An intentional mode switch is not a GPU crash: reset the crash-loop guard.
    try {
      sessionStorage.removeItem("vivian-model-loading");
      sessionStorage.removeItem("vivian-model-retry");
    } catch { /* Optional crash recovery. */ }
    queueMicrotask(() => {
      setStartupModelPending(false);
      setModelSwitchPending(false);
      setModelStatus("empty");
      setActiveMotion(null);
    });
  }, [enabled]);

  useEffect(() => () => {
    modelSelectionAbortRef.current?.abort();
    modelRenderAbortRef.current?.abort();
    cancelTiming(modelSelectionTimingRef.current);
    modelResourcesDisposeRef.current?.();
    modelResourcesDisposeRef.current = null;
    stageRef.current?.dispose();
    stageRef.current = null;
  }, []);

  // Main 3D stage render & model load effect (active ONLY when enabled === true)
  useEffect(() => {
    if (!enabled || !preferencesReady || !modelsReady || graphicsLost || modelPaused) return;
    if (!activeModel || !activePackage) {
      stageRef.current?.unloadAvatar();
      modelResourcesDisposeRef.current?.();
      modelResourcesDisposeRef.current = null;
      startupModelResolvedRef.current = true;
      queueMicrotask(() => {
        setActiveMotion(null);
        setRuntimeModelMeta(null);
        setModelStatus("empty");
        setModelSwitchPending(false);
        setStartupModelPending(false);
      });
      return;
    }

    modelTransformRef.current = loadModelTransform(activeModel.id);
    const renderAbort = new AbortController();
    modelRenderAbortRef.current = renderAbort;
    queueMicrotask(() => {
      if (renderAbort.signal.aborted) return;
      setActiveMotion(null);
      setModelStatus("loading");
    });
    let releaseResources: (() => void) | undefined;
    let resizeModel = () => {};
    let queueResize = () => {};
    let handleOrientationChange = () => {};
    let resizeFrame: number | undefined;
    let resizeTimeout: number | undefined;
    let disposed = false;
    let promoted = false;
    let renderTiming: LocalTiming | undefined;
    const loadId = ++modelLoadIdRef.current;

    const clearBreadcrumb = () => {
      if (loadId !== modelLoadIdRef.current) return;
      try { clearModelLoadState(sessionStorage, activeModel.id); } catch { /* Optional crash recovery. */ }
    };
    const clearRecovery = () => {
      if (loadId !== modelLoadIdRef.current) return;
      try { clearModelLoadState(sessionStorage, activeModel.id, true); } catch { /* Optional crash recovery. */ }
    };
    window.addEventListener("pagehide", clearRecovery);
    try { sessionStorage.setItem("vivian-model-loading", activeModel.id); } catch { /* Optional crash recovery. */ }

    void (async () => {
      try {
        const hydrationPromise = available3DPackage(activePackage, cloudLibraryRef.current ?? cloudRequestRef.current, renderAbort.signal);
        const [modules, renderPackage] = await Promise.all([
          preloadThreeModules(),
          hydrationPromise,
        ]);
        renderAbort.signal.throwIfAborted();
        if (!canvasRef.current || disposed) return;

        let stage = stageRef.current;
        if (!stage) {
          stage = new Avatar3DStage(canvasRef.current, modules, {
            lightingMode: lightingModeRef.current,
            quality: textureQualityRef.current,
          });
          stageRef.current = stage;
        }
        canvasRef.current.dataset.gpuTextureLimit = String(stage.getMaxTextureSize());

        if (!renderPackage) {
          throw new Error("หาไฟล์โมเดล 3D ในเครื่องไม่เจอแฮะ ลองโหลดจาก Cloud หรือเอาไฟล์ .vrm / .fbx เข้ามาใหม่อีกรอบนะ");
        }
        cacheModelPreviews(renderPackage);
        if (renderPackage !== activePackage) {
          setModelPackages((current) => current.map((entry) => (entry.id === renderPackage.id ? renderPackage : entry)));
          setModelNotice(null);
          return;
        }
        const renderModel = renderPackage.models.find(
          (entry) => entry.id === activeModel.id || entry.manifestPath === activeModel.manifestPath,
        );
        if (!renderModel) throw new Error("ตัวที่เลือกไว้เมื่อกี้เปลี่ยนไปแล้วอะ ลองจิ้มโมเดลใหม่อีกทีนะ");

        renderTiming = startTiming("model_load_to_first_frame");
        const resources = await createModelResources(renderPackage, renderModel);
        releaseResources = () => { resources.dispose(); };
        if (disposed || loadId !== modelLoadIdRef.current) { releaseResources(); return; }

        resizeModel = () => {
          const rect = canvasRef.current?.parentElement?.getBoundingClientRect();
          if (!rect || !rect.width || !rect.height) return;
          stage.resize(rect.width, rect.height);
          modelTransformRef.current = clampModelTransform(modelTransformRef.current, rect.width, rect.height);
          stage.setTransform(modelTransformRef.current);
        };
        resizeModel();

        const runtimeInfo = await stage.loadModel(resources, renderAbort.signal);
        if (disposed || loadId !== modelLoadIdRef.current) { releaseResources(); return; }
        if (stage.isContextLost()) {
          throw new Error("หน่วยความจำภาพของเครื่องเต็มอะ ลองเปลี่ยนความชัดเป็น 'อัตโนมัติ' แล้วโหลดโมเดลใหม่ดูนะ");
        }

        const discoveredExpressions = runtimeInfo.expressions.length ? runtimeInfo.expressions : renderModel.expressions;
        const discoveredMotions = runtimeInfo.motions.length ? runtimeInfo.motions : renderModel.motions;
        if (canvasRef.current) {
          if (typeof runtimeInfo.vertexCount === "number") canvasRef.current.dataset.avatarVertices = String(runtimeInfo.vertexCount);
          if (typeof runtimeInfo.drawCalls === "number") canvasRef.current.dataset.avatarDrawCalls = String(runtimeInfo.drawCalls);
        }
        setRuntimeModelMeta({ modelId: renderModel.id, expressions: discoveredExpressions, motions: discoveredMotions });

        const preferenceKey = model3DExpressionPreferenceKey(renderPackage.id, renderModel.manifestPath);
        const pendingExpressions = pendingExpressionPreferencesRef.current.get(preferenceKey);
        const cloudModel = cloudLibraryRef.current?.models.find((entry) => entry.id === renderPackage.id);
        const cloudHasPreference = Boolean(
          cloudModel?.expressionPreferences
          && Object.prototype.hasOwnProperty.call(cloudModel.expressionPreferences, renderModel.manifestPath),
        );
        let savedExpressions = pendingExpressions
          ?? (cloudHasPreference ? cloudModel!.expressionPreferences![renderModel.manifestPath] : undefined);
        if (!savedExpressions) {
          try {
            const cached = JSON.parse(localStorage.getItem(preferenceKey) ?? "null");
            if (Array.isArray(cached) && cached.every((name) => typeof name === "string")) savedExpressions = cached;
          } catch { /* Optional local preference cache. */ }
        }
        const selectedExpressions = [...new Set((savedExpressions ?? []).filter((name) => discoveredExpressions.includes(name)))];
        activeExpressionsRef.current = selectedExpressions;
        activeExpressionModelRef.current = renderModel.id;
        setActiveExpressions(selectedExpressions);
        setActiveExpressionsModelId(renderModel.id);
        stage.setSavedExpressions(selectedExpressions);

        const previousDispose = modelResourcesDisposeRef.current;
        modelResourcesDisposeRef.current = releaseResources;
        promoted = true;
        previousDispose?.();

        queueResize = () => {
          if (resizeFrame) cancelAnimationFrame(resizeFrame);
          if (resizeTimeout) window.clearTimeout(resizeTimeout);
          resizeFrame = requestAnimationFrame(() => requestAnimationFrame(resizeModel));
          resizeTimeout = window.setTimeout(resizeModel, 240);
        };
        handleOrientationChange = () => { queueResize(); };
        resizeModel();

        finishTiming(renderTiming);
        finishTiming(modelSelectionTimingRef.current);
        window.dispatchEvent(new Event("vivian-model-first-frame"));
        setModelStatus("ready");
        setModelSwitchPending(false);
        startupModelResolvedRef.current = true;
        setStartupModelPending(false);
        clearRecovery();

        if (!renderModel.previewPath) {
          void (async () => {
            try {
              const blob = await stage.captureFaceSnapshot();
              if (!blob || disposed || loadId !== modelLoadIdRef.current) return;
              cacheSnapshotPreview(renderModel.id, blob);
            } catch { /* Card keeps its fallback label. */ }
          })();
        }

        window.addEventListener("resize", queueResize);
        window.addEventListener("orientationchange", handleOrientationChange);
        window.visualViewport?.addEventListener("resize", queueResize);
      } catch (error) {
        clearRecovery();
        cancelTiming(renderTiming);
        const aborted = renderAbort.signal.aborted || (error instanceof DOMException && error.name === "AbortError");
        if (!disposed && loadId === modelLoadIdRef.current) cancelTiming(modelSelectionTimingRef.current);
        if (!aborted && !disposed && loadId === modelLoadIdRef.current) {
          console.error("3D avatar failed to load", error);
          setModelStatus("error");
          startupModelResolvedRef.current = true;
          setStartupModelPending(false);
          setModelSwitchPending(false);
          setModelNotice(
            error instanceof Error
              ? error.message
              : "เปิดโมเดล 3D นี้ไม่ขึ้นแฮะ ลองเช็กดูนะว่าเป็นไฟล์ .vrm หรือ .fbx ที่สมบูรณ์หรือเปล่า",
          );
        }
        if (!promoted) releaseResources?.();
      }
    })();

    return () => {
      disposed = true;
      renderAbort.abort();
      if (modelRenderAbortRef.current === renderAbort) modelRenderAbortRef.current = null;
      clearBreadcrumb();
      modelLoadIdRef.current += 1;
      window.removeEventListener("pagehide", clearRecovery);
      if (resizeFrame) cancelAnimationFrame(resizeFrame);
      if (resizeTimeout) window.clearTimeout(resizeTimeout);
      window.removeEventListener("resize", queueResize);
      window.removeEventListener("orientationchange", handleOrientationChange);
      window.visualViewport?.removeEventListener("resize", queueResize);
      cancelTiming(renderTiming);
      if (!promoted) releaseResources?.();
    };
  }, [
    enabled,
    preferencesReady,
    modelsReady,
    activeModel,
    activePackage,
    cloudLibrary,
    modelReload,
    graphicsLost,
    modelPaused,
    available3DPackage,
    cacheModelPreviews,
    cacheSnapshotPreview,
    canvasRef,
    cloudRequestRef,
  ]);

  // WebGL context lost / restored for 3D canvas
  useEffect(() => {
    if (!enabled) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const lost = (event: Event) => {
      event.preventDefault();
      stageRef.current?.pause();
      setGraphicsLost(true);
      setModelStatus("error");
      setModelNotice("ระบบภาพ 3D ของเครื่องสะดุดไปแป๊บ เดี๋ยวพอหายแล้ววิเวียนโหลดโมเดลให้ใหม่นะ");
    };
    const restored = () => {
      stageRef.current?.start();
      setGraphicsLost(false);
      setModelNotice(null);
      setModelReload((value) => value + 1);
    };
    canvas.addEventListener("webglcontextlost", lost);
    canvas.addEventListener("webglcontextrestored", restored);
    return () => {
      canvas.removeEventListener("webglcontextlost", lost);
      canvas.removeEventListener("webglcontextrestored", restored);
    };
  }, [enabled, canvasRef]);

  // Move + pinch/wheel zoom + double-tap reset + pointer look-at ONLY (no user 3D orbit)
  useEffect(() => {
    if (!enabled) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const pointers = new Map<number, { x: number; y: number }>();
    let dragStart: { pointerId: number; x: number; y: number; offsetX: number; offsetY: number } | null = null;
    let dragMoved = 0;
    let pinchStart: { distance: number; midX: number; midY: number; scale: number; offsetX: number; offsetY: number } | null = null;
    let lastTapAt = 0;
    let dragging = false;
    let wheelPersistTimer: number | undefined;

    const setCursor = () => {
      canvas.style.cursor = dragging ? "grabbing" : "grab";
    };
    const stageSize = () => {
      const rect = canvas.parentElement?.getBoundingClientRect();
      return { width: Math.max(0, rect?.width ?? 0), height: Math.max(0, rect?.height ?? 0) };
    };
    const apply = () => {
      const stage = stageRef.current;
      if (!stage || !stage.hasAvatar()) return;
      const { width, height } = stageSize();
      if (!width || !height) return;
      modelTransformRef.current = clampModelTransform(modelTransformRef.current, width, height);
      stage.setTransform(modelTransformRef.current);
    };
    const persist = () => {
      const activeId = activeModelIdRef.current;
      if (!activeId) return;
      saveModelTransform(activeId, { ...modelTransformRef.current });
    };
    const reset = () => {
      modelTransformRef.current = { x: 0, y: 0, scale: 1 };
      apply();
      persist();
    };
    const onWindowPointerMove = (event: PointerEvent) => {
      const stage = stageRef.current;
      if (!stage || !stage.hasAvatar()) return;
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const nx = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      const ny = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
      stage.setPointerLookTarget(nx, ny);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!stageRef.current?.hasAvatar()) return;
      try { canvas.setPointerCapture(event.pointerId); } catch { /* Best-effort capture. */ }
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.size === 1) {
        dragStart = {
          pointerId: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          offsetX: modelTransformRef.current.x,
          offsetY: modelTransformRef.current.y,
        };
        dragMoved = 0;
        pinchStart = null;
        dragging = true;
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinchStart = {
          distance: Math.hypot(a.x - b.x, a.y - b.y) || 1,
          midX: (a.x + b.x) / 2,
          midY: (a.y + b.y) / 2,
          scale: modelTransformRef.current.scale,
          offsetX: modelTransformRef.current.x,
          offsetY: modelTransformRef.current.y,
        };
        dragStart = null;
        dragging = true;
      }
      setCursor();
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!stageRef.current?.hasAvatar() || !pointers.has(event.pointerId)) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pinchStart && pointers.size >= 2) {
        const [a, b] = [...pointers.values()].slice(0, 2);
        const distance = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        const midX = (a.x + b.x) / 2;
        const midY = (a.y + b.y) / 2;
        modelTransformRef.current.scale = pinchStart.scale * (distance / pinchStart.distance);
        modelTransformRef.current.x = pinchStart.offsetX + (midX - pinchStart.midX);
        modelTransformRef.current.y = pinchStart.offsetY + (midY - pinchStart.midY);
        const { width, height } = stageSize();
        modelTransformRef.current = clampModelTransform(modelTransformRef.current, width, height);
        apply();
        return;
      }
      if (dragStart && dragStart.pointerId === event.pointerId) {
        dragMoved = Math.max(dragMoved, Math.hypot(event.clientX - dragStart.x, event.clientY - dragStart.y));
        modelTransformRef.current.x = dragStart.offsetX + (event.clientX - dragStart.x);
        modelTransformRef.current.y = dragStart.offsetY + (event.clientY - dragStart.y);
        const { width, height } = stageSize();
        modelTransformRef.current = clampModelTransform(modelTransformRef.current, width, height);
        apply();
      }
    };
    const onPointerUp = (event: PointerEvent) => {
      const wasDrag = dragStart !== null || pinchStart !== null;
      const hadPointers = pointers.has(event.pointerId);
      pointers.delete(event.pointerId);
      try { canvas.releasePointerCapture?.(event.pointerId); } catch { /* Already released. */ }
      if (pointers.size === 0) {
        if (wasDrag) persist();
        if (hadPointers && dragMoved < 8 && !pinchStart) {
          const now = Date.now();
          if (now - lastTapAt < 350) reset();
          lastTapAt = now;
        }
        dragStart = null;
        pinchStart = null;
        dragging = false;
      } else if (pointers.size === 1) {
        const [id, pos] = [...pointers.entries()][0];
        dragStart = {
          pointerId: id,
          x: pos.x,
          y: pos.y,
          offsetX: modelTransformRef.current.x,
          offsetY: modelTransformRef.current.y,
        };
        dragMoved = 0;
        pinchStart = null;
      }
      setCursor();
    };
    const onDoubleClick = (event: MouseEvent) => {
      event.preventDefault();
      reset();
    };
    const onWheel = (event: WheelEvent) => {
      if (!stageRef.current?.hasAvatar()) return;
      event.preventDefault();
      const zoom = Math.exp(-event.deltaY * 0.0012 * (event.ctrlKey || event.metaKey ? 1.6 : 1));
      modelTransformRef.current.scale *= zoom;
      const { width, height } = stageSize();
      modelTransformRef.current = clampModelTransform(modelTransformRef.current, width, height);
      apply();
      if (wheelPersistTimer !== undefined) window.clearTimeout(wheelPersistTimer);
      wheelPersistTimer = window.setTimeout(persist, 200);
    };

    canvas.style.cursor = "grab";
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    canvas.addEventListener("dblclick", onDoubleClick);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("pointermove", onWindowPointerMove, { passive: true });
    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("dblclick", onDoubleClick);
      canvas.removeEventListener("wheel", onWheel);
      window.removeEventListener("pointermove", onWindowPointerMove);
      canvas.style.cursor = "";
      pointers.clear();
      if (wheelPersistTimer !== undefined) window.clearTimeout(wheelPersistTimer);
    };
  }, [enabled, canvasRef]);

  const syncModelToCloud = useCallback(async (pack: ModelPackage, originalZip?: File) => {
    const saved = await uploadCloud3DModel(pack, (message) => {
      const match = /(\d{1,3})%/.exec(message);
      setModelImportProgress({
        label: message.replace(/\s*\d{1,3}%\s*$/, "").trim(),
        percent: match ? Math.min(100, Number(match[1])) : null,
      });
    }, originalZip);
    await saveModelPackage(saved.pack).catch(() => {});
    setModelPackages((current) => current.map((entry) => (entry.id === pack.id ? saved.pack : entry)));
    const selectedId = saved.pack.models.find((model) => model.manifestPath === activeModel?.manifestPath)?.id ?? saved.pack.models[0].id;
    setActiveModelId(selectedId);
    void saveCloudModelPreference(selectedId).catch(() => {});
    setCloudLibrary((current) => (current ? {
      ...current,
      usage: saved.usage ?? current.usage,
      personalUsage: saved.personalUsage ?? current.personalUsage,
      models: [
        ...current.models,
        {
          id: saved.pack.id,
          byteSize: saved.byteSize,
          scope: saved.scope,
          manifests: saved.pack.models.map((model) => ({ path: model.manifestPath, name: model.name })),
        },
      ],
    } : current));
    await removeModelPackage(pack.id).catch(() => {});
    void refreshAccount();
    setModelNotice("เซฟโมเดล 3D ขึ้น Cloud ส่วนตัวให้เรียบร้อย จึ้ง!");
  }, [activeModel?.manifestPath, refreshAccount, setCloudLibrary]);

  const importModels = useCallback(async (files: File[]) => {
    if (modelImporting || !files.length) return;
    startupModelResolvedRef.current = true;
    setStartupModelPending(false);
    setModelImporting(true);
    setModelImportProgress({ label: "กำลังเตรียมไฟล์โมเดล 3D แป๊บ…", percent: null });
    const wasPaused = modelPaused;
    setModelPaused(true);
    setModelNotice(null);
    try {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const importingZip = files.length === 1 && /\.zip$/i.test(files[0].name);
      setModelImportProgress(
        importingZip
          ? { label: "กำลังแตกไฟล์โมเดล 3D…", percent: 0 }
          : { label: "กำลังเช็กไฟล์โมเดล 3D ให้…", percent: null },
      );
      let reportedExtraction = -1;
      const pack = await importModelFiles(
        files,
        importingZip
          ? (ratio) => {
            const percent = Math.min(99, Math.round(Math.max(0, Math.min(1, ratio)) * 100));
            if (percent <= reportedExtraction) return;
            reportedExtraction = percent;
            setModelImportProgress({ label: "กำลังแตกไฟล์โมเดล 3D…", percent });
          }
          : undefined,
      );
      setModelImportProgress({ label: "กำลังเซฟโมเดล 3D ลงเครื่องนี้…", percent: null });
      await saveModelPackage(pack);
      setModelPackages((current) => [...current.map(modelCatalogEntry), pack]);
      setActiveModelId(pack.models[0].id);
      void navigator.storage?.persist?.().catch(() => {});
      if (isCloudLibraryAllowed(cloudLibraryRef.current) && accountRef.current?.capabilities.canUseCloudModels !== false) {
        setModelImportProgress({ label: "กำลังเตรียมอัปขึ้น Cloud ส่วนตัว…", percent: null });
        await syncModelToCloud(pack, importingZip ? files[0] : undefined);
      }
    } catch (error) {
      if (error instanceof CloudModelError && error.code === "STORAGE_QUOTA_EXCEEDED") {
        setModelNotice("เซฟลงเครื่องนี้ให้แล้วนะ แต่พื้นที่ Cloud R2 ส่วนตัวเต็ม 512 MB แล้วอะ ลบอันเก่าออกก่อนค่อยอัปเพิ่มน้า");
      } else if (error instanceof CloudModelError && error.code === "TIER_REQUIRED") {
        setModelNotice(CLOUD_TIER_REQUIRED_MESSAGE);
      } else {
        setModelNotice(error instanceof Error ? error.message : "เอาโมเดล 3D นี้เข้าไม่สำเร็จแฮะ ลองเช็กไฟล์อีกทีนะ");
      }
    } finally {
      setModelImporting(false);
      setModelImportProgress(null);
      setModelPaused(wasPaused);
    }
  }, [accountRef, modelImporting, modelPaused, syncModelToCloud]);

  const saveActiveModelToCloud = useCallback(async () => {
    if (!activePackage || modelImporting || !isCloudLibraryAllowed(cloudLibraryRef.current) || accountRef.current?.capabilities.canUseCloudModels === false) return;
    setModelImporting(true);
    setModelImportProgress({ label: "กำลังเตรียมอัปขึ้น Cloud ส่วนตัว…", percent: null });
    try {
      await syncModelToCloud(activePackage);
    } catch (error) {
      if (error instanceof CloudModelError && error.code === "TIER_REQUIRED") {
        setModelNotice(CLOUD_TIER_REQUIRED_MESSAGE);
      } else {
        setModelNotice(error instanceof Error ? error.message : "อัปโมเดล 3D ขึ้น Cloud ไม่ติดแฮะ ลองใหม่อีกรอบนะ");
      }
    } finally {
      setModelImporting(false);
      setModelImportProgress(null);
    }
  }, [accountRef, activePackage, modelImporting, syncModelToCloud]);

  const chooseModel = useCallback(async (id: string) => {
    if (modelImporting) return;
    startupModelResolvedRef.current = true;
    setStartupModelPending(false);
    const pack = modelPackages.find((entry) => entry.models.some((model) => model.id === id));
    if (!pack) return;
    setModelSwitchPending(true);
    modelSelectionAbortRef.current?.abort();
    const abort = new AbortController();
    modelSelectionAbortRef.current = abort;
    cancelTiming(modelSelectionTimingRef.current);
    modelSelectionTimingRef.current = startTiming("model_select_to_first_frame");
    modelLoadIdRef.current++;
    modelRenderAbortRef.current?.abort();
    setModelNotice("กำลังโหลดไฟล์โมเดล 3D…");
    try {
      const downloaded = await available3DPackage(pack, cloudLibraryRef.current ?? cloudRequestRef.current, abort.signal);
      abort.signal.throwIfAborted();
      if (!downloaded) throw new Error("หาไฟล์โมเดล 3D ไม่เจอแฮะ");
      if (!downloaded.models.some((model) => model.id === id)) throw new Error("โมเดล 3D นี้ไม่มีอยู่ในชุดไฟล์แล้วอะ ลองจิ้มตัวอื่นดูนะ");
      cacheModelPreviews(downloaded);
      setModelPackages((current) => current.map((entry) => (entry.id === pack.id ? downloaded : modelCatalogEntry(entry))));
      setActiveModelId(id);
      writeModelSelection(localStorage, id);
      if (cloudLibraryRef.current?.cloudAllowed !== false && cloudLibraryRef.current?.models.some((model) => model.id === pack.id)) {
        void saveCloudModelPreference(id).catch(() => {});
      }
      setModelNotice(null);
      setModelPaused(false);
      setModelReload((value) => value + 1);
    } catch (error) {
      if (abort.signal.aborted) return;
      setPendingModelId(null);
      setModelSwitchPending(false);
      cancelTiming(modelSelectionTimingRef.current);
      setModelStatus(stageRef.current?.hasAvatar() ? "ready" : "error");
      setModelNotice(error instanceof Error ? error.message : "โหลดโมเดล 3D ไม่ขึ้นแฮะ");
    } finally {
      if (modelSelectionAbortRef.current === abort) modelSelectionAbortRef.current = null;
    }
  }, [available3DPackage, cacheModelPreviews, cloudRequestRef, modelImporting, modelPackages]);

  const removeActiveModel = useCallback(async () => {
    if (!activePackage || modelImporting) return;
    setModelImporting(true);
    try {
      if (cloudLibraryRef.current?.cloudAllowed !== false && cloudLibraryRef.current?.models.some((model) => model.id === activePackage.id)) {
        await deleteCloudModel(activePackage.id);
        setCloudLibrary((current) => (current ? { ...current, models: current.models.filter((model) => model.id !== activePackage.id) } : current));
        void getCloudModels().then(setCloudLibrary).catch(() => {});
        void refreshAccount();
      }
      await removeModelPackage(activePackage.id);
      releaseModelPreviews(activePackage.id);
      for (const model of activePackage.models) clearModelTransform(model.id);
      void Promise.all(activePackage.models.map((model) => removeModelPreview(model.id))).catch(() => {});
      const remaining = modelPackages.filter((pack) => pack.id !== activePackage.id);
      setModelPackages(remaining);
      setActiveModelId(remaining[0]?.models[0]?.id ?? null);
      setModelNotice(null);
    } catch {
      setModelNotice("ลบโมเดล 3D ยังไม่สำเร็จ ลองกดอีกทีนะ");
    } finally {
      setModelImporting(false);
    }
  }, [activePackage, modelImporting, modelPackages, refreshAccount, releaseModelPreviews, setCloudLibrary]);

  const resetModelTransform = useCallback(() => {
    const activeId = activeModelIdRef.current;
    if (!activeId) return;
    modelTransformRef.current = { x: 0, y: 0, scale: 1 };
    saveModelTransform(activeId, { ...modelTransformRef.current });
    stageRef.current?.setTransform(modelTransformRef.current);
  }, []);

  const reloadActiveModel = useCallback(async () => {
    if (!activeModel) return;
    setModelNotice(null);
    if (modelPaused) {
      setTextureQuality("auto");
      await chooseModel(activeModel.id);
    }
    setModelPaused(false);
    setModelReload((value) => value + 1);
  }, [activeModel, chooseModel, modelPaused]);

  const saveExpressionSelection = useCallback((next: string[]) => {
    if (!activeModel || !activePackage) return;
    const key = model3DExpressionPreferenceKey(activePackage.id, activeModel.manifestPath);
    activeExpressionModelRef.current = activeModel.id;
    activeExpressionsRef.current = next;
    setActiveExpressionsModelId(activeModel.id);
    pendingExpressionPreferencesRef.current.set(key, next);
    setActiveExpressions(next);
    setModelNotice(null);
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* Optional cache. */ }
    stageRef.current?.setSavedExpressions(next);

    if (!cloudLibraryRef.current || cloudLibraryRef.current.cloudAllowed === false || !cloudLibraryRef.current.models.some((model) => model.id === activePackage.id)) return;
    const saveVersion = (expressionSaveVersionsRef.current.get(key) ?? 0) + 1;
    expressionSaveVersionsRef.current.set(key, saveVersion);
    const previousSave = expressionSaveQueuesRef.current.get(key) ?? Promise.resolve();
    const request = previousSave.catch(() => {}).then(() => saveCloudModelExpressions(activePackage.id, activeModel.manifestPath, next));
    expressionSaveQueuesRef.current.set(key, request.then(() => {}, () => {}));
    void request.then((result) => {
      if (expressionSaveVersionsRef.current.get(key) !== saveVersion) return;
      pendingExpressionPreferencesRef.current.set(key, result.expressions);
      const currentLibrary = cloudLibraryRef.current;
      if (!currentLibrary) return;
      const updated: CloudLibrary = {
        ...currentLibrary,
        models: currentLibrary.models.map((model) => (model.id === activePackage.id
          ? { ...model, expressionPreferences: { ...model.expressionPreferences, [activeModel.manifestPath]: result.expressions } }
          : model)),
      };
      cloudLibraryRef.current = updated;
      setCloudLibrary(updated);
    }).catch(() => {
      if (expressionSaveVersionsRef.current.get(key) === saveVersion) {
        setModelNotice("เซฟสีหน้าไว้ในเครื่องนี้ให้ละ แต่ยังซิงก์ขึ้นคลาวด์ไม่ติดนะ");
      }
    });
  }, [activeModel, activePackage, setCloudLibrary]);

  const toggleSavedExpression = useCallback((expression: string) => {
    if (!activeModel || !activePackage || !activeExpressionsList.includes(expression)) return;
    const current = activeExpressionModelRef.current === activeModel.id ? activeExpressionsRef.current : [];
    const next = current.includes(expression) ? current.filter((item) => item !== expression) : [...current, expression];
    if (next.length > 128) { setModelNotice("เลือกผสมสีหน้าได้สูงสุด 128 อันต่อโมเดลนะเธอ"); return; }
    saveExpressionSelection(next);
  }, [activeExpressionsList, activeModel, activePackage, saveExpressionSelection]);

  const clearSavedExpressions = useCallback(() => {
    const selected = activeExpressionModelRef.current === activeModel?.id ? activeExpressionsRef.current : [];
    if (!selected.length) {
      stageRef.current?.clearReaction();
      return;
    }
    saveExpressionSelection([]);
  }, [activeModel?.id, saveExpressionSelection]);

  const selectMotion = useCallback(async (motion: ModelMotion | null) => {
    const actionId = ++motionActionRef.current;
    const loadId = modelLoadIdRef.current;
    try {
      const stage = stageRef.current;
      if (!stage || !stage.hasAvatar()) return;
      setModelNotice(null);
      setActiveMotion(motion ? `${motion.group}:${motion.index}` : null);
      const started = stage.playMotion(motion);
      if (actionId !== motionActionRef.current || loadId !== modelLoadIdRef.current) return;
      if (!started) throw new Error("Motion unavailable");
    } catch {
      if (actionId === motionActionRef.current && loadId === modelLoadIdRef.current) {
        setActiveMotion(null);
        setModelNotice("ท่าทางนี้เล่นไม่ได้แฮะ");
      }
    }
  }, []);

  const setMouthOpen = useCallback((value: number) => {
    stageRef.current?.setMouthOpen(value);
  }, []);

  const playEmotionReaction = useCallback((emotion: AvatarEmotion, intensity: number) => {
    const stage = stageRef.current;
    if (!stage || !stage.hasAvatar()) return { expression: null as string | null };
    return stage.playEmotionReaction(emotion, intensity);
  }, []);

  const clearReaction = useCallback(() => {
    stageRef.current?.clearReaction();
  }, []);

  const hasAvatar = useCallback(() => Boolean(stageRef.current?.hasAvatar()), []);

  const modelCarouselEntries = useMemo(
    () => modelPackages.flatMap((pack) => pack.models.map((model) => ({ pack, model }))),
    [modelPackages],
  );
  const carouselIndex = useMemo(() => {
    const targetId = pendingModelId ?? activeModelId;
    const found = modelCarouselEntries.findIndex(({ model }) => model.id === targetId);
    return found >= 0 ? found : 0;
  }, [modelCarouselEntries, pendingModelId, activeModelId]);

  const carouselItems: CoverflowCarouselItem[] = useMemo(() => modelCarouselEntries.map(({ pack, model }) => {
    const isFocused = model.id === (pendingModelId ?? activeModelId);
    let badge: CoverflowCarouselItem["badge"];
    if (isFocused && isBusy) {
      badge = <span className="model-load-badge is-loading" role="status"><span className="load-dot is-loading" aria-hidden="true" />กำลังโหลด…</span>;
    } else if (isFocused && modelStatus === "ready") {
      badge = <span className="model-load-badge is-ready" role="status"><span className="load-dot is-ready" aria-hidden="true" />พร้อมแล้ว</span>;
    } else if (isFocused && modelStatus === "error") {
      badge = <span className="model-load-badge is-error" role="status"><span className="load-dot is-error" aria-hidden="true" />ยังโหลดไม่ติด</span>;
    }
    const formatLabel = (model.format ?? "vrm").toUpperCase();
    return {
      id: model.id,
      image: modelPreviews[model.id],
      alt: `รูปโปรไฟล์ของ ${model.name}`,
      badge,
      content: (
        <span className="grid gap-1">
          <strong className="text-base">{model.name}</strong>
          <small className="text-white/85">
            {formatLabel} · {cloudLibrary?.models.some((entry) => entry.id === pack.id) ? "อยู่บน Cloud" : "อยู่ในเครื่องนี้"}
          </small>
        </span>
      ),
    };
  }), [cloudLibrary, isBusy, modelCarouselEntries, modelPreviews, modelStatus, pendingModelId, activeModelId]);

  const activePreviewUrl = modelPreviews[activeModelId ?? ""] ?? Object.values(modelPreviews)[0];

  return {
    modelPackages,
    modelsReady,
    activePackage,
    activeModel,
    activeModelId,
    activeExpressions,
    activeExpressionsModelId,
    activeExpressionsList,
    activeMotionsList,
    activeMotion,
    activePreviewUrl,
    modelStatus,
    isBusy,
    modelNotice,
    setModelNotice,
    modelImporting,
    modelImportProgress,
    displayedImportPercent,
    modelUploadKey,
    setModelUploadKey,
    textureQuality,
    setTextureQuality,
    lightingMode,
    setLightingMode,
    graphicsLost,
    carouselEntries: modelCarouselEntries,
    carouselItems,
    carouselIndex,
    setPendingModelId,
    importModels,
    chooseModel,
    saveActiveModelToCloud,
    removeActiveModel,
    resetModelTransform,
    reloadActiveModel,
    toggleSavedExpression,
    saveExpressionSelection,
    clearSavedExpressions,
    selectMotion,
    setMouthOpen,
    playEmotionReaction,
    clearReaction,
    hasAvatar,
  };
}

export type { LocalModel as Local3DModel, ModelPackage as Model3DPackage, ModelMotion as Model3DMotion };
