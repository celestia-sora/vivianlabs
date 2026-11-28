"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import type { LightingMode } from "@/lib/avatar-3d-engine";
import { useAvatar3D } from "@/lib/use-avatar-3d";
import { captureModelRestState, restoreModelRestState, type ModelRestState, type CubismRestModel } from "@/lib/model-rest-state";
import { attachModelWind, type WindInternalModel } from "@/lib/model-wind";
import { clampModelTransform, clearModelTransform, loadModelTransform, saveModelTransform, type ModelTransform } from "@/lib/model-position";
import { preloadLive2DModules, waitForCubismCore } from "@/lib/model-runtime";
import { loadModelPreviews, removeModelPreview, saveModelPreview } from "@/lib/model-preview-cache";
import { faceCrop, SNAPSHOT_PREVIEW_PATH, snapshotToBlob } from "@/lib/model-snapshot";
import { scheduleBackgroundWork } from "@/lib/startup-background";
import { readChatResponse } from "@/lib/chat-stream";
import { AudioStreamingManager, type AudioContextLike } from "@/lib/audio-streaming";
import { startTiming, finishTiming, cancelTiming, type LocalTiming } from "@/lib/performance";
import { shouldPauseModelStartup, clearModelLoadState } from "@/lib/model-startup";
import { stepSimulation, easeDisplayed, desiredUploadPercent } from "@/lib/upload-progress";
import { singleFlightModel, preloadModelPackages } from "@/lib/model-preload";
import { subscribeModelLibrary } from "@/lib/model-library-realtime";
import { useConversationHistory } from "@/lib/use-conversation-history";
import { historyMessage, HISTORY_CACHE_KEY, type HistoryMessage, type HistoryConversation } from "@/lib/chat-history";
import { deleteCloudHistory } from "@/lib/chat-history-client";
import { authFetch, getAuthToken } from "@/lib/auth/fetch";
import { speechText } from "@/lib/speech";
import { KineticText } from "@/components/KineticText";
import { KineticStore } from "@/lib/kinetic/types";
import { TtsSyncController } from "@/lib/kinetic/tts-sync";
import { TtsAlignmentTracker, parseAlignmentEvent } from "@/lib/kinetic/tts-align-client";
import { SttSyncController } from "@/lib/kinetic/stt-sync";
import { ScribeRealtimeClient } from "@/lib/scribe-realtime";
import { startPcmCapture, type PcmCapture } from "@/lib/pcm-capture";
import { hapticFeedback, hapticPatterns } from "@/lib/haptics";
import { decayCompanionState, type CompanionState, defaultCompanionState, normalizeMood, moodLabel, type Mood } from "@/lib/companion";
import { detectLive2DEmotion, resolveLive2DExpression, resolveLive2DMotion } from "@/lib/live2d-emotion";
import { createExpressionStack, loadExpressionParameterSets, SAVED_EXPRESSION_STACK_FILE, SAVED_EXPRESSION_STACK_NAME } from "@/lib/live2d-expression-stack";
import { MODEL_CONFIG, type ModelKey } from "@/lib/models";
import { createModelResources, importModelFiles, loadModelCatalog, hydrateModelPackage, modelCatalogEntry, readModelSelection, resolveStartupModel, writeModelSelection, removeModelPackage, saveModelPackage, type ModelPackage, type ModelMotion } from "@/lib/local-models";
import { CloudModelError, getCloudModels, cloudModelPlaceholder, isCloudLibraryAllowed, uploadCloudModel, downloadCloudModel, deleteCloudModel, saveCloudModelPreference, saveCloudModelExpressions, type CloudLibrary } from "@/lib/cloud-models";
import { isLive2DCloudModel } from "@/lib/cloud-models-3d";
import { useVoicePreferences } from "@/lib/use-voice-preferences";
import { useCustomInstructions } from "@/lib/use-custom-instructions";
import { useUserProfile } from "@/lib/use-user-profile";
import { UserOnboardingModal, UserProfileSettingsCard } from "@/app/components/user-onboarding-modal";
import type { SpeechLanguage } from "@/lib/voice-preferences";
import { useSceneLibrary } from "@/lib/use-scene-library";
import { SceneManager } from "@/app/components/scene-manager";
import { SceneBackground } from "@/app/components/scene-background";
import { StorageStatusPanel } from "@/app/components/storage-status";
import {
  CLOUD_TIER_REQUIRED_MESSAGE,
  LimitReachedModal,
  RequestSelectedModal,
  SorachanAdminPanel,
  TierMenuSummary,
  TierSettingsCard,
  formatPersonalMb,
  isQuotaDepleted,
  vivianQuotaExceededReply,
  type AccountChatQuota,
  type AccountSummary,
  type TierKey,
} from "@/app/components/tier-panel";
import { createVoiceActivity, updateVoiceActivity, type VoiceActivityState } from "@/lib/voice-activity";
import type { SceneDecision } from "@/lib/scenes";
import { useMotionValue } from "motion/react";
import SiriOrb from "@/components/ui/smoothui/siri-orb";
import AnimatedFileUpload from "@/components/ui/smoothui/animated-file-upload";
import CoverflowCarousel, { type CoverflowCarouselItem } from "@/components/ui/smoothui/coverflow-carousel";
import type { AIState } from "@/components/ui/smoothui/ai-core";
import PagePreloader from "@/components/ui/smoothui/page-preloader";

async function availableModelPackage(pack: ModelPackage, cloud: CloudLibrary | Promise<CloudLibrary | null> | null, signal?: AbortSignal): Promise<ModelPackage | undefined> {
  return singleFlightModel(pack.id, (sharedSignal) => hydrateModelPackage(pack, {
    signal: sharedSignal,
    recover: cloud ? async () => {
      // A readable local cache never waits for the cloud request.
      const library = await cloud;
      sharedSignal.throwIfAborted();
      const remote = library?.models.find((model) => model.id === pack.id);
      if (!remote || !library) throw new Error("หาไฟล์โมเดลในเครื่องไม่เจอแฮะ ลองต่อ Cloud หรือโยนไฟล์โมเดลเข้ามาใหม่อีกรอบนะ");
      const downloaded = await downloadCloudModel(remote, library.userId, sharedSignal);
      await saveModelPackage(downloaded).catch(() => {});
      return downloaded;
    } : undefined,
  }), signal);
}

type IconName = "config" | "info" | "wardrobe" | "chevron" | "mic" | "micOff" | "video" | "clip" | "message" | "send" | "close" | "memory" | "sound" | "language" | "status" | "scene" | "plus" | "search" | "sun" | "moon";

function Icon({ name, size = 24 }: { name: IconName; size?: number }) {
  const iconUrl = `/icons/${name}.svg`;
  return <span className="app-icon" style={{ width: size, height: size, maskImage: `url("${iconUrl}")`, WebkitMaskImage: `url("${iconUrl}")` }} aria-hidden="true" />;
}

type Message = HistoryMessage;
type OrbDirection = "mic" | "camera" | "type" | "settings";
type Memory = { id: number; memory: string; category: string; importance: number };
type Panel = "conversations" | "memories" | "character" | "scenes" | "voice" | "status" | "settings";
type AvatarMode = "live2d" | "3d";
const AVATAR_MODE_STORAGE_KEY = "vivian-avatar-mode";
type Conversation = HistoryConversation;
function isModelVisible(pack: ModelPackage, accountId: string): boolean {
  return !pack.cloudOwner || pack.cloudOwner === accountId || pack.cloudOwner === "shared";
}
const CONVERSATIONS_KEY = HISTORY_CACHE_KEY;
function modelExpressionPreferenceKey(packageId: string, manifestPath: string): string {
  return `vivian-model-expressions:${packageId}:${manifestPath}`;
}
const LANGUAGE_OPTIONS: Array<{ code: SpeechLanguage; label: string; nativeName: string }> = [
  { code: "global", label: "ทุกภาษา (จับตามที่คุย)", nativeName: "Global" },
  { code: "th", label: "ภาษาไทย", nativeName: "TH" },
  { code: "en", label: "ภาษาอังกฤษ", nativeName: "EN" },
  { code: "ja", label: "ภาษาญี่ปุ่น", nativeName: "JP" },
  { code: "ko", label: "ภาษาเกาหลี", nativeName: "KR" },
  { code: "zh", label: "ภาษาจีน", nativeName: "CN" },
];
// Quick actions shown as a frosted glass row above the orb on double-tap.
const ORB_DIRECTIONS: Array<{ key: OrbDirection; icon: IconName; label: string }> = [
  { key: "mic", icon: "mic", label: "ไมค์" },
  { key: "camera", icon: "video", label: "กล้อง" },
  { key: "type", icon: "message", label: "พิมพ์" },
  { key: "settings", icon: "config", label: "ตั้งค่า" },
];
const BACKGROUNDS = { day: "/backgrounds/christmas-day-4x3.jpg", night: "/backgrounds/christmas-night-4x3.jpg" } as const;
const PRESET_SCENE_IMAGES = Object.values(BACKGROUNDS);
const APP_CODENAME = "None";
const SILENT_WAV = "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";
const CHAT_TIMEOUT_MS = 35000;
// The server aborts Fish at 14 seconds. Give the response a small transport
// margin, then always release the sending state instead of leaving "Thinking".
const TTS_TIMEOUT_MS = 17000;
const STT_TIMEOUT_MS = 28000;
const AUDIO_UNLOCK_MS = 1200;
const PLAYBACK_START_MS = 2500;
const AUDIO_SYNC_SETTLE_MS = 140;
const MIN_RECORDING_MS = 550;
const MIN_SPEECH_MS = 320;

function abortAfter(ms: number) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
  const controller = new AbortController();
  window.setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T) {
  let timer: number | undefined;
  return Promise.race([
    promise,
    new Promise<T>((resolve) => { timer = window.setTimeout(() => resolve(fallback), ms); }),
  ]).finally(() => { if (timer) window.clearTimeout(timer); });
}

export default function Companion({ accountEmail: initialAccountEmail, accountId: initialAccountId }: { accountEmail: string; accountId: string }) {
  const [accountEmail, setAccountEmail] = useState(initialAccountEmail);
  const [accountId, setAccountId] = useState(initialAccountId);
  const [account, setAccount] = useState<AccountSummary | null>(null);
  const [accountLoading, setAccountLoading] = useState(false);
  const accountRef = useRef<AccountSummary | null>(null);
  accountRef.current = account;
  const [requestModalOpen, setRequestModalOpen] = useState(false);
  const [limitModalOpen, setLimitModalOpen] = useState(false);

  // Sign-in gate (Cloudflare flow): the bearer token lives in localStorage
  // (vivian_auth_token). Consume `#token=...` first, then enforce login.
  useEffect(() => {
    try {
      const match = window.location.hash.match(/#token=([^&]+)/);
      if (match?.[1]) {
        window.localStorage.setItem("vivian_auth_token", decodeURIComponent(match[1]));
        window.history.replaceState(null, "", window.location.pathname);
        return;
      }
      if (!window.localStorage.getItem("vivian_auth_token")) {
        window.location.replace("/login");
      }
    } catch {
      // Storage unavailable — let the API 401s drive the flow
    }
  }, []);

  const sceneLibraryRef = useRef<{ refresh: () => Promise<void> } | null>(null);
  const syncUserProfileFromAccountRef = useRef<((accountData: AccountSummary) => void) | null>(null);

  async function refreshAccount(signal?: AbortSignal) {
    let hasToken = false;
    try {
      hasToken = Boolean(getAuthToken());
    } catch {
      hasToken = false;
    }
    if (!hasToken) return;
    setAccountLoading(true);
    try {
      const response = await authFetch("/api/account", {
        cache: "no-store",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12_000)]) : AbortSignal.timeout(12_000),
      });
      if (!response.ok) return;
      const data = await response.json() as AccountSummary;
      if (signal?.aborted) return;
      const previousTier = accountRef.current?.tier;
      setAccount(data);
      if (data.user?.email) setAccountEmail(data.user.email);
      if (data.user?.id) setAccountId(data.user.id);
      syncUserProfileFromAccountRef.current?.(data);
      if (previousTier === "free" && data.tier !== "free") {
        void getCloudModels(signal).then(setCloudLibrary).catch(() => {});
        void sceneLibraryRef.current?.refresh().catch(() => {});
      }
    } catch {
      // Companion remains usable on cached/local state if /api/account is temporarily unavailable.
    } finally {
      if (!signal?.aborted) setAccountLoading(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    const initial = window.setTimeout(() => {
      void refreshAccount(controller.signal);
    }, 0);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshAccount(controller.signal);
    };
    const onFocus = () => { void refreshAccount(controller.signal); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearTimeout(initial);
      controller.abort();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const refreshAccountRef = useRef(refreshAccount);
  refreshAccountRef.current = refreshAccount;
  const refreshAccountStable = useCallback(() => refreshAccountRef.current(), []);
  const [avatarMode, setAvatarModeState] = useState<AvatarMode>("live2d");
  const avatarModeRef = useRef<AvatarMode>("live2d");
  avatarModeRef.current = avatarMode;
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(AVATAR_MODE_STORAGE_KEY);
      if (saved === "3d") queueMicrotask(() => setAvatarModeState("3d"));
    } catch { /* Optional preference persistence. */ }
  }, []);
  const switchAvatarMode = useCallback((next: AvatarMode) => {
    setAvatarModeState(next);
    try {
      window.localStorage.setItem(AVATAR_MODE_STORAGE_KEY, next);
    } catch { /* Optional preference persistence. */ }
  }, []);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvas3dRef = useRef<HTMLCanvasElement>(null);
  const modelFolder3dRef = useRef<HTMLInputElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pixiAppRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const modelRef = useRef<any>(null);
  const modelPresentationRef = useRef<{ model: NonNullable<typeof modelRef.current>; dispose: () => void } | null>(null);
  const modelRenderAbortRef = useRef<AbortController | null>(null);
  const [backgroundReady, setBackgroundReady] = useState(false);
  const modelSelectionAbortRef = useRef<AbortController | null>(null);
  const modelSelectionTimingRef = useRef<LocalTiming | undefined>(undefined);
  const startupTimingRef = useRef<LocalTiming | undefined>(undefined);
  const modelRestStateRef = useRef<ModelRestState | null>(null);
  const modelLoadIdRef = useRef(0);
  const modelTransformRef = useRef<ModelTransform>({ x: 0, y: 0, scale: 1 });
  const modelBaseScaleRef = useRef(1);
  const startupModelResolvedRef = useRef(false);
  const expressionActionRef = useRef(0);
  const motionActionRef = useRef(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recordingStartedAtRef = useRef(0);
  const voiceContextRef = useRef<AudioContext | null>(null);
  const voiceActivityRef = useRef<VoiceActivityState | null>(null);
  const voiceAnalyserRef = useRef<AnalyserNode | null>(null);
  const voiceSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const voiceMonitorRef = useRef<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioUnlockPromiseRef = useRef<Promise<void> | null>(null);
  const audioPrimedRef = useRef(false);
  const mediaSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const lipSyncFrameRef = useRef<number | null>(null);
  const speakIdRef = useRef(0);
  const audioUnlockedByUserRef = useRef(false);
  const ttsAbortRef = useRef<AbortController | null>(null);
  const chatStreamAbortRef = useRef<AbortController | null>(null);
  const userInterruptedRef = useRef(false);
  const audioStreamingRef = useRef<AudioStreamingManager | null>(null);
  // Kinetic Center Build (Vivian side): word-synchronized speech text driven by the audio clock.
  const [vivianKinetic] = useState(() => new KineticStore());
  const [ttsSync] = useState(() => new TtsSyncController());
  const [ttsTracker] = useState(() => new TtsAlignmentTracker());
  const kineticLoopRef = useRef<number | null>(null);
  // Kinetic Center Build (user side): live Scribe v3 Live transcript. Separate controller and no shared clock.
  const [userKinetic] = useState(() => new KineticStore());
  const [sttSync] = useState(() => new SttSyncController());
  const scribeRef = useRef<ScribeRealtimeClient | null>(null);
  const pcmCaptureRef = useRef<PcmCapture | null>(null);
  const sttClearTimerRef = useRef<number | null>(null);
  const [kineticActive, setKineticActive] = useState(false);
  const [kineticReplyId, setKineticReplyId] = useState<string | null>(null);
  const sendingRef = useRef(false);
  const resettingRef = useRef(false);
  const memoryGenerationRef = useRef(0);
  const speakingRef = useRef(false);
  const mutedRef = useRef(false);
  const recordingRef = useRef(false);
  const micEnabledRef = useRef(false);
  const interactedRef = useRef(false);
  const lastActivityRef = useRef(Date.now());
  const voiceIdRef = useRef("");
  const speechLanguageRef = useRef<SpeechLanguage>("th");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const videoStreamRef = useRef<MediaStream | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cameraActiveRef = useRef(false);
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraFacing, setCameraFacing] = useState<"user" | "environment">("user");
  const [attachedImage, setAttachedImage] = useState<string | null>(null);
  cameraActiveRef.current = cameraActive;
  const messagesRef = useRef<Message[]>([]);
  const companionRef = useRef<CompanionState>(defaultCompanionState());
  const [message, setMessage] = useState("");
  const [memories, setMemories] = useState<Memory[]>([]);
  const [recording, setRecording] = useState(false);
  const [muted, setMuted] = useState(false);
  const [sending, setSending] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [textOpen, setTextOpen] = useState(false);
  const [radialOpen, setRadialOpen] = useState(false);
  const radialOpenRef = useRef(false);
  const orbPointerRef = useRef<{ x: number; y: number } | null>(null);
  // Push-to-talk: hold ≈220ms starts recording; release stops and transcribes.
  const orbHoldTimerRef = useRef<number | null>(null);
  const orbPttActiveRef = useRef(false);
  const orbLastTapRef = useRef(0);
  // Live mic loudness lives in a MotionValue so 60fps updates never re-render.
  const micAmplitude = useMotionValue(0);
  const [sttPreview, setSttPreview] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [panel, setPanel] = useState<Panel | null>(null);
  const panelRef = useRef<Panel | null>(null);
  const sidebarOpenRef = useRef(false);
  const activeConversationRef = useRef("daily-talk");
  const [conversationSearch, setConversationSearch] = useState("");
  const [previewConversationId, setPreviewConversationId] = useState<string | null>(null);
  const [characterTab, setCharacterTab] = useState<"outfit" | "expression" | "pose">("outfit");
  const [languageOpen, setLanguageOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const selectedModel: ModelKey = "Miss";
  const [modelPackages, setModelPackages] = useState<ModelPackage[]>([]);
  const [activeModelId, setActiveModelId] = useState<string | null>(null);
  const activeModelIdRef = useRef<string | null>(null);
  activeModelIdRef.current = activeModelId;
  const [modelsReady, setModelsReady] = useState(false);
  const [modelSelectionResolved, setModelSelectionResolved] = useState(false);
  const [modelImporting, setModelImporting] = useState(false);
  const [modelImportProgress, setModelImportProgress] = useState<{ label: string; percent: number | null } | null>(null);
  const [displayedImportPercent, setDisplayedImportPercent] = useState<number | null>(null);
  const importProgressRef = useRef<{ label: string; percent: number | null } | null>(null);
  importProgressRef.current = modelImportProgress;
  const displayedImportRef = useRef(0);
  const simulatedImportRef = useRef(0);
  const lastImportLabelRef = useRef<string | null>(null);
  const [modelUploadKey, setModelUploadKey] = useState(0);
  const [modelStatus, setModelStatus] = useState<"empty" | "loading" | "ready" | "error">("empty");
  const [startupModelPending, setStartupModelPending] = useState(false);
  const [modelSwitchPending, setModelSwitchPending] = useState(false);
  const [modelNotice, setModelNotice] = useState<string | null>(null);
  const modelCloudRequestRef = useRef<Promise<CloudLibrary | null> | null>(null);
  const [cloudLibrary, setCloudLibrary] = useState<CloudLibrary | null>(null);
  const modelPreloadAbortRef = useRef<AbortController | null>(null);
  const cloudLibraryRef = useRef<CloudLibrary | null>(null);
  cloudLibraryRef.current = cloudLibrary;
  const live2dBusyRef = useRef(false);
  const [modelPreviews, setModelPreviews] = useState<Record<string, string>>({});
  const [pendingModelId, setPendingModelId] = useState<string | null>(null);
  const snapshotMapRef = useRef<Promise<Map<string, Blob>> | null>(null);
  const modelPreviewUrlsRef = useRef(new Map<string, { path: string; url: string }>());
  const [textureQuality, setTextureQuality] = useState<"auto" | "original">("auto");
  const [modelReload, setModelReload] = useState(0);
  const [graphicsLost, setGraphicsLost] = useState(false);
  const [modelPaused, setModelPaused] = useState(false);
  const [textureSummary, setTextureSummary] = useState<string | null>(null);
  const [activeExpression, setActiveExpression] = useState<string | null>(null);
  const [activeExpressions, setActiveExpressions] = useState<string[]>([]);
  const [activeExpressionsModelId, setActiveExpressionsModelId] = useState<string | null>(null);
  const activeExpressionsRef = useRef<string[]>([]);
  const activeExpressionModelRef = useRef<string | null>(null);
  const pendingExpressionPreferencesRef = useRef(new Map<string, string[]>());
  const expressionSaveQueuesRef = useRef(new Map<string, Promise<void>>());
  const expressionSaveVersionsRef = useRef(new Map<string, number>());
  const aiExpressionStacksRef = useRef(new Map<string, Map<string, string>>());
  const [activeMotion, setActiveMotion] = useState<string | null>(null);
  const modelFolderRef = useRef<HTMLInputElement>(null);
  const activePackage = modelPackages.find((pack) => pack.models.some((model) => model.id === activeModelId));
  const activeModel = activePackage?.models.find((model) => model.id === activeModelId);
  const modelCarouselEntries = useMemo(
    () => modelPackages.flatMap((pack) => pack.models.map((model) => ({ pack, model }))),
    [modelPackages],
  );
  const modelCarouselIndex = Math.max(0, modelCarouselEntries.findIndex(({ model }) => model.id === (pendingModelId ?? activeModelId)));
  const live2dBusy = startupModelPending || modelSwitchPending || modelStatus === "loading";
  live2dBusyRef.current = live2dBusy;

  // Ease-out / asymptotic upload bar: the displayed value always moves
  // toward a simulation that starts fast and saturates below 100% until the
  // real step finishes. Each import stage resets the curve.
  // State updates are throttled (~12fps + only on change) so the main
  // thread stays responsive while the bar is visible.
  useEffect(() => {
    if (!modelImporting) {
      displayedImportRef.current = 0;
      simulatedImportRef.current = 0;
      lastImportLabelRef.current = null;
      return;
    }
    const reduced = typeof window !== "undefined" && typeof window.matchMedia === "function"
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

  // Watchdog: never let the full-screen preloader lock the UI forever.
  // If a model load stalls, surface an error so chat/scroll work again.
  useEffect(() => {
    if (!live2dBusy) return;
    const timer = window.setTimeout(() => {
      if (!live2dBusyRef.current) return;
      setModelStatus("error");
      setStartupModelPending(false);
      setModelSwitchPending(false);
      setModelNotice((notice) => notice ?? "โมเดลนี้โหลดนานนิดนึง เดี๋ยวให้โหลดต่อข้างหลัง ระหว่างนี้ทักแชตคุยกับวิเวียนไปก่อนได้เลย!");
    }, 30_000);
    return () => window.clearTimeout(timer);
  }, [live2dBusy]);
  const modelCarouselItems: CoverflowCarouselItem[] = useMemo(() => modelCarouselEntries.map(({ pack, model }) => {
    const isFocused = model.id === (pendingModelId ?? activeModelId);
    let badge: CoverflowCarouselItem["badge"];
    if (isFocused && live2dBusy) {
      badge = <span className="model-load-badge is-loading" role="status"><span className="load-dot is-loading" aria-hidden="true" />กำลังโหลด…</span>;
    } else if (isFocused && modelStatus === "ready") {
      badge = <span className="model-load-badge is-ready" role="status"><span className="load-dot is-ready" aria-hidden="true" />พร้อมแล้ว</span>;
    } else if (isFocused && modelStatus === "error") {
      badge = <span className="model-load-badge is-error" role="status"><span className="load-dot is-error" aria-hidden="true" />ยังโหลดไม่ติด</span>;
    }
    return {
      id: model.id,
      image: modelPreviews[model.id],
      alt: `รูปโปรไฟล์ของ ${model.name}`,
      badge,
      content: <span className="grid gap-1"><strong className="text-base">{model.name}</strong><small className="text-white/85">{cloudLibrary?.models.some((entry) => entry.id === pack.id) ? "อยู่บน Cloud" : "อยู่ในเครื่องนี้"}</small></span>,
    };
  }), [cloudLibrary, live2dBusy, modelCarouselEntries, modelPreviews, modelStatus, pendingModelId, activeModelId]);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const avatar3d = useAvatar3D({
    enabled: avatarMode === "3d",
    accountId,
    preferencesReady,
    canvasRef: canvas3dRef,
    cloudLibrary,
    setCloudLibrary,
    cloudRequestRef: modelCloudRequestRef,
    accountRef,
    refreshAccount: refreshAccountStable,
  });
  const [companion, setCompanion] = useState<CompanionState>(defaultCompanionState());
  const {
    customInstructions,
    savedCustomInstructions,
    updateCustomInstructions,
    saveCustomInstructions,
    savingCustomInstructions,
    customInstructionsDirty,
    customInstructionsSynced,
    customInstructionsNotice,
    customInstructionVersions,
    clearCustomInstructions,
    restoreCustomInstructions,
  } = useCustomInstructions();
  const {
    userProfile,
    savingUserProfile,
    userProfileNotice,
    onboardingOpen,
    setOnboardingOpen,
    saveUserProfile,
    dismissOnboarding,
    syncUserProfileFromAccount,
  } = useUserProfile(accountId);
  const userProfileRef = useRef(userProfile);
  userProfileRef.current = userProfile;
  syncUserProfileFromAccountRef.current = syncUserProfileFromAccount;
  const [editingMemoryId, setEditingMemoryId] = useState<number | null>(null);
  const [memoryDraft, setMemoryDraft] = useState("");
  const [memorySummary, setMemorySummary] = useState("");
  const [memorySummaryDraft, setMemorySummaryDraft] = useState("");
  const [editingMemorySummary, setEditingMemorySummary] = useState(false);
  const [memorySummaryBusy, setMemorySummaryBusy] = useState<"idle" | "generating" | "saving">("idle");
  const [memorySummaryNotice, setMemorySummaryNotice] = useState<string | null>(null);
  const [backgroundMode, setBackgroundMode] = useState<keyof typeof BACKGROUNDS>("day");
  const sceneLibrary = useSceneLibrary(PRESET_SCENE_IMAGES, accountId, backgroundReady);
  sceneLibraryRef.current = sceneLibrary;
  const activeCustomSceneId = sceneLibrary.preferences.activeSceneId;
  const selectedPreset = sceneLibrary.preferences.preset ?? backgroundMode;
  const { voiceId, language: speechLanguage, saveVoiceId, saveLanguage, notice: voiceNotice, refresh: refreshVoicePreferences } = useVoicePreferences();
  const [voiceIdInput, setVoiceIdInput] = useState("");
  useEffect(() => { queueMicrotask(() => setVoiceIdInput(voiceId)); }, [voiceId]);
  const [errorNotice, setErrorNotice] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const history = useConversationHistory(null, "", sending || resetting);
  const { messages, setMessages, conversations, activeConversationId, setActiveConversationId } = history;
  const [resetConfirming, setResetConfirming] = useState(false);
  const [resetNotice, setResetNotice] = useState<string | null>(null);
  const [streak, setStreak] = useState(0);
  const lastVivianMessage = messages.filter((item) => item.from === "vivian").at(-1)?.text ?? "";
  const lastVivianId = messages.filter((item) => item.from === "vivian").at(-1)?.id;
  const showKinetic = kineticActive && (sending || (lastVivianId !== undefined && lastVivianId === kineticReplyId));
  messagesRef.current = messages;
  activeConversationRef.current = activeConversationId;
  sendingRef.current = sending;
  mutedRef.current = muted;
  voiceIdRef.current = voiceId;
  speechLanguageRef.current = speechLanguage;
  companionRef.current = companion;

  useEffect(() => {
    const hour = new Date().getHours();
    queueMicrotask(() => setBackgroundMode(hour >= 6 && hour < 18 ? "day" : "night"));
  }, []);

  function selectPresetScene(scene: keyof typeof BACKGROUNDS) {
    void sceneLibrary.updatePreferences({ preset: scene });
  }


  useEffect(() => {
    if (!sidebarOpen) return;
    if (panel === "memories") {
      void loadMemory();
      return;
    }
    if (panel !== "conversations") return;
    const refresh = window.setInterval(() => { void loadMemory(); }, 3000);
    return () => window.clearInterval(refresh);
  }, [sidebarOpen, panel]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    // Start the PIXI/Live2D module download now only when Live2D is active.
    if (localStorage.getItem("vivian-avatar-mode") !== "3d") void preloadLive2DModules().catch(() => {});
    const localRequest = loadModelCatalog().catch(() => [] as ModelPackage[]);
    let cancelCloudStart: (() => void) | undefined;
    const cloudRequest = localRequest.then((local) => new Promise<CloudLibrary | null>((resolve) => {
      const start = () => {
        if (controller.signal.aborted) { resolve(null); return; }
        void getCloudModels(AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)])).then(resolve, () => resolve(null));
      };
      if (local.some((pack) => isModelVisible(pack, accountId))) cancelCloudStart = scheduleBackgroundWork(start);
      else start(); // A cloud-only active model remains critical work.
      controller.signal.addEventListener("abort", () => resolve(null), { once: true });
    }));
    modelCloudRequestRef.current = cloudRequest;
    void (async () => {
      const local = await localRequest;
      if (cancelled) return;
      const packages = local.filter((pack) => isModelVisible(pack, accountId));
      const saved = localStorage.getItem("vivian-local-model");
      const selection = readModelSelection(localStorage);
      let selected = resolveStartupModel(packages, saved, selection);
      const restoreStartup = (selected: string | null): boolean => {
        let paused = false;
        try {
          if (shouldPauseModelStartup(sessionStorage, selected)) {
            paused = true;
            setModelPaused(true);
            setModelStatus("error");
            setModelNotice("โมเดลโหลดสะดุดไปสองรอบอะ กด 'โหลดโมเดลใหม่อีกที' เพื่อใช้โหมดออโต้ดูนะ");
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
      // Render cached originals immediately; cloud latency is independent.
      if (selected) setModelsReady(true);
      const cloud = await cloudRequest;
      if (cancelled) return;
      setCloudLibrary(cloud);
      if (!cloud) {
        setModelNotice((notice) => notice ?? "ตอนนี้ต่อ Cloud ไม่ติดแฮะ แต่โมเดลที่เซฟไว้ในเครื่องนี้ยังเล่นได้ปกติเลย!");
        return;
      }
      const live2dCloudModels = cloud.models.filter((model) => !Array.isArray(model.manifests) || model.manifests.some((entry) => /\.model3\.json$/i.test(entry.path)));
      setModelPackages((current) => {
        // Retain hydrated object identities so catalog sync doesn't reload GPU assets.
        const sharedIds = new Set(live2dCloudModels.filter((model) => model.scope === "shared").map((model) => model.id));
        const merged = current.filter((pack) => !pack.cloudOwner || live2dCloudModels.some((model) => model.id === pack.id))
          .map((pack) => sharedIds.has(pack.id) && pack.cloudOwner !== "shared" ? { ...pack, cloudOwner: "shared" } : pack);
        for (const pack of local.filter((entry) => sharedIds.has(entry.id))) {
          if (!merged.some((entry) => entry.id === pack.id)) merged.push({ ...pack, cloudOwner: "shared" });
        }
        for (const model of live2dCloudModels) if (!merged.some((pack) => pack.id === model.id)) merged.push(cloudModelPlaceholder(model));
        return merged;
      });
      const sharedCaches = local.filter((pack) => live2dCloudModels.some((model) => model.scope === "shared" && model.id === pack.id)).map((pack) => ({ ...pack, cloudOwner: "shared" }));
      const reconciledPackages = packages.filter((pack) => pack.cloudOwner !== "shared" || live2dCloudModels.some((model) => model.scope === "shared" && model.id === pack.id));
      const allPackages = [...reconciledPackages, ...sharedCaches.filter((pack) => !reconciledPackages.some((localPack) => localPack.id === pack.id)), ...live2dCloudModels.map(cloudModelPlaceholder).filter((pack) => !local.some((localPack) => localPack.id === pack.id))];
      const globalSelection = cloud.preference?.modelId;
      selected = globalSelection && allPackages.some((pack) => pack.models.some((model) => model.id === globalSelection))
        ? globalSelection : resolveStartupModel(allPackages, saved, selection);
      const cloudStartupPaused = restoreStartup(selected);
      if (cloudStartupPaused) { startupModelResolvedRef.current = true; setStartupModelPending(false); }
      setActiveModelId(selected);
      if (selected && !startupModelResolvedRef.current) setStartupModelPending(true);
      setModelSelectionResolved(true);
      refreshSnapshots(allPackages);
      // Background preload is deferred until the selected model reaches
      // first frame (modelStatus === "ready"). See the priority effect below.
    })().catch(() => {
      if (!cancelled) setModelNotice("เข้าคลังโมเดลในเครื่องไม่ได้แฮะ ลองรีเฟรชอีกทีนะ");
    }).finally(() => { if (!cancelled) { setModelSelectionResolved(true); setModelsReady(true); } });
    return () => { cancelled = true; cancelCloudStart?.(); modelPreloadAbortRef.current?.abort(); controller.abort(); };
  }, [accountId]);

  useEffect(() => {
    if (!modelsReady || !modelSelectionResolved) return;
    if (activeModelId) writeModelSelection(localStorage, activeModelId);
    else localStorage.removeItem("vivian-local-model");
  }, [modelsReady, modelSelectionResolved, activeModelId]);

  useEffect(() => {
    if (pendingModelId && pendingModelId === activeModelId) queueMicrotask(() => setPendingModelId(null));
  }, [activeModelId, pendingModelId]);

  // Priority: the selected model owns initialization until first frame
  // (modelStatus === "ready"). Background preloading for other packages
  // starts only after that point and pauses immediately on any new load.
  useEffect(() => {
    if (avatarMode !== "live2d" || modelStatus !== "ready" || !activeModelId) {
      stopBackgroundPreload();
      return;
    }
    startBackgroundPreload(modelPackages, activeModelId, cloudLibrary ?? modelCloudRequestRef.current);
    return () => {
      // Restart when packages/cloud change so newly synced models join the
      // queue; abort on unmount or when leaving the ready state.
      stopBackgroundPreload();
    };
  }, [avatarMode, modelStatus, activeModelId, modelPackages, cloudLibrary]);

  useEffect(() => {
    let disposed = false;
    let refreshTimer: number | undefined;
    const unsubscribe = subscribeModelLibrary(() => {
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        void (async () => {
          const cloud = await getCloudModels(AbortSignal.timeout(12_000)).catch(() => null);
          if (!cloud || disposed) return;
          setCloudLibrary(cloud);
          if (cloud.cloudAllowed === false) return;
          const live2dCloudModels = cloud.models.filter(isLive2DCloudModel);
          setModelPackages((current) => {
            const sharedIds = new Set(live2dCloudModels.filter((model) => model.scope === "shared").map((model) => model.id));
            const merged = current.filter((pack) => !pack.cloudOwner || pack.models.some((model) => model.id === activeModelIdRef.current) || live2dCloudModels.some((model) => model.id === pack.id))
              .map((pack) => sharedIds.has(pack.id) && pack.cloudOwner !== "shared" && !pack.models.some((model) => model.id === activeModelIdRef.current) ? { ...pack, cloudOwner: "shared" } : pack);
            for (const model of live2dCloudModels) if (!merged.some((pack) => pack.id === model.id)) merged.push(cloudModelPlaceholder(model));
            return merged;
          });
          // Priority queue re-runs from the ready-effect after this merge;
          // do not start background loads while the active model is busy.
          refreshSnapshots(live2dCloudModels.map(cloudModelPlaceholder));
          // Deliberately do not change activeModelId here; other tabs pick this on reload.
        })();
      }, 400);
    });
    return () => {
      disposed = true;
      unsubscribe();
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      modelPreloadAbortRef.current?.abort();
    };
  }, [accountId]);

  function cacheModelPreviews(pack: ModelPackage) {
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
  }

  function refreshSnapshots(packages: ModelPackage[]) {
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
      .catch(() => {});
  }

  function cacheSnapshotPreview(modelId: string, blob: Blob) {
    const current = modelPreviewUrlsRef.current.get(modelId);
    if (current && current.path !== SNAPSHOT_PREVIEW_PATH) return;
    if (current) URL.revokeObjectURL(current.url);
    const url = URL.createObjectURL(blob);
    modelPreviewUrlsRef.current.set(modelId, { path: SNAPSHOT_PREVIEW_PATH, url });
    setModelPreviews((prev) => ({ ...prev, [modelId]: url }));
    void snapshotMapRef.current?.then((map) => { map.set(modelId, blob); }).catch(() => {});
    void saveModelPreview(modelId, blob);
  }

  function releaseModelPreviews(packageId: string) {
    const removedIds: string[] = [];
    for (const [modelId, preview] of modelPreviewUrlsRef.current) {
      if (!modelId.startsWith(`${packageId}:`)) continue;
      URL.revokeObjectURL(preview.url);
      modelPreviewUrlsRef.current.delete(modelId);
      removedIds.push(modelId);
    }
    if (removedIds.length) setModelPreviews((current) => {
      const next = { ...current };
      for (const modelId of removedIds) delete next[modelId];
      return next;
    });
  }

  useEffect(() => () => {
    for (const preview of modelPreviewUrlsRef.current.values()) URL.revokeObjectURL(preview.url);
    modelPreviewUrlsRef.current.clear();
  }, []);

  function applyModelTransform() {
    const model = modelRef.current;
    const canvas = canvasRef.current;
    if (!model || !canvas) return;
    const stage = canvas.parentElement?.getBoundingClientRect();
    if (!stage || !stage.width || !stage.height) return;
    modelTransformRef.current = clampModelTransform(modelTransformRef.current, stage.width, stage.height);
    const base = modelBaseScaleRef.current || 1;
    model.scale.set(base * modelTransformRef.current.scale);
    model.x = stage.width / 2 + modelTransformRef.current.x;
    model.y = stage.height * 0.99 + modelTransformRef.current.y;
  }

  function persistModelTransform() {
    const activeId = activeModelIdRef.current;
    if (!activeId) return;
    saveModelTransform(activeId, { ...modelTransformRef.current });
  }

  function resetModelTransform() {
    modelTransformRef.current = { x: 0, y: 0, scale: 1 };
    applyModelTransform();
    persistModelTransform();
  }

  function preloadPackage(pack: ModelPackage, cloud: CloudLibrary | Promise<CloudLibrary | null> | null, signal: AbortSignal) {
    return availableModelPackage(pack, cloud, signal).then((loaded) => {
      signal.throwIfAborted();
      if (loaded) cacheModelPreviews(loaded);
      return loaded;
    });
  }

  function stopBackgroundPreload() {
    modelPreloadAbortRef.current?.abort();
    modelPreloadAbortRef.current = null;
  }

  function startBackgroundPreload(
    packs: ModelPackage[],
    selectedId: string | null,
    cloud: CloudLibrary | Promise<CloudLibrary | null> | null,
  ) {
    stopBackgroundPreload();
    if (packs.length === 0) return;
    const controller = new AbortController();
    modelPreloadAbortRef.current = controller;
    void preloadModelPackages(
      packs,
      selectedId,
      (pack, signal) => preloadPackage(pack, cloud, signal),
      controller.signal,
      { isActiveBusy: () => live2dBusyRef.current },
    ).catch(() => {
      // Individual package failures are handled inside the queue; a
      // background-only failure must never affect the active model/chat.
    });
  }

  async function importModels(files: File[]) {
    if (modelImporting || !files.length) return;
    stopBackgroundPreload();
    startupModelResolvedRef.current = true;
    setStartupModelPending(false);
    setModelImporting(true);
    setModelImportProgress({ label: "กำลังเตรียมไฟล์โมเดลแป๊บ…", percent: null });
    const wasPaused = modelPaused;
    setModelPaused(true);
    setModelNotice(null);
    try {
      // Let the render effect release the old model and GPU textures before
      // expanding another package. Keep rendering paused through cloud sync.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const importingZip = files.length === 1 && /\.zip$/i.test(files[0].name);
      setModelImportProgress(importingZip ? { label: "กำลังแตกไฟล์โมเดล…", percent: 0 } : { label: "กำลังเช็กไฟล์โมเดลให้…", percent: null });
      let reportedExtraction = -1;
      const pack = await importModelFiles(files, importingZip ? (ratio) => {
        const percent = Math.min(99, Math.round(Math.max(0, Math.min(1, ratio)) * 100));
        if (percent <= reportedExtraction) return;
        reportedExtraction = percent;
        setModelImportProgress({ label: "กำลังแตกไฟล์โมเดล…", percent });
      } : undefined);
      setModelImportProgress({ label: "กำลังเซฟโมเดลลงเครื่องนี้…", percent: null });
      await saveModelPackage(pack);
      setModelPackages((current) => [...current.map(modelCatalogEntry), pack]);
      setActiveModelId(pack.models[0].id);
      void navigator.storage?.persist?.().catch(() => {});
      if (isCloudLibraryAllowed(cloudLibrary) && accountRef.current?.capabilities.canUseCloudModels !== false) {
        setModelImportProgress({ label: "กำลังเตรียมอัปขึ้น Cloud ส่วนตัว…", percent: null });
        await syncModelToCloud(pack, importingZip ? files[0] : undefined);
      }
    } catch (error) {
      if (error instanceof CloudModelError && error.code === "STORAGE_QUOTA_EXCEEDED") {
        setModelNotice("เซฟลงเครื่องนี้ให้แล้วนะ แต่พื้นที่ Cloud R2 ส่วนตัวเต็ม 512 MB แล้วอะ ลบอันเก่าออกก่อนค่อยอัปเพิ่มน้า");
      } else if (error instanceof CloudModelError && error.code === "TIER_REQUIRED") {
        setModelNotice(CLOUD_TIER_REQUIRED_MESSAGE);
      } else {
        setModelNotice(error instanceof Error ? error.message : "เอาโมเดลนี้เข้าไม่สำเร็จแฮะ ลองเช็กไฟล์อีกทีนะ");
      }
    } finally {
      setModelImporting(false);
      setModelImportProgress(null);
      setModelPaused(wasPaused);
    }
  }

  async function syncModelToCloud(pack: ModelPackage, originalZip?: File) {
    const saved = await uploadCloudModel(pack, (message) => {
      const match = /(\d{1,3})%/.exec(message);
      setModelImportProgress({ label: message.replace(/\s*\d{1,3}%\s*$/, "").trim(), percent: match ? Math.min(100, Number(match[1])) : null });
    }, originalZip);
    // Commit the new cache before discarding the existing local-only package.
    await saveModelPackage(saved.pack).catch(() => {});
    setModelPackages((current) => current.map((entry) => entry.id === pack.id ? saved.pack : entry));
    const selectedId = saved.pack.models.find((model) => model.manifestPath === activeModel?.manifestPath)?.id ?? saved.pack.models[0].id;
    setActiveModelId(selectedId);
    void saveCloudModelPreference(selectedId).catch(() => {});
    setCloudLibrary((current) => current ? {
      ...current,
      usage: saved.usage ?? current.usage,
      personalUsage: saved.personalUsage ?? current.personalUsage,
      models: [...current.models, { id: saved.pack.id, byteSize: saved.byteSize, scope: saved.scope, manifests: saved.pack.models.map((model) => ({ path: model.manifestPath, name: model.name })) }],
    } : current);
    await removeModelPackage(pack.id).catch(() => {});
    void refreshAccount();
    setModelNotice("เซฟโมเดลขึ้น Cloud ส่วนตัวให้เรียบร้อย จึ้ง!");
  }

  async function saveActiveModelToCloud() {
    if (!activePackage || modelImporting || !isCloudLibraryAllowed(cloudLibrary) || accountRef.current?.capabilities.canUseCloudModels === false) return;
    setModelImporting(true);
    setModelImportProgress({ label: "กำลังเตรียมอัปขึ้น Cloud ส่วนตัว…", percent: null });
    try { await syncModelToCloud(activePackage); }
    catch (error) {
      if (error instanceof CloudModelError && error.code === "TIER_REQUIRED") {
        setModelNotice(CLOUD_TIER_REQUIRED_MESSAGE);
      } else {
        setModelNotice(error instanceof Error ? error.message : "อัปโมเดลขึ้น Cloud ไม่ติดแฮะ ลองใหม่อีกรอบนะ");
      }
    }
    finally { setModelImporting(false); setModelImportProgress(null); }
  }

  async function chooseModel(id: string) {
    if (modelImporting) return;
    stopBackgroundPreload();
    startupModelResolvedRef.current = true;
    setStartupModelPending(false);
    const pack = modelPackages.find((entry) => entry.models.some((model) => model.id === id));
    if (!pack) return;
    setModelSwitchPending(true);
    modelSelectionAbortRef.current?.abort();
    const abort = new AbortController(); modelSelectionAbortRef.current = abort;
    cancelTiming(modelSelectionTimingRef.current);
    modelSelectionTimingRef.current = startTiming("model_select_to_first_frame");
    // Cancel pending render preparation immediately, while retaining its predecessor.
    modelLoadIdRef.current++;
    modelRenderAbortRef.current?.abort();
    setModelNotice("กำลังโหลดไฟล์โมเดล…");
    try {
      const downloaded = await availableModelPackage(pack, cloudLibrary ?? modelCloudRequestRef.current, abort.signal);
      abort.signal.throwIfAborted();
      if (!downloaded) throw new Error("หาไฟล์โมเดลไม่เจอแฮะ");
      if (!downloaded.models.some((model) => model.id === id)) throw new Error("โมเดลนี้ไม่มีอยู่ในชุดไฟล์แล้วอะ ลองจิ้มตัวอื่นดูนะ");
      cacheModelPreviews(downloaded);
      setModelPackages((current) => current.map((entry) => entry.id === pack.id ? downloaded : modelCatalogEntry(entry)));
      setActiveModelId(id);
      writeModelSelection(localStorage, id);
      if (cloudLibrary?.cloudAllowed !== false && cloudLibrary?.models.some((model) => model.id === pack.id)) void saveCloudModelPreference(id).catch(() => {});
      setModelNotice(null);
      setModelPaused(false);
      setModelReload((value) => value + 1);
    } catch (error) {
      if (abort.signal.aborted) return;
      setPendingModelId(null);
      setModelSwitchPending(false);
      cancelTiming(modelSelectionTimingRef.current);
      setModelStatus(modelRef.current ? "ready" : "error");
      setModelNotice(error instanceof Error ? error.message : "โหลดโมเดลไม่ขึ้นแฮะ");
    } finally { if (modelSelectionAbortRef.current === abort) modelSelectionAbortRef.current = null; }
  }

  async function removeActiveModel() {
    if (!activePackage || modelImporting) return;
    stopBackgroundPreload();
    setModelImporting(true);
    try {
      if (cloudLibrary?.cloudAllowed !== false && cloudLibrary?.models.some((model) => model.id === activePackage.id)) {
        await deleteCloudModel(activePackage.id);
        setCloudLibrary((current) => current ? { ...current, models: current.models.filter((model) => model.id !== activePackage.id) } : current);
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
    } catch { setModelNotice("ลบโมเดลยังไม่สำเร็จ ลองกดอีกทีนะ"); }
    finally { setModelImporting(false); }
  }

  function toggleSavedExpression(expression: string) {
    if (!activeModel || !activePackage || !activeModel.expressions.includes(expression)) return;
    const current = activeExpressionModelRef.current === activeModel.id ? activeExpressionsRef.current : [];
    const next = current.includes(expression) ? current.filter((item) => item !== expression) : [...current, expression];
    if (next.length > 128) { setModelNotice("เลือกผสมสีหน้าได้สูงสุด 128 อันต่อโมเดลนะเธอ"); return; }
    saveExpressionSelection(next);
  }

  function saveExpressionSelection(next: string[]) {
    if (!activeModel || !activePackage) return;
    const key = modelExpressionPreferenceKey(activePackage.id, activeModel.manifestPath);
    activeExpressionModelRef.current = activeModel.id;
    activeExpressionsRef.current = next;
    setActiveExpressionsModelId(activeModel.id);
    pendingExpressionPreferencesRef.current.set(key, next);
    setActiveExpressions(next);
    setActiveExpression(null);
    setModelNotice(null);
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* Cloud preference remains available when configured. */ }
    setModelReload((value) => value + 1);

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
        models: currentLibrary.models.map((model) => model.id === activePackage.id
          ? { ...model, expressionPreferences: { ...model.expressionPreferences, [activeModel.manifestPath]: result.expressions } }
          : model),
      };
      cloudLibraryRef.current = updated;
      setCloudLibrary(updated);
    }).catch(() => { if (expressionSaveVersionsRef.current.get(key) === saveVersion) setModelNotice("เซฟสีหน้าไว้ในเครื่องนี้ให้ละ แต่ยังซิงก์ขึ้นคลาวด์ไม่ติดนะ"); });
  }

  function clearSavedExpressions() {
    const selected = activeExpressionModelRef.current === activeModel?.id ? activeExpressionsRef.current : [];
    if (!selected.length) { resetReaction(); return; }
    saveExpressionSelection([]);
  }

  async function selectMotion(motion: ModelMotion | null) {
    const actionId = ++motionActionRef.current;
    const loadId = modelLoadIdRef.current;
    try {
      const manager = modelRef.current?.internalModel?.motionManager;
      if (!manager) return;
      manager.stopAllMotions();
      setModelNotice(null);
      setActiveMotion(motion ? `${motion.group}:${motion.index}` : null);
      if (!motion && modelRestStateRef.current) {
        restoreModelRestState(modelRef.current.internalModel.coreModel, modelRestStateRef.current);
      }
      if (motion) {
        const started = await modelRef.current.motion(motion.group, motion.index, 3);
        if (actionId !== motionActionRef.current || loadId !== modelLoadIdRef.current) return;
        if (!started) throw new Error("Motion unavailable");
      }
    } catch {
      if (actionId === motionActionRef.current && loadId === modelLoadIdRef.current) {
        setActiveMotion(null);
        setModelNotice("ท่าทางนี้เล่นไม่ได้แฮะ");
      }
    }
  }

  useEffect(() => {
    if (!sidebarOpen && !requestModalOpen && !limitModalOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (requestModalOpen) { setRequestModalOpen(false); return; }
      if (limitModalOpen) { setLimitModalOpen(false); return; }
      setPanel(null);
      setSidebarOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [sidebarOpen, requestModalOpen, limitModalOpen]);

  useEffect(() => {
    const today = new Date().toISOString().slice(0, 10);
    const lastCheckIn = window.localStorage.getItem("vivian-checkin-date");
    const previousStreak = Number(window.localStorage.getItem("vivian-streak") ?? 0);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const nextStreak = lastCheckIn === today ? previousStreak : lastCheckIn === yesterday ? previousStreak + 1 : 1;
    if (lastCheckIn !== today) window.localStorage.setItem("vivian-checkin-date", today);
    window.localStorage.setItem("vivian-streak", String(nextStreak));
    queueMicrotask(() => {
      setStreak(nextStreak);
      setPreferencesReady(true);
    });
  }, []);

  useEffect(() => {
    startupTimingRef.current = startTiming("page_load_to_model_first_frame", 0);
    return scheduleBackgroundWork(() => setBackgroundReady(true));
  }, []);

  useEffect(() => {
    const unlock = () => {
      audioUnlockedByUserRef.current = true;
      void unlockAudio();
    };
    window.addEventListener("pointerdown", unlock, { once: true });
    const cancelMemory = scheduleBackgroundWork(() => { void loadMemory(); });
    const onVisible = () => { lastActivityRef.current = Date.now(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelMemory();
      window.removeEventListener("pointerdown", unlock);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  useEffect(() => {
    if (avatarMode === "live2d") return;
    stopBackgroundPreload();
    modelSelectionAbortRef.current?.abort();
    modelRenderAbortRef.current?.abort();
    modelPresentationRef.current?.dispose();
    modelPresentationRef.current = null;
    modelRef.current = null;
    modelRestStateRef.current = null;
    pixiAppRef.current?.destroy(false, { children: true });
    pixiAppRef.current = null;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStartupModelPending(false);
    setModelSwitchPending(false);
  }, [avatarMode]);

  useEffect(() => {
    if (avatarMode !== "live2d" || !preferencesReady || !modelsReady || graphicsLost || modelPaused) return;
    stopBackgroundPreload();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActiveExpression(null);
    setActiveMotion(null);
    if (!activeModel || !activePackage) {
      modelPresentationRef.current?.dispose(); modelPresentationRef.current = null;
      modelRef.current = null; modelRestStateRef.current = null;
      setModelStatus("empty"); setModelSwitchPending(false);
      startupModelResolvedRef.current = true; setStartupModelPending(false); return;
    }
    // Restore this model's saved drag position/zoom before the first frame.
    modelTransformRef.current = loadModelTransform(activeModel.id);
    modelBaseScaleRef.current = 1;
    setModelStatus("loading");
    setTextureSummary(null);
    const textureAbort = new AbortController();
    modelRenderAbortRef.current = textureAbort;
    let releaseResources: (() => void) | undefined;
    const compositeExpressionUrls = new Map<string, string>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let app: any;
    let resizeModel = () => {};
    let queueResize = () => {};
    let handleOrientationChange = () => {};
    let resizeFrame: number | undefined;
    let resizeTimeout: number | undefined;
    let disposed = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let ownedModel: any;
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
    // Normal refresh/navigation is not a WebContent crash.
    window.addEventListener("pagehide", clearRecovery);
    try { sessionStorage.setItem("vivian-model-loading", activeModel.id); } catch { /* Optional crash recovery. */ }
    void (async () => {
      try {
        // Start hydration now so IndexedDB/cloud work overlaps the module
        // download instead of waiting for PIXI to parse first.
        const hydrationPromise = availableModelPackage(activePackage, cloudLibraryRef.current ?? modelCloudRequestRef.current, textureAbort.signal);
        const [[PIXI, { Live2DModel, Cubism4ModelSettings }], , renderPackage] = await Promise.all([
          preloadLive2DModules(),
          waitForCubismCore(textureAbort.signal),
          hydrationPromise,
        ]);
        textureAbort.signal.throwIfAborted();
        if (!canvasRef.current || disposed) return;
        const isAppleMobile = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
        // Keep the 4096 textures intact, but render the canvas above CSS
        // resolution on iPad/iPhone so the model is not visibly soft. The
        // 1.5 cap is a deliberate memory/performance guard for Safari.
        const appleResolution = Math.min(Math.max(window.devicePixelRatio || 1, 1), 1.5);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).PIXI = PIXI;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (Live2DModel as any).registerTicker(PIXI.Ticker);
        app = pixiAppRef.current;
        if (!app) {
          app = new PIXI.Application({
            view: canvasRef.current,
            backgroundAlpha: 0,
            antialias: !isAppleMobile,
            autoDensity: true,
            resolution: isAppleMobile ? appleResolution : Math.min(window.devicePixelRatio || 1, 2),
            powerPreference: isAppleMobile ? "low-power" : "high-performance",
          });
          app.ticker.maxFPS = isAppleMobile ? 30 : 60;
          pixiAppRef.current = app;
        }
        const maxTextureSize = app.renderer.gl.getParameter(app.renderer.gl.MAX_TEXTURE_SIZE) as number;
        canvasRef.current.dataset.gpuTextureLimit = String(maxTextureSize);
        const mobileDevice = isAppleMobile || /Android|Mobile/i.test(navigator.userAgent);
        // Catalog entries deliberately have no assets. Every path into this
        // effect (refresh, deletion, retry or selection) must hydrate first —
        // hydration already ran alongside the module download above.
        if (!renderPackage) throw new Error("หาไฟล์โมเดลในเครื่องไม่เจอแฮะ ลองโหลดจาก Cloud หรือเอาไฟล์โมเดลเข้ามาใหม่อีกรอบนะ");
        cacheModelPreviews(renderPackage);
        if (renderPackage !== activePackage) {
          // Replace stale Blob handles in React too; otherwise every quality
          // change would try the broken in-memory copy and download again.
          setModelPackages((current) => current.map((entry) => entry.id === renderPackage.id ? renderPackage : entry));
          setModelNotice(null);
          return;
        }
        const renderModel = renderPackage.models.find((entry) => entry.id === activeModel.id || entry.manifestPath === activeModel.manifestPath);
        if (!renderModel) throw new Error("ตัวที่เลือกไว้เมื่อกี้เปลี่ยนไปแล้วอะ ลองจิ้มโมเดลใหม่อีกทีนะ");
        const preferenceKey = modelExpressionPreferenceKey(renderPackage.id, renderModel.manifestPath);
        const pendingExpressions = pendingExpressionPreferencesRef.current.get(preferenceKey);
        const cloudModel = cloudLibraryRef.current?.models.find((entry) => entry.id === renderPackage.id);
        const cloudHasPreference = Boolean(cloudModel?.expressionPreferences && Object.prototype.hasOwnProperty.call(cloudModel.expressionPreferences, renderModel.manifestPath));
        let savedExpressions = pendingExpressions ?? (cloudHasPreference ? cloudModel!.expressionPreferences![renderModel.manifestPath] : undefined);
        if (!savedExpressions) {
          try {
            const cached = JSON.parse(localStorage.getItem(preferenceKey) ?? "null");
            if (Array.isArray(cached) && cached.every((name) => typeof name === "string")) savedExpressions = cached;
          } catch { /* Optional local preference cache. */ }
        }
        const selectedExpressions = [...new Set((savedExpressions ?? []).filter((name) => renderModel.expressions.includes(name)))];
        activeExpressionsRef.current = selectedExpressions;
        activeExpressionModelRef.current = renderModel.id;
        setActiveExpressions(selectedExpressions);
        setActiveExpressionsModelId(renderModel.id);
        let shouldApplyStack = false;
        renderTiming = startTiming("model_load_to_first_frame");
        const resources = await createModelResources(renderPackage, renderModel, {
          // GPU limits alone do not account for framebuffers, decoded images,
          // Cubism masks and the rest of the page. Leave room for those too.
          maxDimension: textureQuality === "original" ? Math.min(maxTextureSize, mobileDevice ? 4096 : 8192) : Math.min(maxTextureSize, 4096),
          budgetBytes: (mobileDevice ? 64 : 128) * 1024 * 1024,
          original: textureQuality === "original",
          signal: textureAbort.signal,
        });
        releaseResources = () => {
          resources.dispose();
          for (const url of compositeExpressionUrls.values()) URL.revokeObjectURL(url);
          compositeExpressionUrls.clear();
        };
        if (disposed || loadId !== modelLoadIdRef.current) { releaseResources(); return; }
        let manifest = resources.manifest;
        let resolveModelAsset = resources.resolve;
        if (selectedExpressions.length) {
          const expressionDefinitions = resources.manifest.FileReferences.Expressions ?? [];
          const parameterSets = await loadExpressionParameterSets(expressionDefinitions, resources.resolve);
          const stackSelections = selectedExpressions.filter((name) => parameterSets.has(name));
          if (stackSelections.length !== selectedExpressions.length) setModelNotice("มีบางสีหน้าที่เคยเซฟไว้หาไม่เจอในโมเดลชุดนี้แฮะ");
          const stack = createExpressionStack(parameterSets, stackSelections);
          if (stack) {
            shouldApplyStack = true;
            compositeExpressionUrls.set(SAVED_EXPRESSION_STACK_FILE, URL.createObjectURL(stack));
            const expressions = expressionDefinitions.filter((item) => item.Name !== SAVED_EXPRESSION_STACK_NAME);
            const emotionStackNames = new Map<string, string>();
            const emotionDefinitions: Array<{ Name: string; File: string }> = [];
            for (const [index, definition] of expressionDefinitions.entries()) {
              if (stackSelections.includes(definition.Name)) {
                emotionStackNames.set(definition.Name, SAVED_EXPRESSION_STACK_NAME);
                continue;
              }
              const combined = createExpressionStack(parameterSets, [...stackSelections, definition.Name]);
              if (!combined) continue;
              const name = `__VivianSavedEmotionStack${index}__`;
              const file = `__vivian_saved_emotion_stack_${index}.exp3.json`;
              compositeExpressionUrls.set(file, URL.createObjectURL(combined));
              emotionDefinitions.push({ Name: name, File: file });
              emotionStackNames.set(definition.Name, name);
            }
            emotionStackNames.set(SAVED_EXPRESSION_STACK_NAME, SAVED_EXPRESSION_STACK_NAME);
            aiExpressionStacksRef.current.set(renderModel.id, emotionStackNames);
            manifest = { ...resources.manifest, FileReferences: { ...resources.manifest.FileReferences, Expressions: [...expressions, { Name: SAVED_EXPRESSION_STACK_NAME, File: SAVED_EXPRESSION_STACK_FILE }, ...emotionDefinitions] } };
            resolveModelAsset = (reference) => compositeExpressionUrls.get(reference) ?? resources.resolve(reference);
          } else {
            setModelNotice("เอาสีหน้าที่เซฟไว้มาผสมกันไม่สำเร็จอะ");
            aiExpressionStacksRef.current.delete(renderModel.id);
          }
        } else {
          aiExpressionStacksRef.current.delete(renderModel.id);
        }
        const settings = new Cubism4ModelSettings(manifest);
        settings.resolveURL = resolveModelAsset;
        const model = await Live2DModel.from(settings, { autoInteract: false });
        ownedModel = model;
        if (disposed || loadId !== modelLoadIdRef.current) {
          model.destroy({ children: true, texture: true, baseTexture: true });
          ownedModel = undefined;
          releaseResources();
          return;
        }
        if (shouldApplyStack && !await model.expression(SAVED_EXPRESSION_STACK_NAME)) setModelNotice("ใส่สีหน้าที่เซฟไว้ให้โมเดลนี้ไม่ติดแฮะ");
        if (canvasRef.current) {
          const stopWind = attachModelWind(canvasRef.current, model.internalModel as unknown as WindInternalModel);
          model.once("destroy", stopWind);
        }
        for (const texture of model.textures) {
          if (!texture.valid) throw new Error("รูปภาพของโมเดลโหลดไม่ครบอะ กดโหลดโมเดลใหม่อีกทีนะ");
          texture.baseTexture.mipmap = PIXI.MIPMAP_MODES.OFF;
          texture.baseTexture.wrapMode = PIXI.WRAP_MODES.CLAMP;
        }
        const restState = captureModelRestState(model.internalModel.coreModel as CubismRestModel);
        if (resources.texturePlan.some((plan) => plan.source.width !== plan.render.width || plan.source.height !== plan.render.height)) {
          const source = Math.max(...resources.texturePlan.flatMap((plan) => [plan.source.width, plan.source.height]));
          const render = Math.max(...resources.texturePlan.flatMap((plan) => [plan.render.width, plan.render.height]));
          setTextureSummary(`แสดงผล ${render.toLocaleString()}px (ต้นฉบับ ${source.toLocaleString()}px)`);
        }
        const bounds = model.getLocalBounds();
        resizeModel = () => {
          const stage = canvasRef.current?.parentElement?.getBoundingClientRect();
          if (!stage) return;
          const width = Math.max(1, Math.round(stage.width));
          const height = Math.max(1, Math.round(stage.height));
          app.renderer.resolution = isAppleMobile ? appleResolution : Math.min(window.devicePixelRatio || 1, 2);
          app.renderer.resize(width, height);
          const baseScale = Math.min((width * (width > height ? .43 : .88)) / bounds.width, ((height - Math.min(124, height * .15)) * .88) / bounds.height);
          modelBaseScaleRef.current = baseScale;
          const transform = clampModelTransform(modelTransformRef.current, width, height);
          modelTransformRef.current = transform;
          model.scale.set(baseScale * transform.scale);
          // Models from different artists use different local origins. Pivot
          // from their measured bounds so none of them can land off-canvas.
          model.anchor.set(0, 0);
          model.pivot.set(bounds.x + bounds.width / 2, bounds.y + bounds.height);
          model.x = width / 2 + transform.x;
          model.y = height * .99 + transform.y;
        };
        app.stage.addChild(model);
        queueResize = () => {
          if (resizeFrame) cancelAnimationFrame(resizeFrame);
          if (resizeTimeout) window.clearTimeout(resizeTimeout);
          resizeFrame = requestAnimationFrame(() => requestAnimationFrame(resizeModel));
          resizeTimeout = window.setTimeout(resizeModel, 240);
        };
        handleOrientationChange = () => {
          queueResize();
        };
        queueResize();
        // If the artist did not supply a thumbnail, capture the rendered model.
        resizeModel();
        textureAbort.signal.throwIfAborted();
        if (loadId !== modelLoadIdRef.current) throw new DOMException("Superseded model", "AbortError");
        const previous = modelPresentationRef.current;
        if (previous) previous.model.visible = false;
        try { app.renderer.render(app.stage); }
        catch (error) { if (previous) previous.model.visible = true; throw error; }
        if (app.renderer.gl.isContextLost()) throw new Error("หน่วยความจำภาพของเครื่องเต็มอะ ลองเปลี่ยนความชัดเป็น 'ออโต้' แล้วโหลดโมเดลใหม่ดูนะ");
        modelRef.current = model;
        modelRestStateRef.current = restState;
        modelPresentationRef.current = { model, dispose: () => {
          if (resizeFrame) cancelAnimationFrame(resizeFrame);
          if (resizeTimeout) window.clearTimeout(resizeTimeout);
          window.removeEventListener("resize", queueResize);
          window.removeEventListener("orientationchange", handleOrientationChange);
          window.visualViewport?.removeEventListener("resize", queueResize);
          app.stage.removeChild(model);
          model.destroy({ children: true, texture: true, baseTexture: true });
          releaseResources?.();
        } };
        promoted = true;
        previous?.dispose();
        finishTiming(renderTiming);
        finishTiming(modelSelectionTimingRef.current);
        finishTiming(startupTimingRef.current);
        window.dispatchEvent(new Event("vivian-model-first-frame"));
        setModelStatus("ready");
        setModelSwitchPending(false);
        startupModelResolvedRef.current = true;
        setStartupModelPending(false);
        clearRecovery();
        // Thumbnail for Character cards: supplied previews win, otherwise
        // snapshot the live render once. Capture the model tight (a stage
        // target renders to a RenderTexture synchronously — the reliable
        // path on iOS, where full-frame readbacks come back black) and crop
        // to the top so the face stays visible. Fire-and-forget so the
        // first frame is never delayed by thumbnail work.
        if (!renderModel.previewPath) {
          void (async () => {
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const Extract = (PIXI as any).Extract;
              if (!Extract) return;
              const extract = new Extract(app.renderer);
              const frame = extract.canvas(app.stage) as HTMLCanvasElement | undefined;
              if (!frame) return;
              const crop = faceCrop(
                { x: 0, y: 0, width: frame.width, height: frame.height },
                frame.width,
                frame.height,
              );
              const blob = await snapshotToBlob(frame, 360, 0.72, crop ?? undefined);
              if (!blob) return;
              if (disposed || loadId !== modelLoadIdRef.current) return;
              cacheSnapshotPreview(renderModel.id, blob);
            } catch { /* Card keeps its pink name fallback. */ }
          })();
        }
        window.addEventListener("resize", queueResize);
        window.addEventListener("orientationchange", handleOrientationChange);
        window.visualViewport?.addEventListener("resize", queueResize);
      } catch (error) {
        clearRecovery();
        cancelTiming(renderTiming);
        if (!disposed && loadId === modelLoadIdRef.current) cancelTiming(modelSelectionTimingRef.current);
        if (modelPresentationRef.current && !promoted) {
          modelPresentationRef.current.model.visible = true;
          if (!app?.renderer.gl.isContextLost()) app?.renderer.render(app.stage);
        }
        if (ownedModel && !promoted) {
          app?.stage.removeChild(ownedModel);
          ownedModel.destroy({ children: true, texture: true, baseTexture: true });
          if (modelRef.current === ownedModel) { modelRef.current = null; modelRestStateRef.current = null; }
          ownedModel = undefined;
        }
        if (!disposed && loadId === modelLoadIdRef.current) {
          console.error("Live2D failed to load", error);
          setModelStatus("error");
          startupModelResolvedRef.current = true;
          setStartupModelPending(false);
          setModelSwitchPending(false);
          setModelNotice(error instanceof Error ? error.message : "เปิดโมเดลนี้ไม่ขึ้นแฮะ ลองเช็กดูนะว่าเป็น Live2D Cubism 4 และไฟล์ครบหรือเปล่า");
        }
        if (!promoted) releaseResources?.();
      }
    })();
    return () => {
      disposed = true;
      textureAbort.abort();
      if (modelRenderAbortRef.current === textureAbort) modelRenderAbortRef.current = null;
      clearBreadcrumb();
      modelLoadIdRef.current += 1;
      window.removeEventListener("pagehide", clearRecovery);
      if (!promoted) {
        if (resizeFrame) cancelAnimationFrame(resizeFrame);
        if (resizeTimeout) window.clearTimeout(resizeTimeout);
        window.removeEventListener("resize", queueResize);
        window.removeEventListener("orientationchange", handleOrientationChange);
        window.visualViewport?.removeEventListener("resize", queueResize);
      }
      cancelTiming(renderTiming);
      // A promoted model belongs to the stage until its replacement has rendered.
      // Pending candidates still release all textures/URLs when superseded.
      if (!promoted) {
        if (ownedModel && app) {
          app.stage.removeChild(ownedModel);
          ownedModel.destroy({ children: true, texture: true, baseTexture: true });
        }
        ownedModel = undefined;
        releaseResources?.();
      }
    };
  }, [avatarMode, preferencesReady, modelsReady, activeModel, activePackage, cloudLibrary, textureQuality, modelReload, graphicsLost, modelPaused]);

  useEffect(() => {
    if (avatarMode !== "live2d") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const lost = (event: Event) => {
      event.preventDefault(); // Allow the browser to restore this context.
      pixiAppRef.current?.stop();
      setGraphicsLost(true);
      setModelStatus("error");
      setModelNotice("ระบบภาพของเครื่องสะดุดไปแป๊บ เดี๋ยวพอหายแล้ววิเวียนโหลดโมเดลให้ใหม่นะ");
    };
    const restored = () => {
      pixiAppRef.current?.start();
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
  }, [avatarMode]);

  useEffect(() => {
    if (avatarMode !== "live2d") return;
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
      const stage = canvas.parentElement?.getBoundingClientRect();
      return { width: Math.max(0, stage?.width ?? 0), height: Math.max(0, stage?.height ?? 0) };
    };

    const apply = () => {
      const model = modelRef.current;
      if (!model) return;
      const { width, height } = stageSize();
      if (!width || !height) return;
      modelTransformRef.current = clampModelTransform(modelTransformRef.current, width, height);
      model.x = width / 2 + modelTransformRef.current.x;
      model.y = height * 0.99 + modelTransformRef.current.y;
      model.scale.set((modelBaseScaleRef.current || 1) * modelTransformRef.current.scale);
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

    const onPointerDown = (event: PointerEvent) => {
      if (!modelRef.current) return;
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch {
        /* Pointer capture is best-effort. */
      }
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.size === 1) {
        dragStart = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, offsetX: modelTransformRef.current.x, offsetY: modelTransformRef.current.y };
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
      if (!modelRef.current || !pointers.has(event.pointerId)) return;
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
      try {
        canvas.releasePointerCapture?.(event.pointerId);
      } catch {
        /* Already released when the gesture ended. */
      }
      if (pointers.size === 0) {
        if (wasDrag) persist();
        // Double-tap reset for touch (dblclick covers mouse).
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
        dragStart = { pointerId: id, x: pos.x, y: pos.y, offsetX: modelTransformRef.current.x, offsetY: modelTransformRef.current.y };
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
      if (!modelRef.current) return;
      event.preventDefault();
      const zoom = Math.exp(-event.deltaY * 0.0012 * (event.ctrlKey || event.metaKey ? 1.6 : 1));
      modelTransformRef.current.scale *= zoom;
      const { width, height } = stageSize();
      modelTransformRef.current = clampModelTransform(modelTransformRef.current, width, height);
      apply();
      // Wheel fires many times per gesture; debounce the write.
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
    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("dblclick", onDoubleClick);
      canvas.removeEventListener("wheel", onWheel);
      canvas.style.cursor = "";
      pointers.clear();
      if (wheelPersistTimer !== undefined) window.clearTimeout(wheelPersistTimer);
    };
  }, [avatarMode]);

  useEffect(() => () => {
    modelSelectionAbortRef.current?.abort();
    cancelTiming(modelSelectionTimingRef.current); cancelTiming(startupTimingRef.current);
    modelPresentationRef.current?.dispose(); modelPresentationRef.current = null;
    modelRef.current = null; modelRestStateRef.current = null;
    // React owns this canvas; removing it breaks effect replay/remounting.
    pixiAppRef.current?.destroy(false, { children: true });
    pixiAppRef.current = null;
  }, []);

  useEffect(() => () => {
    micEnabledRef.current = false;
    stopRecording();
    scribeRef.current?.stop();
    scribeRef.current = null;
    pcmCaptureRef.current?.stop();
    pcmCaptureRef.current = null;
    if (sttClearTimerRef.current !== null) { window.clearTimeout(sttClearTimerRef.current); sttClearTimerRef.current = null; }
    chatStreamAbortRef.current?.abort();
    chatStreamAbortRef.current = null;
    audioStreamingRef.current?.dispose();
    audioStreamingRef.current = null;
    if (kineticLoopRef.current !== null) { cancelAnimationFrame(kineticLoopRef.current); kineticLoopRef.current = null; }
  }, []);

  async function loadMemory() {
    if (resettingRef.current) return;
    const generation = memoryGenerationRef.current;
    try {
      const response = await authFetch("/api/memory", { cache: "no-store" });
      const data = await response.json();
      if (generation !== memoryGenerationRef.current || resettingRef.current) return;
      if (Array.isArray(data.memories)) setMemories(data.memories);
      if (typeof data.memorySummary === "string") setMemorySummary(data.memorySummary);
      const next = normalizeCompanion(data.companion);
      if (next) setCompanion(next);
    } catch { /* Vivian stays usable while Supabase is unavailable. */ }
  }
  function normalizeCompanion(raw: unknown): CompanionState | null {
    if (!raw || typeof raw !== "object") return null;
    const item = raw as Record<string, unknown>;
    const mood = String(item.mood ?? "calm");
    return decayCompanionState({
      affinity: Number(item.affinity ?? 22),
      trust: Number(item.trust ?? 18),
      familiarity: Number(item.familiarity ?? 8),
      mood: normalizeMood(mood),
      moodIntensity: Number(item.moodIntensity ?? item.mood_intensity ?? 35),
      conversationSummary: String(item.conversationSummary ?? item.conversation_summary ?? ""),
      lastIdleAt: typeof item.lastIdleAt === "string" ? item.lastIdleAt : typeof item.last_idle_at === "string" ? item.last_idle_at : null,
      lastInteractionAt: typeof item.lastInteractionAt === "string" ? item.lastInteractionAt : typeof item.last_interaction_at === "string" ? item.last_interaction_at : null,
    });
  }
  function markActivity() {
    lastActivityRef.current = Date.now();
  }
  function clearUserKinetic() {
    if (sttClearTimerRef.current !== null) { window.clearTimeout(sttClearTimerRef.current); sttClearTimerRef.current = null; }
    sttSync.reset();
    userKinetic.clear();
  }
  /** Streams the live microphone to Scribe v3 Live; any failure leaves the batch STT path in charge. */
  function startRealtimeStt(stream: MediaStream, generation: number) {
    clearUserKinetic();
    sttSync.setLanguage(speechLanguageRef.current);
    const client = new ScribeRealtimeClient({
      language: speechLanguageRef.current,
      fetchToken: async () => {
        const response = await authFetch("/api/stt/token", { method: "POST", signal: abortAfter(8000) });
        const data = await response.json().catch(() => null) as { token?: string } | null;
        if (!response.ok || !data?.token) throw new Error("Scribe token unavailable");
        return data.token;
      },
      callbacks: {
        onPartial: (text) => { if (generation !== memoryGenerationRef.current) return; sttSync.partial(text); userKinetic.set(sttSync.frame()); },
        onCommitted: (text) => { if (generation !== memoryGenerationRef.current) return; sttSync.commit(text); userKinetic.set(sttSync.frame()); },
        onWords: (words, text) => { if (generation !== memoryGenerationRef.current) return; if (sttSync.commit(text, words)) userKinetic.set(sttSync.frame()); },
      },
    });
    scribeRef.current = client;
    client.start();
    void startPcmCapture(stream, (pcm) => client.sendAudio(pcm)).then((capture) => {
      if (scribeRef.current === client && recordingRef.current) pcmCaptureRef.current = capture;
      else capture.stop();
    }).catch((error) => { console.warn("Realtime capture unavailable; using batch STT", error); client.stop(); if (scribeRef.current === client) scribeRef.current = null; });
  }
  function stopKinetic() {
    if (kineticLoopRef.current !== null) { cancelAnimationFrame(kineticLoopRef.current); kineticLoopRef.current = null; }
    ttsSync.interrupt();
    ttsTracker.reset();
    vivianKinetic.clear();
    setKineticActive(false);
  }
  function startKineticLoop(streamer: AudioStreamingManager) {
    if (kineticLoopRef.current !== null) cancelAnimationFrame(kineticLoopRef.current);
    const tick = () => {
      kineticLoopRef.current = null;
      if (ttsSync.currentTurnId === null) return;
      const position = streamer.getPlaybackPositionSec();
      if (ttsSync.isEnded && ttsSync.wordCount === 0) return;
      if (ttsSync.isFinished(position)) {
        // Hold the final words in their settled (past) state.
        vivianKinetic.set(ttsSync.frame(Number.MAX_SAFE_INTEGER).map((word) => ({ ...word, state: "past" as const })));
        return;
      }
      const frame = ttsSync.frame(position);
      vivianKinetic.set(frame);
      if (frame.length) setKineticActive(true);
      kineticLoopRef.current = requestAnimationFrame(tick);
    };
    kineticLoopRef.current = requestAnimationFrame(tick);
  }
  function stopSpeech() {
    stopKinetic();
    speakIdRef.current += 1;
    userInterruptedRef.current = true;
    chatStreamAbortRef.current?.abort();
    chatStreamAbortRef.current = null;
    audioStreamingRef.current?.interrupt();
    ttsAbortRef.current?.abort();
    ttsAbortRef.current = null;
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
    speakingRef.current = false;
    setSpeaking(false);
    stopLipSync();
    resetReaction();
  }
  function unlockAudio(): Promise<void> {
    const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return Promise.resolve();
    audioContextRef.current ??= new AudioContextClass();
    if (audioPrimedRef.current && audioContextRef.current.state === "running") return Promise.resolve();
    if (audioUnlockPromiseRef.current) return withTimeout(audioUnlockPromiseRef.current, AUDIO_UNLOCK_MS, undefined);
    const context = audioContextRef.current;
    const audio = audioRef.current ?? new Audio();
    audio.setAttribute("playsinline", "true");
    audio.preload = "auto";
    if (!audio.src) audio.src = SILENT_WAV;
    audio.muted = true;
    audioRef.current = audio;
    const unlock = (async () => {
      if (context.state !== "running") await withTimeout(context.resume().then(() => undefined), 800, undefined);
      try {
        await withTimeout(audio.play().then(() => undefined), AUDIO_UNLOCK_MS, undefined);
        audio.pause();
        audio.currentTime = 0;
      } catch { /* Safari may reject empty or delayed unlock; chat must still continue. */ }
      audio.muted = false;
      audioPrimedRef.current = true;
    })();
    audioUnlockPromiseRef.current = unlock.finally(() => { audioUnlockPromiseRef.current = null; });
    return audioUnlockPromiseRef.current;
  }
  function startStreamingLipSync() {
    const streamer = audioStreamingRef.current;
    const analyser = streamer?.getAnalyser();
    if (!streamer || !analyser) return;
    stopLipSync();
    const samples = new Uint8Array(analyser.fftSize);
    const spectrum = new Uint8Array(analyser.frequencyBinCount);
    const apple = usesNativeAppleAudio();
    let smoothed = 0;
    let silentFrames = 0;
    const startedAt = performance.now();
    const update = () => {
      if (!streamer.isPlaying() && !speakingRef.current) { setMouthOpen(0); lipSyncFrameRef.current = null; return; }
      analyser.getByteTimeDomainData(samples);
      analyser.getByteFrequencyData(spectrum);
      let rms = 0;
      for (const sample of samples) { const delta = (sample - 128) / 128; rms += delta * delta; }
      rms = Math.sqrt(rms / samples.length);
      let energy = 0;
      for (let index = 1; index < spectrum.length; index += 1) energy += spectrum[index];
      const spectralLevel = spectrum.length > 1 ? energy / ((spectrum.length - 1) * 255) : 0;
      const level = Math.min(1, rms * 4.8 + spectralLevel * 1.8);
      let target: number;
      if (level > 0.002) {
        silentFrames = 0;
        target = Math.max(0, Math.min(.9, Math.pow(level, .72)));
      } else if (apple && ++silentFrames > 10) {
        const elapsed = (performance.now() - startedAt) / 1000;
        target = Math.min(.62, .08 + (Math.sin(elapsed * 17) * .5 + .5) * .34 + (Math.sin(elapsed * 31) * .5 + .5) * .12);
      } else {
        target = 0;
      }
      smoothed += (target - smoothed) * (target > smoothed ? .5 : .18);
      setMouthOpen(smoothed);
      lipSyncFrameRef.current = requestAnimationFrame(update);
    };
    lipSyncFrameRef.current = requestAnimationFrame(update);
  }
  function getAudioStreamer(): AudioStreamingManager {
    if (!audioStreamingRef.current) {
      audioStreamingRef.current = new AudioStreamingManager({
        onPlaybackStart: () => {
          speakingRef.current = true;
          setSpeaking(true);
          startStreamingLipSync();
        },
        onPlaybackEnd: () => {
          speakingRef.current = false;
          setSpeaking(false);
          stopLipSync();
        },
        onInterrupt: () => {
          speakingRef.current = false;
          setSpeaking(false);
          stopLipSync();
        },
        onError: (_turnId, error, audioStarted) => {
          if (!audioStarted) {
            speakingRef.current = false;
            setSpeaking(false);
            stopLipSync();
            console.warn("Streaming TTS unavailable; falling back", error.message);
          } else {
            console.warn("Streaming TTS ended early", error.message);
          }
        },
      });
    }
    if (audioContextRef.current) {
      audioStreamingRef.current.setContext(audioContextRef.current as unknown as AudioContextLike);
    }
    return audioStreamingRef.current;
  }
  function setMouthOpen(value: number) {
    const mouth = Math.max(0, Math.min(1, value));
    if (avatarModeRef.current === "3d") {
      avatar3d.setMouthOpen(mouth);
      return;
    }
    const coreModel = modelRef.current?.internalModel?.coreModel;
    if (!coreModel) return;
    try {
      coreModel.setParameterValueById("ParamMouthOpenY", mouth);
      // Some Cubism models expose mouth shape separately. It is optional, so
      // keep this best-effort and preserve compatibility with older models.
      try { coreModel.setParameterValueById("ParamMouthForm", (mouth - .5) * .18); } catch { /* optional parameter */ }
    } catch (error) { console.warn("Live2D mouth parameter unavailable", error); }
  }
  function resetReaction() {
    expressionActionRef.current += 1;
    setActiveExpression(null);
    if (avatarModeRef.current === "3d") {
      avatar3d.clearReaction();
      return;
    }
    const expressionManager = modelRef.current?.internalModel?.motionManager?.expressionManager;
    try {
      if (expressionManager) {
        // Cubism's resetExpression only resets playback. Clear its selection and
        // pending load too, so the same expression can be enabled again.
        expressionManager.reserveExpressionIndex = -1;
        expressionManager.currentExpression = expressionManager.defaultExpression;
        expressionManager.resetExpression();
      }
    } catch (error) { console.warn("Live2D default expression unavailable", error); }
    const saved = activeExpressionModelRef.current === activeModelIdRef.current ? activeExpressionsRef.current : [];
    const hasSavedStack = activeModelIdRef.current ? aiExpressionStacksRef.current.get(activeModelIdRef.current)?.has(SAVED_EXPRESSION_STACK_NAME) : false;
    if (saved.length && hasSavedStack) void modelRef.current?.expression(SAVED_EXPRESSION_STACK_NAME).catch((error: unknown) => console.warn("Saved Live2D expressions unavailable", error));
  }
  function stopLipSync() {
    if (lipSyncFrameRef.current !== null) cancelAnimationFrame(lipSyncFrameRef.current);
    lipSyncFrameRef.current = null;
    setMouthOpen(0);
  }
  function usesNativeAppleAudio() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  }
  function startNativeLipSync(audio: HTMLAudioElement) {
    // Do not route an iOS media element through AudioContext. Safari can show
    // playback in Dynamic Island while that routed output is silent. Native
    // playback is reliable; this keeps a lightweight visual mouth movement.
    stopLipSync();
    let smoothed = 0;
    let previousTime = audio.currentTime;
    const update = () => {
      if (audio.paused || audio.ended) { setMouthOpen(0); lipSyncFrameRef.current = null; return; }
      // iOS Safari must stay on native playback, so there is no safe analyser
      // stream here. Use playback-time pulses with attack/release smoothing;
      // this avoids the old harsh, constant jaw oscillation while keeping the
      // mouth moving in sync with the spoken audio.
      const delta = Math.max(0, audio.currentTime - previousTime);
      previousTime = audio.currentTime;
      const pulse = .08 + (Math.sin(audio.currentTime * 17) * .5 + .5) * .34 + (Math.sin(audio.currentTime * 31) * .5 + .5) * .12;
      const target = delta > .12 ? 0 : Math.min(.62, pulse);
      smoothed += (target - smoothed) * (target > smoothed ? .42 : .2);
      setMouthOpen(smoothed);
      lipSyncFrameRef.current = requestAnimationFrame(update);
    };
    lipSyncFrameRef.current = requestAnimationFrame(update);
  }
  function startLipSync(audio: HTMLAudioElement) {
    if (usesNativeAppleAudio()) { startNativeLipSync(audio); return; }
    const context = audioContextRef.current;
    if (!context) return;
    stopLipSync();
    const analyser = analyserRef.current ?? context.createAnalyser();
    if (!analyserRef.current) {
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = .72;
      analyserRef.current = analyser;
    }
    if (!mediaSourceRef.current) {
      const source = context.createMediaElementSource(audio);
      source.connect(analyser);
      analyser.connect(context.destination);
      mediaSourceRef.current = source;
    }
    const samples = new Uint8Array(analyser.fftSize);
    const spectrum = new Uint8Array(analyser.frequencyBinCount);
    let smoothed = 0;
    const update = () => {
      if (audio.paused || audio.ended) { setMouthOpen(0); lipSyncFrameRef.current = null; return; }
      analyser.getByteTimeDomainData(samples);
      analyser.getByteFrequencyData(spectrum);
      let rms = 0;
      for (const sample of samples) { const delta = (sample - 128) / 128; rms += delta * delta; }
      rms = Math.sqrt(rms / samples.length);
      let energy = 0;
      for (let index = 1; index < spectrum.length; index += 1) energy += spectrum[index];
      const spectralLevel = spectrum.length > 1 ? energy / ((spectrum.length - 1) * 255) : 0;
      const level = Math.min(1, rms * 4.8 + spectralLevel * 1.8);
      const target = Math.max(0, Math.min(.9, Math.pow(level, .72)));
      smoothed += (target - smoothed) * (target > smoothed ? .5 : .18);
      setMouthOpen(smoothed);
      lipSyncFrameRef.current = requestAnimationFrame(update);
    };
    lipSyncFrameRef.current = requestAnimationFrame(update);
  }
  async function speak(text: string, replyTiming?: LocalTiming): Promise<boolean> {
    if (mutedRef.current) { cancelTiming(replyTiming); return false; }
    const speakId = ++speakIdRef.current;
    const abort = new AbortController();
    ttsAbortRef.current = abort;
    speakingRef.current = true;
    setSpeaking(true);
    const timeout = window.setTimeout(() => abort.abort(), TTS_TIMEOUT_MS);
    let objectUrl: string | null = null;
    const ttsTiming = startTiming("tts_request_to_audio_start");
    const downloadTiming = startTiming("tts_request_to_audio_ready");
    let playbackTiming: LocalTiming | undefined;
    try {
      // Audio unlocking and provider generation are independent. Playback still
      // waits for unlocking before using the shared Safari audio element.
      const [ready] = await Promise.all([
        authFetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json" }, signal: abort.signal, body: JSON.stringify({ text, voiceId: voiceIdRef.current, language: speechLanguageRef.current }) }).then(async (response) => {
          const blob = response.ok ? await withTimeout(response.blob(), TTS_TIMEOUT_MS, null) : null;
          if (blob?.size && speakId === speakIdRef.current) {
            finishTiming(downloadTiming, { serverTiming: response.headers.get("server-timing") ?? "unavailable" });
            playbackTiming = startTiming("audio_ready_to_playback");
          }
          return { response, blob };
        }),
        withTimeout(unlockAudio(), AUDIO_UNLOCK_MS, undefined),
      ]);
      const { response, blob } = ready;
      if (speakId !== speakIdRef.current) return false;
      if (!response.ok) {
        const error = await response.json().catch(() => null) as { error?: string; code?: string } | null;
        throw new Error(error?.code ?? error?.error ?? "TTS failed");
      }
      if (!blob || blob.size === 0) throw new Error("TTS failed");
      const audio = audioRef.current ?? new Audio();
      audioRef.current?.pause();
      if (audioRef.current?.src) audioRef.current.removeAttribute("src");
      objectUrl = URL.createObjectURL(blob);
      audio.src = objectUrl;
      audio.setAttribute("playsinline", "true");
      audio.muted = false;
      audio.defaultMuted = false;
      audio.volume = 1;
      audio.onended = () => {
        if (speakId === speakIdRef.current) { speakingRef.current = false; setSpeaking(false); }
        stopLipSync();
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      };
      audio.onerror = () => {
        if (speakId === speakIdRef.current) { speakingRef.current = false; setSpeaking(false); }
        stopLipSync();
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      };
      audioRef.current = audio;
      const started = await withTimeout(audio.play().then(() => true), PLAYBACK_START_MS, false);
      if (speakId !== speakIdRef.current) return false;
      if (!started) {
        stopLipSync();
        throw new Error("TTS playback did not start");
      }
      finishTiming(ttsTiming); finishTiming(replyTiming); finishTiming(playbackTiming);
      // Start the animation only after playback begins. Starting it before
      // audio.play() lets the first frame see `paused` and permanently stop.
      startLipSync(audio);
      await new Promise<void>((resolve) => window.setTimeout(resolve, AUDIO_SYNC_SETTLE_MS));
      return speakId === speakIdRef.current;
    } catch (error) {
      if (speakId === speakIdRef.current) {
        speakingRef.current = false;
        setSpeaking(false);
        if ((error as { name?: string }).name !== "AbortError") {
          resetReaction();
          console.error("TTS unavailable", error);
        }
      }
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      return false;
    } finally {
      cancelTiming(ttsTiming); cancelTiming(replyTiming); cancelTiming(downloadTiming); cancelTiming(playbackTiming);
      window.clearTimeout(timeout);
      if (ttsAbortRef.current === abort) ttsAbortRef.current = null;
    }
  }
  function handleChatQuotaReached(
    tier: TierKey,
    nextQuota?: AccountChatQuota,
    unsentText?: string,
    restoreDraft = false,
    removeUserMessageId?: string,
  ) {
    if (nextQuota) {
      setAccount((prev) => (prev ? { ...prev, chatQuota: nextQuota } : prev));
    } else {
      setAccount((prev) =>
        prev
          ? { ...prev, chatQuota: { ...prev.chatQuota, allowed: false, remaining: 0 } }
          : prev,
      );
    }
    setErrorNotice(null);
    resetReaction();
    const vivianReply = vivianQuotaExceededReply(tier);
    setMessages((current) => [
      ...(removeUserMessageId ? current.filter((item) => item.id !== removeUserMessageId) : current),
      historyMessage("vivian", vivianReply),
    ]);
    if (restoreDraft && unsentText) {
      setMessage(unsentText);
    }
    setLimitModalOpen(true);
    void playReaction(vivianReply, unsentText ?? "", false);
  }
  async function sendMessage(overrideText?: string, options: { image?: string } = {}) {
    const text = (overrideText ?? message).trim();
    let imageToSend = options.image ?? attachedImage;
    if (cameraActiveRef.current) {
      const liveFrame = captureCurrentFrame();
      if (liveFrame) {
        imageToSend = liveFrame;
      }
    }
    if (sendingRef.current || resettingRef.current || !history.ready) return;
    if (!text && !imageToSend) return;
    if (text && await handleExpressionCommand(text)) {
      setMessage("");
      setAttachedImage(null);
      markActivity();
      return;
    }
    const currentAccount = accountRef.current;
    if (currentAccount && currentAccount.tier !== "sorachan" && isQuotaDepleted(currentAccount.chatQuota)) {
      handleChatQuotaReached(currentAccount.tier, currentAccount.chatQuota, text, overrideText === undefined);
      return;
    }
    if (speakingRef.current) stopSpeech();
    userInterruptedRef.current = false;
    markActivity();
    interactedRef.current = true;
    const displayText = text || (imageToSend ? "[ส่งรูป]" : "");
    const userMessage = historyMessage("me", displayText);
    const nextMessages = [...messagesRef.current, userMessage];
    setMessages(nextMessages);
    setMessage("");
    setAttachedImage(null);
    setSending(true);
    sendingRef.current = true;
    const sceneGeneration = sceneLibrary.getGeneration();
    const replyMessageId = crypto.randomUUID();
    const requestConversationId = activeConversationRef.current;
    const firstTokenTiming = startTiming("send_to_first_token");
    const replyTiming = startTiming("send_to_reply");
    const shouldStreamAudio = !mutedRef.current;
    const turnId = crypto.randomUUID();
    stopKinetic();
    setKineticReplyId(replyMessageId);
    const chatAbort = new AbortController();
    chatStreamAbortRef.current = chatAbort;
    let streamWatchdog: number | undefined;
    const armWatchdog = (ms: number) => {
      if (streamWatchdog !== undefined) window.clearTimeout(streamWatchdog);
      streamWatchdog = window.setTimeout(() => chatAbort.abort(), ms);
    };
    armWatchdog(CHAT_TIMEOUT_MS);

    let streamer: AudioStreamingManager | null = null;
    if (shouldStreamAudio) {
      void unlockAudio();
      streamer = getAudioStreamer();
      streamer.startTurn(turnId, audioContextRef.current as unknown as AudioContextLike | null);
      ttsSync.startTurn(turnId);
      ttsTracker.reset();
      ttsTracker.setLanguage(speechLanguageRef.current);
      startKineticLoop(streamer);
    }

    type ChatPayload = {
      scene?: SceneDecision;
      text?: string;
      error?: string;
      code?: string;
      requiredTier?: TierKey;
      quota?: AccountChatQuota;
      chatQuota?: AccountChatQuota;
      memories?: Memory[];
      companion?: CompanionState;
    };
    let resolveReply!: (value: { data: ChatPayload; ok: boolean }) => void;
    let rejectReply!: (reason: unknown) => void;
    let replySettled = false;
    const replyPromise = new Promise<{ data: ChatPayload; ok: boolean }>((resolve, reject) => {
      resolveReply = (value) => { if (!replySettled) { replySettled = true; resolve(value); } };
      rejectReply = (reason) => { if (!replySettled) { replySettled = true; reject(reason); } };
    });

    try {
      const response = await authFetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
        signal: chatAbort.signal,
        body: JSON.stringify({
          mode: "chat",
          conversationId: requestConversationId,
          conversationCreate: !history.isCloudConversation(requestConversationId),
          conversationTitle: conversations.find((item) => item.id === requestConversationId)?.title ?? (text.slice(0, 42) || "Daily Talk"),
          userMessageId: userMessage.id,
          assistantMessageId: replyMessageId,
          messages: nextMessages.map((item) => ({ role: item.from === "me" ? "user" : "assistant", content: item.text })),
          image: imageToSend ?? undefined,
          character: selectedModel,
          language: speechLanguageRef.current,
          streamAudio: shouldStreamAudio,
          voiceId: voiceIdRef.current,
          turnId,
          userProfile: typeof userProfileRef !== "undefined" ? userProfileRef.current : undefined,
        }),
      });
      const streamPromise = readChatResponse<ChatPayload>(
        response,
        (provider, timing) => {
          const elapsed = performance.now() - (firstTokenTiming?.start ?? performance.now());
          finishTiming(firstTokenTiming, {
            provider, ...(timing ?? {}),
            ...(timing ? { transportAndClientMs: Math.max(0, elapsed - timing.preparationMs - timing.providerMs) } : {}),
          });
        },
        (event) => {
          const eventType = event.event;
          if (eventType === "reply") {
            armWatchdog(TTS_TIMEOUT_MS);
            resolveReply({
              data: event.data as ChatPayload,
              ok: Number(event.status) >= 200 && Number(event.status) < 300,
            });
            return;
          }
          if (!streamer || mutedRef.current) return;
          if (eventType === "audio_chunk") {
            armWatchdog(TTS_TIMEOUT_MS);
            if (audioContextRef.current) {
              streamer.setContext(audioContextRef.current as unknown as AudioContextLike);
            }
            streamer.enqueueChunk({
              turnId: String(event.turnId ?? ""),
              seq: Number(event.seq ?? 0),
              audio: String(event.audio ?? ""),
              sampleRate: typeof event.sampleRate === "number" ? event.sampleRate : undefined,
            });
          } else if (eventType === "audio_alignment") {
            const alignment = parseAlignmentEvent(event);
            if (alignment && streamer.acceptsTurn(alignment.turnId)) ttsSync.addWords(turnId, ttsTracker.ingest(alignment));
          } else if (eventType === "audio_alignment_end") {
            const eventTurnId = String(event.turnId ?? "");
            if (typeof event.sentence === "number" && streamer.acceptsTurn(eventTurnId)) {
              ttsSync.addWords(turnId, ttsTracker.markSentenceEnd(event.sentence));
            }
          } else if (eventType === "audio_reset") {
            streamer.resetAttempt(String(event.turnId ?? ""));
            ttsTracker.reset();
            ttsSync.resetAttempt(turnId);
          } else if (eventType === "audio_turn_end") {
            if (streamWatchdog !== undefined) { window.clearTimeout(streamWatchdog); streamWatchdog = undefined; }
            const eventTurnId = String(event.turnId ?? "");
            if (streamer.acceptsTurn(eventTurnId)) ttsSync.addWords(turnId, ttsTracker.flushAll());
            streamer.markTurnComplete(eventTurnId);
            ttsSync.end(turnId);
          } else if (eventType === "audio_error") {
            if (streamWatchdog !== undefined) { window.clearTimeout(streamWatchdog); streamWatchdog = undefined; }
            streamer.markTurnError(String(event.turnId ?? ""), String(event.error ?? "Audio streaming failed"));
          }
        },
      ).then((res) => {
        if (streamWatchdog !== undefined) { window.clearTimeout(streamWatchdog); streamWatchdog = undefined; }
        resolveReply(res);
        return res;
      }).catch((err) => {
        if (streamWatchdog !== undefined) { window.clearTimeout(streamWatchdog); streamWatchdog = undefined; }
        rejectReply(err);
        if (streamer && !streamer.hasStartedPlayback()) {
          streamer.markTurnError(turnId, err instanceof Error ? err.message : "Audio stream aborted");
        }
        throw err;
      });
      // Background audio chunk errors after reply has settled are handled by streamer callbacks.
      void streamPromise.catch(() => {});

      const { data, ok } = await replyPromise;
      finishTiming(replyTiming);
      if (!ok && data?.code === "QUOTA_EXCEEDED") {
        if (streamWatchdog !== undefined) { window.clearTimeout(streamWatchdog); streamWatchdog = undefined; }
        if (chatStreamAbortRef.current === chatAbort) chatStreamAbortRef.current = null;
        streamer?.interrupt();
        cancelTiming(firstTokenTiming);
        const serverQuota = data.quota ?? data.chatQuota;
        const effectiveTier = serverQuota?.tier ?? accountRef.current?.tier ?? "free";
        handleChatQuotaReached(effectiveTier, serverQuota, text, overrideText === undefined, userMessage.id);
        return;
      }
      if (!ok || !data?.text) throw new Error(data?.code ?? data?.error ?? "Chat request failed");
      const updatedQuota = data.chatQuota ?? data.quota;
      if (updatedQuota) {
        setAccount((prev) => (prev ? { ...prev, chatQuota: updatedQuota } : prev));
      } else if (!accountRef.current) {
        void refreshAccount();
      }
      sceneLibrary.applyChatScene(data.scene, sceneGeneration);
      const reply = data.text;
      setErrorNotice(null);

      // Do not reveal the reply bubble before TTS playback has started. This
      // keeps the visible text and spoken response arriving together.
      if (!mutedRef.current) {
        if (streamer) {
          const replyToAudioTiming = startTiming("reply_to_audio_start");
          const playbackResult = await withTimeout(
            streamer.waitForPlaybackStart(),
            TTS_TIMEOUT_MS,
            { started: false, interrupted: false },
          );
          if (chatAbort.signal.aborted || playbackResult.interrupted) {
            cancelTiming(replyToAudioTiming);
            return;
          }
          if (playbackResult.started || streamer.hasStartedPlayback()) {
            finishTiming(replyToAudioTiming);
          } else {
            cancelTiming(replyToAudioTiming);
            // Only fall back to non-streaming TTS if zero streaming audio started.
            streamer.interrupt();
            await speak(reply, startTiming("reply_to_audio_start"));
          }
        } else {
          await speak(reply, startTiming("reply_to_audio_start"));
        }
      }

      if (chatAbort.signal.aborted && userInterruptedRef.current) return;
      setMessages((current) => [...current, historyMessage("vivian", reply, replyMessageId)]);
      const nextCompanion = normalizeCompanion(data.companion);
      if (nextCompanion) setCompanion(nextCompanion);
      if (data.memories?.length) setMemories(data.memories.filter((item: Memory) => typeof item.id === "number"));
      setSending(false);
      sendingRef.current = false;
      void playReaction(reply, text, false);
      void loadMemory();
    } catch (error) {
      if (chatAbort.signal.aborted && userInterruptedRef.current) {
        return;
      }
      streamer?.interrupt();
      if (error instanceof Error && error.message === "QUOTA_EXCEEDED") {
        handleChatQuotaReached(accountRef.current?.tier ?? "free", undefined, text, overrideText === undefined, userMessage.id);
        return;
      }
      console.error("Vivian response unavailable", error);
      resetReaction();
      const message = error instanceof Error && error.message.includes("RATE_LIMITED") ? "ใจเย็นน รัวแชตเกินไปแล้ว พักแป๊บค่อยพิมพ์ใหม่นะ"
        : error instanceof Error && error.message === "SEARCH_UNAVAILABLE" ? "ตอนนี้ค้นเน็ตให้ไม่ได้แฮะ แอปแอบงอแงนิดนึง"
        : error instanceof Error && error.message === "CHAT_NOT_CONFIGURED" ? "ห้องแชตยังไม่พร้อมคุยเลย เดี๋ยวรอก่อนนะ"
        : "เน็ตหลุดเฉย ช็อตฟีลสุด... รอแป๊บนะ เดี๋ยวกลับมา";
      setErrorNotice(message);
      setMessages((current) => [...current, historyMessage("vivian", message)]);
    } finally {
      if (streamWatchdog !== undefined) window.clearTimeout(streamWatchdog);
      if (chatStreamAbortRef.current === chatAbort) chatStreamAbortRef.current = null;
      cancelTiming(firstTokenTiming); cancelTiming(replyTiming);
      setSending(false);
      sendingRef.current = false;
    }
  }
  // Thin adapter kept for the old call shape: the scoring engine lives in
  // lib/live2d-emotion so it is testable without booting the whole client.
  function situationEmotion(reply: string, userText: string, mood: Mood, intensity: number, idle: boolean) {
    return detectLive2DEmotion({ reply, userText, mood, intensity, idle });
  }
  async function handleExpressionCommand(text: string) {
    const match = text.match(/^\/(?:expression|exp)(?:\s+(.+))?$/i);
    if (!match) return false;
    const argument = match[1]?.trim() ?? "";
    const is3D = avatarModeRef.current === "3d";
    const expressions = is3D ? avatar3d.activeExpressionsList : (activeModel?.expressions ?? []);
    if (argument.toLowerCase() === "list") {
      setMessages((current) => [...current, historyMessage("me", text), historyMessage("vivian", `นี่ มีสีหน้าให้เลือกแค่นี้แหละ: ${expressions.join(", ")} อยากได้อันไหนก็จิ้มเอาเลย`)]);
      return true;
    }
    if (!argument || argument.toLowerCase() === "default" || argument.toLowerCase() === "reset") {
      if (is3D) avatar3d.clearSavedExpressions();
      else clearSavedExpressions();
      setMessages((current) => [...current, historyMessage("me", text), historyMessage("vivian", "กลับมาหน้าปกติละนะ")]);
      return true;
    }
    const expression = expressions.find((item) => item.trim().toLowerCase() === argument.toLowerCase());
    if (!expression) {
      setMessages((current) => [...current, historyMessage("me", text), historyMessage("vivian", "ไม่มีสีหน้าชื่อนั้นอะ ลองพิมพ์ /expression list เช็กดูก่อนสิ")]);
      return true;
    }
    try {
      if (is3D) {
        if (!avatar3d.hasAvatar()) throw new Error("3D model is not ready");
        const selected = avatar3d.activeExpressionsModelId === avatar3d.activeModel?.id ? avatar3d.activeExpressions : [];
        if (!selected.includes(expression)) avatar3d.saveExpressionSelection([...selected, expression]);
      } else {
        if (!modelRef.current) throw new Error("Live2D model is not ready");
        const selected = activeExpressionModelRef.current === activeModel?.id ? activeExpressionsRef.current : [];
        if (!selected.includes(expression)) saveExpressionSelection([...selected, expression]);
      }
      setMessages((current) => [...current, historyMessage("me", text), historyMessage("vivian", `โอเค จำหน้า ${expression.trim()} ไว้ให้ละนะ`)]);
    } catch (error) {
      console.warn("Manual avatar expression unavailable", error);
      resetReaction();
      setMessages((current) => [...current, historyMessage("me", text), historyMessage("vivian", "ยังเปลี่ยนหน้าไม่ได้อะ โมเดลยังไม่มาเลย")]);
    }
    return true;
  }
  async function playReaction(reply: string, userText: string, idle = false) {
    const { mood, moodIntensity: intensity } = companionRef.current;
    const emotion = situationEmotion(reply, userText, mood, intensity, idle);
    if (avatarModeRef.current === "3d") {
      if (!avatar3d.hasAvatar()) return;
      try {
        const result = avatar3d.playEmotionReaction(emotion, intensity);
        if (result.expression) setActiveExpression(result.expression);
      } catch (error) {
        resetReaction();
        console.warn("3D reaction unavailable; keeping neutral state", error);
      }
      return;
    }
    const model = modelRef.current;
    if (!model) return;
    const supportedExpressions = activeModel?.expressions ?? [];
    // Tags first, then mood, then words. A model with no matching face keeps
    // its last reaction instead of flashing back to neutral every turn.
    const expression = resolveLive2DExpression(emotion, supportedExpressions);
    try {
      if (expression) {
        const expressionStacks = activeModel ? aiExpressionStacksRef.current.get(activeModel.id) : undefined;
        const stackedName = expressionStacks?.get(expression);
        if (expressionStacks?.has(SAVED_EXPRESSION_STACK_NAME) && !stackedName) {
          await model.expression(SAVED_EXPRESSION_STACK_NAME);
        } else {
          const applied = await model.expression(stackedName ?? expression);
          if (applied) setActiveExpression(expression);
        }
      }
      else if (!supportedExpressions.length) resetReaction();
      const definitions = model.internalModel?.motionManager?.definitions ?? {};
      const groups = Object.keys(definitions).filter((name) => Array.isArray(definitions[name]) && definitions[name].length);
      const motionName = resolveLive2DMotion(emotion, groups);
      if (motionName) await model.motion(motionName, 0, intensity >= 70 ? 3 : 2);
    } catch (error) {
      resetReaction();
      console.warn("Live2D reaction unavailable; keeping neutral state", error);
    }
  }
  async function startRecording() {
    if (resettingRef.current || recording || recorderRef.current) return;
    const generation = memoryGenerationRef.current;
    if (speakingRef.current) stopSpeech();
    markActivity();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      // A push-to-talk hold can be released while Safari's permission prompt is
      // still pending. Do not leave a late-resolving stream recording in the
      // background after the user has already released the orb.
      if (generation !== memoryGenerationRef.current || !micEnabledRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const chunks: BlobPart[] = [];
      const preferredMimeTypes = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"];
      const mimeType = preferredMimeTypes.find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 128000 });
      recorder.ondataavailable = (event) => event.data.size && chunks.push(event.data);
      recorder.onstop = async () => {
        const realtime = scribeRef.current;
        scribeRef.current = null;
        pcmCaptureRef.current?.stop();
        pcmCaptureRef.current = null;
        // Automatic rearming waits for Vivian to finish, and never survives reset.
        const resumeListening = () => {
          if (generation !== memoryGenerationRef.current || resettingRef.current || !micEnabledRef.current || recordingRef.current) return;
          if (speakingRef.current || sendingRef.current) {
            window.setTimeout(resumeListening, 250);
            return;
          }
          void startRecording();
        };
        if (generation !== memoryGenerationRef.current) { realtime?.stop(); clearUserKinetic(); recorderRef.current = null; streamRef.current = null; return; }
        const durationMs = Date.now() - recordingStartedAtRef.current;
        const actualMimeType = recorder.mimeType || mimeType || "audio/webm";
        const extension = actualMimeType.includes("mp4") ? "m4a" : "webm";
        if (durationMs < MIN_RECORDING_MS || !chunks.length || (voiceActivityRef.current && !voiceActivityRef.current.heardSpeech)) {
          realtime?.stop();
          clearUserKinetic();
          setSttPreview("ยังไม่ได้ยินเสียงชัด ๆ เลย พูดใกล้ไมค์อีกนิดน้า");
          window.setTimeout(() => setSttPreview(null), 2500);
          recorderRef.current = null;
          streamRef.current = null;
          window.setTimeout(resumeListening, 250);
          return;
        }
        // Prefer the realtime transcript (already on screen); fall back to batch STT when unavailable.
        if (realtime) {
          const realtimeText = await realtime.commit();
          realtime.stop();
          if (generation !== memoryGenerationRef.current) { clearUserKinetic(); return; }
          const fullUtterance = sttSync.committedText() || realtimeText?.trim() || "";
          if (fullUtterance) {
            userKinetic.set(sttSync.frame());
            void sendMessage(fullUtterance);
            sttClearTimerRef.current = window.setTimeout(clearUserKinetic, 4500);
            recorderRef.current = null;
            streamRef.current = null;
            window.setTimeout(resumeListening, 250);
            return;
          }
          clearUserKinetic();
        }
        const form = new FormData();
        form.append("file", new Blob(chunks, { type: actualMimeType }), `vivian-recording.${extension}`);
        const speechEnd = voiceActivityRef.current?.quietSince;
        const start = speechEnd === null || speechEnd === undefined ? performance.now() : Math.max(0, performance.now() - (Date.now() - speechEnd));
        const transcriptTiming = startTiming("speech_end_to_transcript", start);
        const endpointTiming = startTiming("speech_end_to_stt_request", start);
        const sttTiming = startTiming("stt_request_to_transcript");
        finishTiming(endpointTiming);
        try {
          form.append("language", speechLanguageRef.current);
          const response = await authFetch("/api/stt", { method: "POST", body: form, signal: abortAfter(STT_TIMEOUT_MS) });
          const data = await response.json() as { text?: string; error?: string };
          if (generation !== memoryGenerationRef.current) return;
          if (!response.ok) throw new Error(data.error ?? "STT failed");
          if (data.text?.trim()) {
            finishTiming(transcriptTiming);
            finishTiming(sttTiming, { serverTiming: response.headers.get("server-timing") ?? "unavailable" });
            clearUserKinetic();
            sttSync.setLanguage(speechLanguageRef.current);
            sttSync.commit(data.text);
            userKinetic.set(sttSync.frame());
            void sendMessage(data.text);
            sttClearTimerRef.current = window.setTimeout(clearUserKinetic, 5000);
          } else throw new Error("STT returned no speech");
        } catch (error) {
          console.warn("STT unavailable", error);
          setSttPreview("เมื่อกี้ฟังไม่ชัดเลยอะ ลองพูดใหม่อีกทีได้ป่ะ");
          window.setTimeout(() => setSttPreview(null), 3000);
        } finally {
          cancelTiming(transcriptTiming); cancelTiming(sttTiming);
          recorderRef.current = null;
          streamRef.current = null;
          window.setTimeout(resumeListening, 250);
        }
      };
      voiceActivityRef.current = null;
      recorder.start();
      recorderRef.current = recorder;
      streamRef.current = stream;
      recordingStartedAtRef.current = Date.now();
      recordingRef.current = true;
      setRecording(true);
      startRealtimeStt(stream, generation);
      // Keep the recorder open and split speech into utterances using local
      // voice activity detection. Only the resulting clip is sent to STT.
      const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AudioContextClass) {
        const voiceContext = new AudioContextClass();
        voiceContextRef.current = voiceContext;
        void voiceContext.resume().catch(() => {});
        const analyser = voiceContext.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = .75;
        voiceSourceRef.current = voiceContext.createMediaStreamSource(stream);
        voiceSourceRef.current.connect(analyser);
        voiceAnalyserRef.current = analyser;
        const samples = new Uint8Array(analyser.fftSize);
        const activity = createVoiceActivity();
        voiceActivityRef.current = activity;
        const monitor = () => {
          if (!recordingRef.current || recorderRef.current !== recorder) return;
          analyser.getByteTimeDomainData(samples);
          let sum = 0;
          for (const sample of samples) { const delta = sample - 128; sum += delta * delta; }
          const rms = Math.sqrt(sum / samples.length) / 128;
          micAmplitude.set(Math.min(1, rms * 7));
          if (updateVoiceActivity(activity, rms, Date.now())) { stopRecording(); return; }
          voiceMonitorRef.current = requestAnimationFrame(monitor);
        };
        voiceMonitorRef.current = requestAnimationFrame(monitor);
      }
    } catch {
      micAmplitude.set(0);
      micEnabledRef.current = false;
      resetReaction();
      setMessages((current) => [...current, historyMessage("vivian", "ยังไม่ได้กดอนุญาตให้ใช้ไมค์เลย เปิดสิทธิ์ให้ก่อนนะ")]);
    }
  }
  function stopRecording() {
    micAmplitude.set(0);
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    recorder.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    if (voiceMonitorRef.current !== null) cancelAnimationFrame(voiceMonitorRef.current);
    voiceMonitorRef.current = null;
    voiceSourceRef.current?.disconnect();
    voiceSourceRef.current = null;
    voiceAnalyserRef.current = null;
    void voiceContextRef.current?.close().catch(() => {});
    voiceContextRef.current = null;
    recordingRef.current = false;
    setRecording(false);
  }
  function toggleRecording() {
    if (micEnabledRef.current) {
      micEnabledRef.current = false;
      stopRecording();
    } else {
      micEnabledRef.current = true;
      void startRecording();
    }
  }

  function captureCurrentFrame(): string | null {
    const video = videoRef.current;
    if (!video) return null;
    const vw = video.videoWidth || 640;
    const vh = video.videoHeight || 480;
    if (!vw || !vh) return null;

    try {
      const canvas = document.createElement("canvas");
      const maxDim = 800;
      let width = vw;
      let height = vh;
      if (width > maxDim || height > maxDim) {
        if (width > height) {
          height = Math.round((height * maxDim) / width);
          width = maxDim;
        } else {
          width = Math.round((width * maxDim) / height);
          height = maxDim;
        }
      }
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(video, 0, 0, width, height);
      return canvas.toDataURL("image/jpeg", 0.75);
    } catch (err) {
      console.warn("captureCurrentFrame error", err);
      return null;
    }
  }

  useEffect(() => {
    const video = videoRef.current;
    if (cameraActive && video && videoStreamRef.current) {
      if (video.srcObject !== videoStreamRef.current) {
        video.srcObject = videoStreamRef.current;
      }
      video.muted = true;
      video.play().catch((err) => console.warn("Camera play failed", err));
    }
  }, [cameraActive]);

  async function startCamera(facing: "user" | "environment" = cameraFacing) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: facing },
        audio: false,
      });
      videoStreamRef.current = stream;
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        video.muted = true;
        await video.play().catch((err) => console.warn("Initial camera play failed", err));
      }
      setCameraFacing(facing);
      setCameraActive(true);
      cameraActiveRef.current = true;
    } catch (err) {
      console.error("Camera access failed", err);
      setErrorNotice("เปิดกล้องไม่ได้แฮะ ลองกดอนุญาตใช้กล้องก่อนน้า");
    }
  }

  function stopCamera() {
    videoStreamRef.current?.getTracks().forEach((track) => track.stop());
    videoStreamRef.current = null;
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setCameraActive(false);
    cameraActiveRef.current = false;
  }

  async function toggleCamera() {
    if (cameraActive) {
      stopCamera();
    } else {
      await startCamera();
    }
  }

  async function switchCamera() {
    const nextFacing = cameraFacing === "user" ? "environment" : "user";
    // Stop current tracks before switching
    videoStreamRef.current?.getTracks().forEach((track) => track.stop());
    videoStreamRef.current = null;
    await startCamera(nextFacing);
  }

  function handleImageUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setErrorNotice("อันนี้ไม่ใช่ไฟล์รูปอะ ขอเป็นไฟล์รูปแทนน้า");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const rawData = reader.result as string;
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        const maxDim = 800;
        let width = img.width;
        let height = img.height;
        if (width > maxDim || height > maxDim) {
          if (width > height) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(img, 0, 0, width, height);
          const compressed = canvas.toDataURL("image/jpeg", 0.75);
          setAttachedImage(compressed);
        } else {
          setAttachedImage(rawData);
        }
      };
      img.onerror = () => {
        setAttachedImage(rawData);
      };
      img.src = rawData;
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  }

  async function saveMemory(memory: Memory) {
    const response = await authFetch("/api/memory", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: memory.id, memory: memoryDraft, category: memory.category, importance: memory.importance }) });
    if (!response.ok) return setErrorNotice("เซฟความจำตรงนี้ไม่ติดแฮะ ลองอีกทีนะ");
    const data = await response.json() as { memory?: Memory };
    if (data.memory) setMemories((current) => current.map((item) => item.id === memory.id ? data.memory! : item));
    setEditingMemoryId(null);
  }

  async function generateMemorySummary() {
    if (memorySummaryBusy !== "idle" || resettingRef.current) return;
    const generation = memoryGenerationRef.current;
    setMemorySummaryBusy("generating");
    setMemorySummaryNotice(null);
    try {
      const response = await authFetch("/api/memory/consolidate", { method: "POST" });
      const data = await response.json().catch(() => null) as { summary?: string; error?: string } | null;
      if (generation !== memoryGenerationRef.current || resettingRef.current) return;
      if (!response.ok || typeof data?.summary !== "string") {
        setMemorySummaryNotice("สรุปความจำตอนนี้ไม่ติดแฮะ ลองกดใหม่อีกทีนะ");
        return;
      }
      setMemorySummary(data.summary);
      setMemorySummaryDraft(data.summary);
      setEditingMemorySummary(false);
      setMemorySummaryNotice("อัปเดตสรุปความจำให้แล้ว");
    } catch {
      if (generation === memoryGenerationRef.current) {
        setMemorySummaryNotice("สรุปความจำตอนนี้ไม่ติดแฮะ ลองกดใหม่อีกทีนะ");
      }
    } finally {
      if (generation === memoryGenerationRef.current) setMemorySummaryBusy("idle");
    }
  }

  async function saveMemorySummaryEdit() {
    if (memorySummaryBusy !== "idle" || resettingRef.current) return;
    const generation = memoryGenerationRef.current;
    setMemorySummaryBusy("saving");
    setMemorySummaryNotice(null);
    try {
      const response = await authFetch("/api/memory/consolidate", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ summary: memorySummaryDraft }),
      });
      const data = await response.json().catch(() => null) as { summary?: string } | null;
      if (generation !== memoryGenerationRef.current || resettingRef.current) return;
      if (!response.ok || typeof data?.summary !== "string") {
        setMemorySummaryNotice("เซฟสรุปความจำไม่ติดแฮะ ลองอีกทีนะ");
        return;
      }
      setMemorySummary(data.summary);
      setMemorySummaryDraft(data.summary);
      setEditingMemorySummary(false);
      setMemorySummaryNotice("เซฟสรุปความจำให้แล้ว");
    } catch {
      if (generation === memoryGenerationRef.current) {
        setMemorySummaryNotice("เซฟสรุปความจำไม่ติดแฮะ ลองอีกทีนะ");
      }
    } finally {
      if (generation === memoryGenerationRef.current) setMemorySummaryBusy("idle");
    }
  }

  async function resetVivian(): Promise<void> {
    if (sendingRef.current || resettingRef.current || !history.ready) return;
    setResetConfirming(false);
    resettingRef.current = true;
    memoryGenerationRef.current += 1;
    setResetting(true);
    setResetNotice(null);
    stopSpeech();
    micEnabledRef.current = false;
    stopRecording();
    stopCamera();
    try {
      await history.pause();
      const response = await authFetch("/api/memory", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scope: "all" }) });
      if (!response.ok) throw new Error("Reset failed");
      const data = await response.json() as { ok?: boolean };
      if (data.ok !== true) throw new Error("Reset unconfirmed");
      // D7: Reset KEEPS custom instructions (persona persists) — do not
      // remove the vivian-custom-instructions cache or cloud singleton.
      for (const key of [CONVERSATIONS_KEY, "vivian-active-conversation", "vivian-checkin-date", "vivian-streak"]) window.localStorage.removeItem(key);
      const id = crypto.randomUUID();
      window.localStorage.setItem("vivian-active-conversation", id);
      setActiveConversationId(id);
      history.clear();
      setMessages([]);
      setMemories([]);
      setMemorySummary("");
      setMemorySummaryDraft("");
      setEditingMemorySummary(false);
      setMemorySummaryNotice(null);
      setCompanion(defaultCompanionState());
      setStreak(0);
      setMessage("");
      setAttachedImage(null);
      setSttPreview(null);
      scribeRef.current?.stop();
      scribeRef.current = null;
      pcmCaptureRef.current?.stop();
      pcmCaptureRef.current = null;
      clearUserKinetic();
      setEditingMemoryId(null);
      setMemoryDraft("");
      setConversationSearch("");
      setErrorNotice(null);
      markActivity();
      interactedRef.current = false;
      setResetNotice("รีเซ็ตให้เรียบร้อย! มาเริ่มนับหนึ่งคุยกันใหม่เลย");
    } catch {
      setResetNotice("ยังล้างออกไม่หมดแฮะ แชตในเครื่องนี้ยังอยู่ ลองกดใหม่อีกทีน้า");
    } finally {
      resettingRef.current = false;
      setResetting(false);
      history.resume();
    }
  }

  function openPanel(next: Panel) {
    panelRef.current = next;
    sidebarOpenRef.current = true;
    if (next !== "conversations") setPreviewConversationId(null);
    try { window.sessionStorage.setItem("vivian-open-panel", next); } catch { /* Storage restrictions do not block navigation. */ }
    setPanel(next);
    setSidebarOpen(true);
    if (next === "conversations") void history.refresh();
  }
  function openMenuHub() {
    panelRef.current = null;
    try { window.sessionStorage.removeItem("vivian-open-panel"); } catch { /* Ignore unavailable storage. */ }
    setPanel(null);
    sidebarOpenRef.current = true;
    setSidebarOpen(true);
  }
  function backToNavigation(event: ReactMouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    openMenuHub();
  }
  function closeMenu() {
    panelRef.current = null;
    sidebarOpenRef.current = false;
    setPreviewConversationId(null);
    try { window.sessionStorage.removeItem("vivian-open-panel"); } catch { /* Ignore unavailable storage. */ }
    setPanel(null);
    setSidebarOpen(false);
  }
  function closeNavigation(event: ReactMouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    closeMenu();
  }
  useEffect(() => { panelRef.current = panel; sidebarOpenRef.current = sidebarOpen; }, [panel, sidebarOpen]);
  useEffect(() => {
    try {
      const savedPanel = window.sessionStorage.getItem("vivian-open-panel");
      if (savedPanel && ["conversations", "memories", "character", "scenes", "voice", "status", "settings"].includes(savedPanel)) {
        panelRef.current = savedPanel as Panel;
        sidebarOpenRef.current = true;
        queueMicrotask(() => {
          setPanel(savedPanel as Panel);
          setSidebarOpen(true);
        });
      }
    } catch { /* Storage restrictions do not block navigation. */ }
  }, []);
  useEffect(() => {
    if (!sidebarOpen || !panel || !window.matchMedia("(max-width: 760px)").matches) return;
    window.history.pushState({ vivianMenu: true, panel }, "");
    const onHardwareBack = () => {
      if (panelRef.current) {
        panelRef.current = null;
        setPanel(null);
        setSidebarOpen(true);
      } else if (sidebarOpenRef.current) {
        sidebarOpenRef.current = false;
        setSidebarOpen(false);
      }
    };
    window.addEventListener("popstate", onHardwareBack);
    return () => window.removeEventListener("popstate", onHardwareBack);
  }, [sidebarOpen, panel]);
  function selectConversation(conversation: Conversation) {
    if (sending || resettingRef.current || !history.ready) return;
    stopSpeech();
    setErrorNotice(null);
    setActiveConversationId(conversation.id);
    window.localStorage.setItem("vivian-active-conversation", conversation.id);
    setMessages(conversation.messages);
    closeMenu();
  }
  function newConversation() {
    if (sending || resettingRef.current || !history.ready) return;
    stopSpeech();
    setPreviewConversationId(null);
    setErrorNotice(null);
    const id = crypto.randomUUID();
    setActiveConversationId(id);
    window.localStorage.setItem("vivian-active-conversation", id);
    setMessages([]);
    closeMenu();
  }
  async function deleteConversation(id: string) {
    if (sending || resettingRef.current) return;
    setErrorNotice(null);
    await history.pause();
    try {
      await deleteCloudHistory(id).catch(() => null);
      history.removeConversation(id);
    } finally {
      history.resume();
    }
    if (previewConversationId === id) setPreviewConversationId(null);
  }
  const navigation: Array<{ key: Panel; label: string; icon: IconName }> = [
    { key: "conversations", label: "ประวัติแชต", icon: "message" },
    { key: "memories", label: "ความจำ", icon: "memory" },
    { key: "character", label: "ตัวละคร", icon: "wardrobe" },
    { key: "scenes", label: "ฉากหลัง", icon: "scene" },
    { key: "voice", label: "เสียงพูด", icon: "sound" },
    { key: "status", label: "สิทธิ์ & พื้นที่", icon: "status" },
    { key: "settings", label: "ตั้งค่า", icon: "config" },
  ];
  // One shared state vocabulary for the orb: it follows radio/TTS/mic reality.
  const orbState: AIState =
    errorNotice
      ? "error"
      : speaking
        ? "streaming"
        : sending
          ? "thinking"
          : recording
            ? "listening"
            : "idle";
  function toggleTextInput() {
    setTextOpen((open) => {
      if (!open && recordingRef.current) toggleRecording();
      return !open;
    });
  }
  // ---- Orb interaction: double tap = quick-actions row, press & hold = talk (STT). ----
  function setRadialVisible(open: boolean) {
    radialOpenRef.current = open;
    setRadialOpen(open);
  }
  function closeOrbRadial() {
    setRadialVisible(false);
  }
  useEffect(() => {
    if (!radialOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest(".orb-toolbar, .orb-button")) return;
      closeOrbRadial();
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [radialOpen]);
  function closeComposer() {
    // Closing the composer resets its draft: text and attachment clear.
    setAttachedImage(null);
    setMessage("");
    setTextOpen(false);
  }
  function runOrbDirection(action: OrbDirection) {
    setRadialVisible(false);
    hapticFeedback(hapticPatterns.pick);
    // Picking mic, camera or the menu hub folds the text pill away first, so
    // the composer never floats open behind the action you chose.
    if (action === "mic") { closeComposer(); toggleRecording(); }
    else if (action === "camera") { closeComposer(); void toggleCamera(); }
    else if (action === "type") { if (textOpen) closeComposer(); else setTextOpen(true); }
    else { closeComposer(); openMenuHub(); }
  }
  function onOrbPointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
    void event.currentTarget.setPointerCapture(event.pointerId);
    orbPointerRef.current = { x: event.clientX, y: event.clientY };
    if (radialOpenRef.current) return; // toolbar is open: taps select buttons, no PTT
    // Arm push-to-talk: a short hold starts recording, a quick tap does not.
    if (orbHoldTimerRef.current !== null) window.clearTimeout(orbHoldTimerRef.current);
    orbHoldTimerRef.current = window.setTimeout(() => {
      orbHoldTimerRef.current = null;
      orbPttActiveRef.current = true;
      hapticFeedback(hapticPatterns.arm);
      if (!micEnabledRef.current) {
        micEnabledRef.current = true;
        void startRecording();
      }
    }, 220);
  }
  function onOrbPointerEnd(event: ReactPointerEvent<HTMLButtonElement>) {
    void event.currentTarget.releasePointerCapture?.(event.pointerId);
    orbPointerRef.current = null;
    if (orbHoldTimerRef.current !== null) { window.clearTimeout(orbHoldTimerRef.current); orbHoldTimerRef.current = null; }
    if (orbPttActiveRef.current) {
      orbPttActiveRef.current = false;
      hapticFeedback(hapticPatterns.confirm);
      if (micEnabledRef.current) {
        micEnabledRef.current = false;
        stopRecording();
      }
      orbLastTapRef.current = 0;
      return;
    }
    if (radialOpenRef.current) {
      // The quick-action row is selected by tapping its buttons directly.
      closeOrbRadial();
      orbLastTapRef.current = 0;
      return;
    }
    // A quick tap: the second tap inside 320ms opens the quick-action row.
    const now = Date.now();
    if (orbLastTapRef.current && now - orbLastTapRef.current <= 320) {
      orbLastTapRef.current = 0;
      hapticFeedback(hapticPatterns.tick);
      setRadialVisible(true);
    } else {
      orbLastTapRef.current = now;
    }
  }

  // Show Vivian preloader while the active Live2D or 3D avatar is loading.
  const avatarLoading = avatarMode === "3d"
    ? avatar3d.isBusy
    : (startupModelPending || modelSwitchPending || modelStatus === "loading");

  return <main className="companion-shell">
    <PagePreloader
      active={avatarLoading}
      variant="words"
      background="bg-background/90 backdrop-blur-sm"
      words={["รอแป๊บนึงน้า...", "กำลังแต่งตัวให้จึ้งอยู่", "อย่าเพิ่งหนีไปไหนนะ... เดี๋ยวมา", "แค่เธอคนเดียวยอมรอหน่อยได้ป่ะ", "ใกล้เสร็จละ อะแฮ่ม!"]}
      onComplete={() => {}}
    />
    <section className={`companion-stage ${MODEL_CONFIG[selectedModel].background} ${!sending && !recording ? "is-idle" : ""}`} aria-label="Vivian companion">
      <SceneBackground source={sceneLibrary.scenes.find((scene) => scene.id === activeCustomSceneId)?.imageUrl ?? BACKGROUNDS[selectedPreset]} preview={sceneLibrary.scenes.find((scene) => scene.id === activeCustomSceneId)?.thumbnailUrl} timing={sceneLibrary.selectionTiming} />
      {avatarMode === "3d"
        ? <canvas key="avatar-3d" className="live2d-canvas" data-avatar-mode="3d" ref={canvas3dRef} />
        : <canvas key="avatar-live2d" className="live2d-canvas" data-avatar-mode="live2d" ref={canvasRef} />}
      <header className="companion-brand">
        <button className="brand-menu" type="button" onClick={openMenuHub} aria-label="เปิดเมนู Vivian (แชต ความจำ ตัวละคร ฉาก เสียง สิทธิ์)">
          <span className="brand-mark" aria-hidden="true"/><span>Vivian</span>
        </button>
      </header>
      <div className="camera-pip" style={{ display: cameraActive ? "flex" : "none" }} aria-label="Live Camera Vision">
        <div className="camera-pip-header">
          <div className="live-badge">
            <span className="live-dot" aria-hidden="true" />
            <span>{cameraFacing === "environment" ? "กล้องหลัง" : "กล้องสด"}</span>
          </div>
          <div style={{ display: "flex", gap: 4 }}>
            <button type="button" onClick={switchCamera} aria-label="สลับกล้อง" title="สลับกล้องหน้า/หลัง">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 7H4m0 0l4-4M4 7l4 4M4 17h16m0 0-4 4m4-4-4-4"/>
              </svg>
            </button>
            <button type="button" onClick={stopCamera} aria-label="ปิดกล้อง">×</button>
          </div>
        </div>
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="camera-video-feed"
          style={{ transform: cameraFacing === "environment" ? "none" : "scaleX(-1)" }}
          onLoadedMetadata={(e) => {
            e.currentTarget.play().catch((err) => console.warn("Video play on metadata blocked", err));
          }}
        />
      </div>
      <div className="speech-stack">
        <KineticText store={userKinetic} variant="user" label="เธอพูดว่า" />
        {sttPreview && <div className="speech-preview"><small>เธอพูดว่า</small>{sttPreview}</div>}
        <output className={`vivian-speech ${sending && !speaking && !showKinetic ? "is-thinking" : ""}`} aria-live="polite">
          {showKinetic
            ? <><KineticText store={vivianKinetic} variant="vivian" /><span className="sr-only">{lastVivianMessage}</span></>
            : sending && !speaking
            ? <span className="speech-transition" key="thinking"><span>Vivian กำลังนึกคำอยู่</span><span className="thinking-dots" aria-hidden="true"><i/><i/><i/></span></span>
            : !sending
              ? <span className="speech-transition" key={lastVivianMessage}>{lastVivianMessage}</span>
              : null}
        </output>
      </div>
      {errorNotice && <button className="error-notice" type="button" onClick={() => setErrorNotice(null)}>{errorNotice} ×</button>}
      {attachedImage && (
        <div className="attachment-preview" aria-label="รูปที่แนบมา">
          <img src={attachedImage} alt="ตัวอย่างรูปที่แนบ" />
          <span>แนบรูปเรียบร้อย</span>
          <button type="button" onClick={() => setAttachedImage(null)} aria-label="ลบรูป">×</button>
        </div>
      )}
      {textOpen && <button className="composer-scrim" type="button" tabIndex={-1} aria-label="ปิดช่องพิมพ์" onClick={closeComposer} />}
      <div className="orb-dock">
        <form className={`composer-pill ${textOpen ? "is-open" : ""}`} onSubmit={(event) => { event.preventDefault(); void sendMessage(); }} inert={!textOpen}>
          <button className="circle-control" type="button" onClick={() => fileInputRef.current?.click()} aria-label="แนบรูป"><Icon name="clip" size={18}/></button>
          <input value={message} onChange={(event) => setMessage(event.target.value)} autoFocus={textOpen} placeholder={recording ? "กำลังฟังอยู่... แตะไมค์เพื่อปิด" : cameraActive ? "เปิดกล้องอยู่... พิมพ์คุยได้เลย" : "พิมพ์คุยกับ Vivian..."} aria-label="ข้อความถึง Vivian" />
          <button className="send-text" type="submit" disabled={sending || !history.ready || (!message.trim() && !attachedImage)} aria-label="ส่งข้อความ"><Icon name="send" size={18}/></button>
        </form>
        <div className="orb-row">
          {radialOpen && <div className="orb-toolbar" role="toolbar" aria-label="ทางลัดของ Vivian">
            {ORB_DIRECTIONS.map((item) => (
              <button
                key={item.key}
                type="button"
                className="orb-direction"
                aria-label={item.label}
                onPointerDown={(event) => event.stopPropagation()}
                onPointerUp={(event) => event.stopPropagation()}
                onClick={() => runOrbDirection(item.key)}
              >
                <span
                  className={`circle-control ${
                    item.key === "mic" && recording
                      ? "is-recording"
                      : item.key === "camera" && cameraActive
                      ? "is-active is-camera-active"
                      : item.key === "type" && textOpen
                      ? "is-active"
                      : ""
                  }`}
                  aria-hidden="true"
                >
                  <Icon name={item.key === "mic" && recording ? "micOff" : item.icon} size={18}/>
                </span>
                <small>{item.label}</small>
              </button>
            ))}
          </div>}
          <button
            className="orb-button"
            type="button"
            onPointerDown={onOrbPointerDown}
            onPointerUp={onOrbPointerEnd}
            onPointerCancel={onOrbPointerEnd}
            onContextMenu={(event) => event.preventDefault()}
            aria-label="กดค้างเพื่อคุยกับ Vivian แตะสองครั้งเพื่อเปิดทางลัด (ไมค์ กล้อง พิมพ์ ตั้งค่า)"
            aria-expanded={radialOpen}
          >
            <SiriOrb size="62px" state={orbState} amplitude={recording ? micAmplitude : 0} />
          </button>
        </div>
        <input ref={fileInputRef} type="file" accept="image/*" style={{ display: "none" }} onChange={handleImageUpload} tabIndex={-1} />
      </div>
    </section>
    <div className={`floating-overlay ${sidebarOpen ? "is-visible" : ""}${sidebarOpen && panel === "character" && (characterTab === "expression" || characterTab === "pose") ? " is-live-preview" : ""}`} aria-hidden={!sidebarOpen}>
      <button className="floating-scrim" type="button" tabIndex={sidebarOpen ? 0 : -1} onClick={closeMenu} aria-label="ปิดเมนู" />
      <div className="floating-workspace menu-window">
        <section className="floating-panel" role="dialog" aria-modal={!(panel === "character" && (characterTab === "expression" || characterTab === "pose"))} aria-label={panel ? navigation.find((item) => item.key === panel)?.label : "เมนู Vivian"}>
          <div className="floating-panel-head">{panel && <button className="settings-back" type="button" onClick={backToNavigation} aria-label="กลับไปหน้าเมนู"><svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg></button>}<div><small>{panel ? `VIVIAN / ${panel.toUpperCase()}` : "VIVIAN / MENU"}</small><h2>{panel ? navigation.find((item) => item.key === panel)?.label : "เมนู"}</h2></div>{panel === "character" && (characterTab === "expression" || characterTab === "pose") && <span className="live-preview-badge">พรีวิวสด</span>}<button type="button" onClick={closeNavigation} aria-label="ปิดเมนู"><Icon name="close" size={18}/></button></div>
          {((avatarMode === "3d" ? avatar3d.modelImporting : modelImporting) && panel === "character") && (() => {
            const pct = avatarMode === "3d" ? avatar3d.displayedImportPercent : displayedImportPercent;
            return <div className={`floating-panel-loadbar${typeof pct === "number" ? " is-determinate" : " is-indeterminate"}`} aria-hidden="true"><span style={typeof pct === "number" ? { width: `${pct}%` } : undefined} /></div>;
          })()}
          <div className="floating-panel-body">
            {!panel && <>
              <TierMenuSummary
                account={account}
                accountEmail={accountEmail}
                loading={accountLoading}
                profileDisplayName={userProfile.displayName}
                onOpenRequest={() => setRequestModalOpen(true)}
                onOpenProfile={() => { closeMenu(); setOnboardingOpen(true); }}
              />
              <button type="button" className="floating-new-chat" onClick={newConversation}><Icon name="plus" size={17}/> เริ่มแชตใหม่</button>
              <div className="floating-menu-list">{navigation.map((item) => <button key={item.key} type="button" className="floating-nav-item" onClick={() => openPanel(item.key)}><Icon name={item.icon} size={18}/><span>{item.label}</span><span className="nav-chevron"><Icon name="chevron" size={16}/></span></button>)}</div>
            </>}
            {panel === "conversations" && (() => {
              const preview = conversations.find((item) => item.id === previewConversationId);
              const avatar = avatarMode === "3d"
                ? (avatar3d.activePreviewUrl ?? modelPreviews[activeModelId ?? ""] ?? Object.values(modelPreviews)[0])
                : (modelPreviews[activeModelId ?? ""] ?? Object.values(modelPreviews)[0]);
              const timeLabel = (updatedAt: number) => {
                const days = Math.floor((Date.now() - updatedAt) / 86_400_000);
                return days <= 0 ? "วันนี้" : days === 1 ? "เมื่อวาน" : new Intl.DateTimeFormat("th-TH", { month: "short", day: "numeric" }).format(updatedAt);
              };
              const filtered = conversations.filter((item) => item.title.toLowerCase().includes(conversationSearch.toLowerCase()) || item.messages.some((entry) => entry.text.toLowerCase().includes(conversationSearch.toLowerCase()))).sort((a, b) => b.updatedAt - a.updatedAt);
              if (preview) {
                return <>
                  <button type="button" className="preview-back" onClick={() => setPreviewConversationId(null)} aria-label="กลับไปดูแชตทั้งหมด"><svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg> แชตทั้งหมด</button>
                  <div className="conversation-preview">
                    <div className="preview-head">
                      {avatar ? <img src={avatar} alt="" className="preview-avatar" /> : <span className="conversation-avatar">V</span>}
                      <div className="preview-title"><strong>{preview.title}</strong><small>Vivian · ออนไลน์ตลอด</small></div>
                    </div>
                    <div className="preview-messages chat-history">
                      {preview.messages.slice(-30).map((message, index) => <div className={`chat-message ${message.from}`} key={message.id ?? index}><small>{message.from === "me" ? "เธอ" : "Vivian"}</small><p>{speechText(message.text)}</p></div>)}
                    </div>
                    <div className="preview-actions">
                      <button type="button" className="ghost-btn primary" onClick={() => selectConversation(preview)}>เปิดแชตนี้</button>
                      <button type="button" className="ghost-btn danger" onClick={() => void deleteConversation(preview.id)}>ลบแชต</button>
                    </div>
                  </div>
                </>;
              }
              return <>
                <label className="floating-search"><Icon name="search" size={17}/><input value={conversationSearch} onChange={(event) => setConversationSearch(event.target.value)} placeholder="ค้นหาแชตเก่า..." /></label>
                {filtered.length ? <div className="conversation-list">{filtered.map((conversation) => {
                  const last = conversation.messages.at(-1);
                  const snippet = last ? speechText(last.text) : "ทักมาเม้าท์กับ Vivian ได้นะ";
                  const isActive = conversation.id === activeConversationId;
                  return <div key={conversation.id} className={`conversation-row${isActive ? " is-selected" : ""}`} role="group" aria-label={conversation.title}>
                    <button type="button" className="conversation-open" aria-label={`ดูแชต ${conversation.title}`} onClick={() => setPreviewConversationId(conversation.id)}>
                      {avatar ? <img src={avatar} alt="" className="conversation-avatar" /> : <span className="conversation-avatar">V</span>}
                      <span className="conversation-meta"><strong>{conversation.title}</strong><small>{snippet}</small></span>
                      <time>{timeLabel(conversation.updatedAt)}</time>
                    </button>
                    {isActive && <span className="conversation-live" aria-label="Currently open">LIVE</span>}
                    <button type="button" className="conversation-delete" aria-label={`Delete ${conversation.title}`} onClick={() => void deleteConversation(conversation.id)}>
                      <svg aria-hidden="true" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
                    </button>
                  </div>;
                })}</div> : <p className="floating-empty">{conversations.length ? "หาแชตที่ตรงกับคำนี้ไม่เจอแฮะ" : "ยังไม่มีแชตเก่าเลย — มาเริ่มคุยกับ Vivian กัน"}</p>}
                <p role="status" className="history-status">{!history.ready ? "กำลังโหลดแชตเก่า…" : history.notice ?? "ซิงก์แชตไว้บนคลาวด์แล้ว"}</p>
              </>;
            })()}
            {panel === "memories" && <>
              <div className="bond-panel"><p><strong>มาหาทุกวัน</strong> {streak} วันติดละนะ</p><p><strong>ฟีลตอนนี้</strong>{moodLabel(companion.mood)}</p>{[["ความเอ็นดู", companion.affinity], ["ความไว้ใจ", companion.trust], ["ความสนิท", companion.familiarity]].map(([label, value]) => <div key={String(label)}><span>{label}</span><i><b style={{ width: `${value}%` }}/></i><em>{value}</em></div>)}</div>
              <section className="memory-summary-card" aria-label="สรุปความจำ">
                <div className="memory-summary-head">
                  <strong>สรุปความจำ</strong>
                  <div className="memory-summary-actions">
                    <button
                      type="button"
                      className="memory-summary-btn is-primary"
                      disabled={memorySummaryBusy !== "idle"}
                      onClick={() => void generateMemorySummary()}
                    >
                      {memorySummaryBusy === "generating" ? "กำลังสรุป…" : memorySummary ? "สรุปใหม่" : "สรุปความจำ"}
                    </button>
                    {!editingMemorySummary && (
                      <button
                        type="button"
                        className="memory-summary-btn"
                        disabled={memorySummaryBusy !== "idle"}
                        onClick={() => {
                          setMemorySummaryDraft(memorySummary);
                          setEditingMemorySummary(true);
                          setMemorySummaryNotice(null);
                        }}
                      >
                        แก้
                      </button>
                    )}
                  </div>
                </div>
                {editingMemorySummary ? (
                  <div className="memory-edit">
                    <textarea
                      value={memorySummaryDraft}
                      maxLength={2000}
                      rows={4}
                      placeholder="เขียนสรุปความจำเกี่ยวกับตัวเธอให้ Vivian จำไว้ได้เลย"
                      onChange={(event) => setMemorySummaryDraft(event.target.value)}
                    />
                    <div>
                      <button type="button" disabled={memorySummaryBusy !== "idle"} onClick={() => void saveMemorySummaryEdit()}>
                        {memorySummaryBusy === "saving" ? "กำลังเซฟ…" : "เซฟ"}
                      </button>
                      <button type="button" disabled={memorySummaryBusy !== "idle"} onClick={() => setEditingMemorySummary(false)}>
                        ยกเลิก
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className={memorySummary ? "memory-summary-text" : "memory-summary-empty"}>
                    {memorySummary || "ยังไม่มีสรุปความจำ กดปุ่ม \"สรุปความจำ\" ให้ Vivian รวบรวมเรื่องที่จำไว้ได้เลย"}
                  </p>
                )}
                {memorySummaryNotice && <p className="memory-summary-notice" role="status">{memorySummaryNotice}</p>}
              </section>
              <div className="memory-list">{memories.length ? memories.map((memory) => <article key={memory.id}><Icon name="memory" size={18}/>{editingMemoryId === memory.id ? <div className="memory-edit"><textarea value={memoryDraft} maxLength={500} onChange={(event) => setMemoryDraft(event.target.value)}/><div><button type="button" onClick={() => void saveMemory(memory)}>เซฟ</button><button type="button" onClick={() => setEditingMemoryId(null)}>ยกเลิก</button></div></div> : <><p><strong>{memory.category}</strong>{memory.memory}</p><button type="button" className="memory-edit-button" onClick={() => { setEditingMemoryId(memory.id); setMemoryDraft(memory.memory); }}>แก้</button></>}</article>) : <p className="floating-empty">ตอนนี้ยังไม่มีเรื่องที่ Vivian จดไว้เลย คุยกันไปเรื่อย ๆ เดี๋ยวก็จำได้เอง</p>}</div>
            </>}
            {panel === "character" && <>
              <div className="avatar-mode-switch" role="tablist" aria-label="โหมดตัวละคร">
                <button
                  type="button"
                  role="tab"
                  aria-selected={avatarMode === "live2d"}
                  className={avatarMode === "live2d" ? "is-selected" : ""}
                  onClick={() => switchAvatarMode("live2d")}
                >
                  Live2D
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={avatarMode === "3d"}
                  className={avatarMode === "3d" ? "is-selected" : ""}
                  onClick={() => switchAvatarMode("3d")}
                >
                  3D (VRM / FBX)
                </button>
              </div>
              <div className="floating-tabs">{(["outfit", "expression", "pose"] as const).map((tab) => <button key={tab} type="button" className={characterTab === tab ? "is-selected" : ""} onClick={() => setCharacterTab(tab)}>{tab === "outfit" ? (avatarMode === "3d" ? "โมเดล 3D" : "โมเดล") : tab === "expression" ? "สีหน้า" : "ท่าทาง"}</button>)}</div>
              {avatarMode === "live2d" ? <>
                {characterTab === "outfit" && <>
                  {modelCarouselItems.length > 0 ? <CoverflowCarousel
                    ariaLabel="Live2D models"
                    className={modelImporting ? "pointer-events-none opacity-60" : "character-model-carousel"}
                    depth={90}
                    index={modelCarouselIndex}
                    items={modelCarouselItems}
                    onIndexChange={(index) => {
                      const entry = modelCarouselEntries[index];
                      if (entry && entry.model.id !== activeModelId) {
                        setPendingModelId(entry.model.id);
                        void chooseModel(entry.model.id);
                      }
                    }}
                    rotation={32}
                    spacing={155}
                  /> : <div className="character-preview character-preview-empty"><strong>ยังไม่มีโมเดลเลย</strong><small>อัปโหลดโมเดล Live2D มาใส่ก่อนนะ</small></div>}
                  {activeModel && <p className="floating-note model-carousel-status" role="status"><span className={`load-dot ${live2dBusy ? "is-loading" : modelStatus === "ready" ? "is-ready" : "is-error"}`} aria-hidden="true" />{live2dBusy ? "กำลังโหลด Live2D…" : modelStatus === "ready" ? `Live2D พร้อมแล้ว — ${activeModel.expressions.length} สีหน้า · ${activeModel.motions.length} ท่าทาง` : "ยังไม่ได้โหลดโมเดล"}</p>}
                  {activeModel && <label className="model-select-label">ความชัดของภาพโมเดล<select value={textureQuality} onChange={(event) => { setModelNotice(null); setTextureQuality(event.target.value as "auto" | "original"); }}><option value="auto">อัตโนมัติ · พอดีกับเครื่องนี้</option><option value="original">คมชัดสุด (ไฟล์ต้นฉบับ)</option></select></label>}
                  {activeModel && <button type="button" className="floating-option" disabled={modelStatus === "loading" || graphicsLost || modelImporting} onClick={() => { void (async () => { setModelNotice(null); if (modelPaused) { setTextureQuality("auto"); await chooseModel(activeModel.id); } setModelPaused(false); setModelReload((value) => value + 1); })(); }}>โหลดโมเดลอีกรอบ</button>}
                  {activeModel && <button type="button" className="floating-option" disabled={modelStatus !== "ready"} onClick={resetModelTransform}>รีเซ็ตตำแหน่งกับขนาด</button>}
                  {activeModel && <p className="floating-note">ลากย้ายตำแหน่ง · ถ่างนิ้ว/เลื่อนลูกกลิ้งเพื่อซูม · แตะสองครั้งเพื่อรีเซ็ต</p>}
                  {textureSummary && <p className="floating-note">{textureSummary} (ไฟล์ต้นฉบับยังอยู่ครบนะ)</p>}
                  <AnimatedFileUpload
                    key={`model-upload-${modelUploadKey}`}
                    accept=".zip"
                    className="vivian-upload"
                    disabled={modelImporting || !modelsReady}
                    maxSize={512 * 1024 * 1024}
                    multiple={false}
                    onFilesSelected={(files) => {
                      const zip = files[0];
                      if (!zip) return;
                      void importModels([zip]).finally(() => setModelUploadKey((value) => value + 1));
                    }}
                    progress={modelImporting ? modelImportProgress : null}
                  />
                  <div className="model-import-actions">
                    <button className="floating-option" type="button" disabled={modelImporting || !modelsReady} onClick={() => modelFolderRef.current?.click()}>หรือเลือกเป็นโฟลเดอร์โมเดลแทนก็ได้</button>
                  </div>
                  <input ref={modelFolderRef} hidden type="file" multiple {...{ webkitdirectory: "", directory: "" }} onChange={(event) => { const input = event.currentTarget; const files = Array.from(input.files ?? []); void importModels(files).finally(() => { input.value = ""; }); }} />
                  {(() => {
                    const canUseCloudModels = account
                      ? account.capabilities.canUseCloudModels
                      : isCloudLibraryAllowed(cloudLibrary);
                    const isFreeTier = account ? account.tier === "free" : cloudLibrary?.cloudAllowed === false;
                    const isSelectedTier = account ? account.tier === "selected" : cloudLibrary?.tier === "selected";
                    const isSorachanTier = account ? account.tier === "sorachan" : cloudLibrary?.tier === "sorachan";
                    const isCloudModelPackage = Boolean(
                      activePackage && isCloudLibraryAllowed(cloudLibrary) && cloudLibrary?.models.some((model) => model.id === activePackage.id),
                    );
                    const personalUsedBytes = cloudLibrary?.personalUsage?.used ?? account?.storage.usedBytes ?? 0;
                    const personalLimitBytes = cloudLibrary?.personalUsage?.limit ?? account?.storage.limitBytes ?? 512 * 1024 * 1024;
                    return <>
                      <p className="floating-note">
                        {isFreeTier
                          ? "ลงโมเดลจาก ZIP หรือโฟลเดอร์ไว้เล่นบนเครื่องนี้ได้ปกติเลยนะ (ขอไฟล์โมเดลครบ ๆ ขนาดไม่เกิน 512 MB)"
                          : canUseCloudModels && cloudLibrary
                            ? "โมเดลที่ลงใหม่จะเซฟขึ้นคลาวด์ส่วนตัวให้เลย แล้วเก็บสำเนาไว้ในเครื่องด้วย (ขนาดไม่เกิน 512 MB)"
                            : "ตอนนี้เซฟโมเดลไว้ในเครื่องก่อนนะ เผื่อคลาวด์ยังไม่พร้อม (ขนาดไม่เกิน 512 MB)"}
                      </p>
                      {isFreeTier && (
                        <div className="tier-gate-notice" role="note">
                          <p>{CLOUD_TIER_REQUIRED_MESSAGE}</p>
                          <button type="button" className="floating-option model-import-primary" onClick={() => setRequestModalOpen(true)}>
                            ขออัปเป็น Selected
                          </button>
                        </div>
                      )}
                      {isSelectedTier && canUseCloudModels && (
                        <p className="floating-note">
                          Personal Cloud R2: {formatPersonalMb(personalUsedBytes)} / {Math.round(personalLimitBytes / (1024 * 1024))} MB
                        </p>
                      )}
                      {isSorachanTier && isCloudLibraryAllowed(cloudLibrary) && cloudLibrary?.usage && (
                        <p className="floating-note">
                          โมเดล + ฉากที่ใช้ไป: {((cloudLibrary.usage.live2d.used + cloudLibrary.usage.other.used) / 1e9).toFixed(2)} / 8 GB (เผื่อพื้นที่ว่างไว้ 2 GB กันเต็ม รวมไฟล์ที่กำลังอัปโหลดด้วยนะ)
                        </p>
                      )}
                      {activePackage && canUseCloudModels && isCloudLibraryAllowed(cloudLibrary) && !isCloudModelPackage && (
                        <button className="floating-option" type="button" disabled={modelImporting} onClick={() => { void saveActiveModelToCloud(); }}>
                          เซฟโมเดลนี้ขึ้นคลาวด์
                        </button>
                      )}
                      {activePackage && (
                        <button className="floating-option model-remove" type="button" disabled={modelImporting} onClick={() => { void removeActiveModel(); }}>
                          {isCloudModelPackage ? "ลบโมเดลนี้ออกจากคลาวด์และเครื่องนี้" : "ลบโมเดลนี้ออกจากเครื่อง"}
                        </button>
                      )}
                    </>;
                  })()}
                </>}
                {characterTab === "expression" && <>
                  <button type="button" className="floating-option" disabled={modelStatus !== "ready" || !activeExpressions.length} onClick={clearSavedExpressions}>รีเซ็ตสีหน้าที่เซฟไว้</button>
                  <p className="floating-note">จิ้มเลือกสีหน้าไว้ได้หลายอันเลยนะ รอบหน้าพอเปิดโมเดลนี้ Vivian จะจำหน้านี้ไว้ให้</p>
                  <div className="expression-grid">{activeModel?.expressions.map((expression, index) => <button type="button" key={`${expression}:${index}`} disabled={modelStatus !== "ready"} aria-pressed={activeExpressionsModelId === activeModel.id && activeExpressions.includes(expression)} onClick={() => toggleSavedExpression(expression)}>{expression.trim()}</button>)}</div>
                  {!activeModel?.expressions.length && <p className="floating-note">{activeModel ? "โมเดลนี้ไม่มีสีหน้าให้เลือกเลยแฮะ" : "ลองลงโมเดลในแท็บ โมเดล ก่อนนะ เดี๋ยวสีหน้าจะขึ้นมาให้เลือก"}</p>}
                </>}
                {characterTab === "pose" && <>
                  <button type="button" className="floating-option" disabled={modelStatus !== "ready"} onClick={() => { resetReaction(); void selectMotion(null); }}>กลับมาท่ายืนปกติ</button>
                  {!!activeModel?.poses?.length && <><p className="floating-note">ท่าโพส</p><div className="expression-grid">{activeModel.poses.map((pose) => <button type="button" key={pose} disabled={modelStatus !== "ready"} aria-pressed={activeExpressionsModelId === activeModel.id && activeExpressions.includes(pose)} onClick={() => toggleSavedExpression(pose)}>{pose}</button>)}</div></>}
                  {[...new Set(activeModel?.motions.map((motion) => motion.group) ?? [])].map((group) => <div className="model-motion-group" key={group}><p className="floating-note">{group || "ท่าทั่วไป"}</p><div className="expression-grid">{activeModel?.motions.filter((motion) => motion.group === group).map((motion) => <button type="button" key={motion.index} disabled={modelStatus !== "ready"} aria-pressed={activeMotion === `${group}:${motion.index}`} onClick={() => { if (activeMotion === `${group}:${motion.index}`) { resetReaction(); void selectMotion(null); } else void selectMotion(motion); }}>{motion.name}</button>)}</div></div>)}
                  {!activeModel?.motions.length && !activeModel?.poses?.length && <p className="floating-note">{activeModel ? "โมเดลนี้ไม่มีท่าขยับให้กดเล่นเลยอะ" : "ลองลงโมเดลในแท็บ โมเดล ก่อนนะ เดี๋ยวท่าทางจะขึ้นมาให้เลือก"}</p>}
                </>}
                {modelNotice && <p className="model-notice" role="alert">{modelNotice}</p>}
              </> : <>
                {characterTab === "outfit" && <>
                  {avatar3d.carouselItems.length > 0 ? <CoverflowCarousel
                    ariaLabel="3D VRM & FBX models"
                    className={avatar3d.modelImporting ? "pointer-events-none opacity-60" : "character-model-carousel"}
                    depth={90}
                    index={avatar3d.carouselIndex}
                    items={avatar3d.carouselItems}
                    onIndexChange={(index) => {
                      const entry = avatar3d.carouselEntries[index];
                      if (entry && entry.model.id !== avatar3d.activeModelId) {
                        avatar3d.setPendingModelId(entry.model.id);
                        void avatar3d.chooseModel(entry.model.id);
                      }
                    }}
                    rotation={32}
                    spacing={155}
                  /> : <div className="character-preview character-preview-empty"><strong>ยังไม่มีโมเดล 3D เลย</strong><small>อัปโหลดไฟล์ .vrm, .fbx หรือ .zip มาใส่ก่อนนะ</small></div>}
                  {avatar3d.activeModel && <p className="floating-note model-carousel-status" role="status"><span className={`load-dot ${avatar3d.isBusy ? "is-loading" : avatar3d.modelStatus === "ready" ? "is-ready" : "is-error"}`} aria-hidden="true" />{avatar3d.isBusy ? "กำลังโหลดโมเดล 3D…" : avatar3d.modelStatus === "ready" ? `3D ${(avatar3d.activeModel.format ?? "vrm").toUpperCase()} พร้อมแล้ว — ${avatar3d.activeExpressionsList.length} สีหน้า · ${avatar3d.activeMotionsList.length} ท่าทาง` : "ยังไม่ได้โหลดโมเดล"}</p>}
                  <label className="model-select-label">โหมดแสง 3D<select value={avatar3d.lightingMode} onChange={(event) => { avatar3d.setLightingMode(event.target.value as LightingMode); }}><option value="anime">สไตล์อนิเมะ · แสงนุ่มสีสด (VRM / MToon)</option><option value="realistic">สมจริง (PBR) · แสงเงา + สะท้อน</option></select></label>
                  {avatar3d.activeModel && <label className="model-select-label">ความชัดของภาพโมเดล<select value={avatar3d.textureQuality} onChange={(event) => { avatar3d.setModelNotice(null); avatar3d.setTextureQuality(event.target.value as "auto" | "original"); }}><option value="auto">อัตโนมัติ · พอดีกับเครื่องนี้</option><option value="original">คมชัดสุด (ความละเอียดเต็ม)</option></select></label>}
                  {avatar3d.activeModel && <button type="button" className="floating-option" disabled={avatar3d.modelStatus === "loading" || avatar3d.graphicsLost || avatar3d.modelImporting} onClick={() => { void avatar3d.reloadActiveModel(); }}>โหลดโมเดลอีกรอบ</button>}
                  {avatar3d.activeModel && <button type="button" className="floating-option" disabled={avatar3d.modelStatus !== "ready"} onClick={avatar3d.resetModelTransform}>รีเซ็ตตำแหน่งกับขนาด</button>}
                  {avatar3d.activeModel && <p className="floating-note">ลากย้ายตำแหน่ง · ถ่างนิ้ว/เลื่อนลูกกลิ้งเพื่อซูม · แตะสองครั้งเพื่อรีเซ็ต (การขยับตัวละครระบบจัดการให้เองอัตโนมัติ)</p>}
                  <AnimatedFileUpload
                    key={`model-3d-upload-${avatar3d.modelUploadKey}`}
                    accept=".vrm,.vrma,.fbx,.zip"
                    className="vivian-upload"
                    disabled={avatar3d.modelImporting || !avatar3d.modelsReady}
                    maxSize={512 * 1024 * 1024}
                    multiple={false}
                    onFilesSelected={(files) => {
                      const selected = files[0];
                      if (!selected) return;
                      void avatar3d.importModels([selected]).finally(() => avatar3d.setModelUploadKey((value) => value + 1));
                    }}
                    progress={avatar3d.modelImporting ? avatar3d.modelImportProgress : null}
                  />
                  <div className="model-import-actions">
                    <button className="floating-option" type="button" disabled={avatar3d.modelImporting || !avatar3d.modelsReady} onClick={() => modelFolder3dRef.current?.click()}>หรือเลือกเป็นโฟลเดอร์โมเดล 3D แทนก็ได้</button>
                  </div>
                  <input ref={modelFolder3dRef} hidden type="file" multiple {...{ webkitdirectory: "", directory: "" }} onChange={(event) => { const input = event.currentTarget; const files = Array.from(input.files ?? []); void avatar3d.importModels(files).finally(() => { input.value = ""; }); }} />
                  {(() => {
                    const canUseCloudModels = account
                      ? account.capabilities.canUseCloudModels
                      : isCloudLibraryAllowed(cloudLibrary);
                    const isFreeTier = account ? account.tier === "free" : cloudLibrary?.cloudAllowed === false;
                    const isSelectedTier = account ? account.tier === "selected" : cloudLibrary?.tier === "selected";
                    const isSorachanTier = account ? account.tier === "sorachan" : cloudLibrary?.tier === "sorachan";
                    const isCloudModelPackage = Boolean(
                      avatar3d.activePackage && isCloudLibraryAllowed(cloudLibrary) && cloudLibrary?.models.some((model) => model.id === avatar3d.activePackage!.id),
                    );
                    const personalUsedBytes = cloudLibrary?.personalUsage?.used ?? account?.storage.usedBytes ?? 0;
                    const personalLimitBytes = cloudLibrary?.personalUsage?.limit ?? account?.storage.limitBytes ?? 512 * 1024 * 1024;
                    return <>
                      <p className="floating-note">
                        {isFreeTier
                          ? "ลงโมเดล 3D (.vrm / .fbx / .zip หรือโฟลเดอร์) ไว้เล่นบนเครื่องนี้ได้ปกติเลยนะ (ขนาดไม่เกิน 512 MB)"
                          : canUseCloudModels && cloudLibrary
                            ? "โมเดล 3D ที่ลงใหม่จะเซฟขึ้นคลาวด์ส่วนตัวให้เลย แล้วเก็บสำเนาไว้ในเครื่องด้วย (ขนาดไม่เกิน 512 MB)"
                            : "ตอนนี้เซฟโมเดล 3D ไว้ในเครื่องก่อนนะ รองรับ .vrm, .fbx, .zip หรือโฟลเดอร์ (ไม่เกิน 512 MB)"}
                      </p>
                      {isFreeTier && (
                        <div className="tier-gate-notice" role="note">
                          <p>{CLOUD_TIER_REQUIRED_MESSAGE}</p>
                          <button type="button" className="floating-option model-import-primary" onClick={() => setRequestModalOpen(true)}>
                            ขออัปเป็น Selected
                          </button>
                        </div>
                      )}
                      {isSelectedTier && canUseCloudModels && (
                        <p className="floating-note">
                          Personal Cloud R2: {formatPersonalMb(personalUsedBytes)} / {Math.round(personalLimitBytes / (1024 * 1024))} MB
                        </p>
                      )}
                      {isSorachanTier && isCloudLibraryAllowed(cloudLibrary) && cloudLibrary?.usage && (
                        <p className="floating-note">
                          โมเดล + ฉากที่ใช้ไป: {((cloudLibrary.usage.live2d.used + cloudLibrary.usage.other.used) / 1e9).toFixed(2)} / 8 GB (เผื่อพื้นที่ว่างไว้ 2 GB กันเต็ม รวมไฟล์ที่กำลังอัปโหลดด้วยนะ)
                        </p>
                      )}
                      {avatar3d.activePackage && canUseCloudModels && isCloudLibraryAllowed(cloudLibrary) && !isCloudModelPackage && (
                        <button className="floating-option" type="button" disabled={avatar3d.modelImporting} onClick={() => { void avatar3d.saveActiveModelToCloud(); }}>
                          เซฟโมเดลนี้ขึ้นคลาวด์
                        </button>
                      )}
                      {avatar3d.activePackage && (
                        <button className="floating-option model-remove" type="button" disabled={avatar3d.modelImporting} onClick={() => { void avatar3d.removeActiveModel(); }}>
                          {isCloudModelPackage ? "ลบโมเดลนี้ออกจากคลาวด์และเครื่องนี้" : "ลบโมเดลนี้ออกจากเครื่อง"}
                        </button>
                      )}
                    </>;
                  })()}
                </>}
                {characterTab === "expression" && <>
                  <button type="button" className="floating-option" disabled={avatar3d.modelStatus !== "ready" || !avatar3d.activeExpressions.length} onClick={avatar3d.clearSavedExpressions}>รีเซ็ตสีหน้าที่เซฟไว้</button>
                  <p className="floating-note">จิ้มเลือกสีหน้าไว้ได้หลายอันเลยนะ รอบหน้าพอเปิดโมเดลนี้ Vivian จะจำหน้านี้ไว้ให้</p>
                  <div className="expression-grid">{avatar3d.activeExpressionsList.map((expression, index) => <button type="button" key={`${expression}:${index}`} disabled={avatar3d.modelStatus !== "ready"} aria-pressed={avatar3d.activeExpressionsModelId === avatar3d.activeModel?.id && avatar3d.activeExpressions.includes(expression)} onClick={() => avatar3d.toggleSavedExpression(expression)}>{expression.trim()}</button>)}</div>
                  {!avatar3d.activeExpressionsList.length && <p className="floating-note">{avatar3d.activeModel ? "โมเดลนี้ไม่มีสีหน้า/Blendshape ให้เลือกเลยแฮะ" : "ลองลงโมเดล 3D ในแท็บ โมเดล 3D ก่อนนะ เดี๋ยวสีหน้าจะขึ้นมาให้เลือก"}</p>}
                </>}
                {characterTab === "pose" && <>
                  <button type="button" className="floating-option" disabled={avatar3d.modelStatus !== "ready"} onClick={() => { resetReaction(); void avatar3d.selectMotion(null); }}>กลับมาท่ายืนปกติ</button>
                  {!!avatar3d.activeModel?.poses?.length && <><p className="floating-note">ท่าโพส</p><div className="expression-grid">{avatar3d.activeModel.poses.map((pose) => <button type="button" key={pose} disabled={avatar3d.modelStatus !== "ready"} aria-pressed={avatar3d.activeExpressionsModelId === avatar3d.activeModel?.id && avatar3d.activeExpressions.includes(pose)} onClick={() => avatar3d.toggleSavedExpression(pose)}>{pose}</button>)}</div></>}
                  {[...new Set(avatar3d.activeMotionsList.map((motion) => motion.group))].map((group) => <div className="model-motion-group" key={group}><p className="floating-note">{group || "ท่าทั่วไป"}</p><div className="expression-grid">{avatar3d.activeMotionsList.filter((motion) => motion.group === group).map((motion) => <button type="button" key={motion.index} disabled={avatar3d.modelStatus !== "ready"} aria-pressed={avatar3d.activeMotion === `${group}:${motion.index}`} onClick={() => { if (avatar3d.activeMotion === `${group}:${motion.index}`) { resetReaction(); void avatar3d.selectMotion(null); } else void avatar3d.selectMotion(motion); }}>{motion.name}</button>)}</div></div>)}
                  {!avatar3d.activeMotionsList.length && !avatar3d.activeModel?.poses?.length && <p className="floating-note">{avatar3d.activeModel ? "โมเดลนี้ใช้ท่าขยับอัตโนมัติของระบบ (ถ้าอยากเพิ่มคลิป Mocap ใส่ไฟล์ .vrma หรือ .fbx คู่ใน ZIP/โฟลเดอร์ได้เลย)" : "ลองลงโมเดล 3D ในแท็บ โมเดล 3D ก่อนนะ เดี๋ยวท่าทางจะขึ้นมาให้เลือก"}</p>}
                </>}
                {avatar3d.modelNotice && <p className="model-notice" role="alert">{avatar3d.modelNotice}</p>}
              </>}
            </>}
            {panel === "scenes" && <><SceneManager library={sceneLibrary} cloudAllowed={account ? account.capabilities.canUseCloudScenes : true} onRequestSelected={() => setRequestModalOpen(true)}/><p className="floating-note">ฉากเริ่มต้น</p><div className="scene-grid">{(Object.keys(BACKGROUNDS) as Array<keyof typeof BACKGROUNDS>).map((scene) => <button key={scene} type="button"  className={!activeCustomSceneId && selectedPreset === scene ? "is-selected" : ""} onClick={() => selectPresetScene(scene)}><span style={{ backgroundImage: `url(${BACKGROUNDS[scene]})` }}/><strong>Christmas {scene}</strong></button>)}</div></>}
            {panel === "voice" && (() => {
              const isSorachanVoice = account ? account.tier === "sorachan" : cloudLibrary?.tier === "sorachan";
              return <>
                <button type="button" className="floating-option" onClick={() => { setMuted((value) => { const next = !value; if (next) stopSpeech(); return next; }); }}>
                  <Icon name="sound" size={18}/> เสียง Vivian <strong>{muted ? "ปิดอยู่" : "เปิดอยู่"}</strong>
                </button>
                {isSorachanVoice && <>
                  <div className="custom-instructions voice-id-preferences">
                    <strong>11Labs Voice ID</strong>
                    <p>Voice ID ที่ใช้อยู่ตอนนี้ (ใช้ร่วมกันทุกเครื่อง): <code style={{ color: "#241329", background: "#e0d6ff", padding: "2px 6px", borderRadius: "4px" }}>{voiceId || "ค่าเริ่มต้น"}</code></p>
                    <div style={{ display: "flex", gap: "8px", marginTop: "4px" }}>
                      <input
                        type="text"
                        value={voiceIdInput}
                        placeholder="วาง 11Labs Voice ID ตรงนี้..."
                        onChange={(e) => setVoiceIdInput(e.target.value)}
                        style={{ flex: 1, padding: "8px 12px", borderRadius: "10px", border: "1px solid rgba(36,19,41,0.2)", background: "rgba(255,255,255,0.65)", color: "#241329", font: "inherit", fontSize: "13px" }}
                      />
                      <button
                        type="button"
                        className="floating-option"
                        style={{ margin: 0, padding: "8px 14px" }}
                        onClick={() => saveVoiceId(voiceIdInput)}
                      >
                        เซฟ
                      </button>
                    </div>
                  </div>
                  <p role="status">{voiceNotice || "เซฟแล้ว (ใช้ร่วมกันทุกเครื่อง)"}</p>
                  {voiceNotice.includes("ไม่ขึ้น") || voiceNotice.includes("ไม่ติด") ? (
                    <button type="button" onClick={() => { if (voiceNotice.includes("โหลด")) void refreshVoicePreferences(); else saveVoiceId(voiceIdInput); }}>ลองใหม่อีกที</button>
                  ) : null}
                </>}
                <button type="button" className="floating-option" onClick={() => setLanguageOpen(true)}>
                  <Icon name="language" size={18}/> ภาษาที่พูด <strong>{speechLanguage.toUpperCase()}</strong>
                </button>
                <button type="button" className="floating-option" onClick={toggleRecording}>
                  <Icon name="mic" size={18}/> ไมโครโฟน <strong>{recording ? "กำลังฟังอยู่" : "กดเพื่อพูด"}</strong>
                </button>
              </>;
            })()}
             {panel === "status" && <StorageStatusPanel account={account} onRequestSelected={() => setRequestModalOpen(true)}/>}
              {panel === "settings" && <>
                <TierSettingsCard account={account} accountEmail={accountEmail} accountId={accountId} loading={accountLoading} onOpenRequest={() => setRequestModalOpen(true)} />
                <UserProfileSettingsCard
                  profile={userProfile}
                  saving={savingUserProfile}
                  notice={userProfileNotice}
                  onOpenModal={() => setOnboardingOpen(true)}
                />
                {account?.tier === "sorachan" && account?.capabilities?.isAdmin && (
                  <SorachanAdminPanel onAccountChanged={() => { void refreshAccount(); }} />
                )}
                <div className="custom-instructions"><strong>เริ่มใหม่กับ Vivian (รีเซ็ต)</strong><p>ลบความจำ ฟีล ความสนิท และประวัติแชตทั้งหมดออกให้โล่งเลย — แต่สไตล์คุยส่วนตัวที่เธอเซ็ตไว้ยังอยู่ครบนะ</p>{resetConfirming ? <div role="alertdialog" aria-label="ยืนยันรีเซ็ต Vivian"><p>ถ้ากดยืนยัน ความจำกับแชตทั้งหมดจะหายถาวรเลยนะ แต่น้องโมเดล การตั้งค่าเสียง แล้วก็บัญชียังอยู่ครบ</p><button type="button" className="floating-option" disabled={sending || resetting} onClick={() => { void resetVivian(); }}>จัดเลย ล้างใหม่</button><button type="button" className="floating-option" onClick={() => setResetConfirming(false)}>ยกเลิก</button></div> : <button type="button" className="floating-option" disabled={sending || resetting} onClick={() => setResetConfirming(true)}>{resetting ? "กำลังล้างให้อยู่…" : "รีเซ็ตความจำและเริ่มคุยใหม่"}</button>}{resetNotice && <p role="status">{resetNotice}</p>}</div><div className="custom-instructions"><strong>ปรับนิสัย &amp; สไตล์การคุยของ Vivian</strong><p>อยากให้ Vivian พูดจาแนวไหน ขี้อ้อนขึ้น ขี้แซวขึ้น หรือเม้าท์แบบไหน พิมพ์บอกตรงนี้ได้เลย น้องจะปรับตามใจเธอเป็นหลักเลยนะ (ส่วนกติกาพื้นฐานของระบบยังเหมือนเดิม)</p><textarea aria-label="ปรับนิสัยและสไตล์การคุยของ Vivian" value={customInstructions} maxLength={2000} onChange={(event) => updateCustomInstructions(event.target.value)} placeholder="เช่น: อยากให้ Vivian คุยเป็นกันเอง ชอบแซวแบบน่ารัก เล่นมุกเก่ง ๆ ไม่ต้องคอยถามปิดท้ายทุกประโยค..."/><div className="custom-instructions-actions"><button type="button" className="floating-option" disabled={savingCustomInstructions} onClick={() => { void saveCustomInstructions(); }}>{savingCustomInstructions ? "กำลังเซฟ…" : "เซฟเลย"}</button><button type="button" className="floating-option" disabled={savingCustomInstructions || !savedCustomInstructions} onClick={() => { void clearCustomInstructions(); }}>ล้างที่ตั้งไว้</button><span role="status">{customInstructionsNotice || (!customInstructionsSynced ? "กำลังซิงก์…" : customInstructionsDirty ? "ยังไม่ได้เซฟนะ" : "ซิงก์ครบทุกเครื่องแล้ว")}</span><span role="status">{customInstructions.length} / 2000</span></div>{customInstructionVersions.length > 1 && <div className="custom-instruction-versions"><span>ที่เคยเซฟไว้ก่อนหน้า</span>{customInstructionVersions.slice(1, 4).map((v) => <button key={v.id} type="button" className="floating-option" disabled={savingCustomInstructions} onClick={() => restoreCustomInstructions(v.instructions)}>ย้อนกลับไปใช้อันเมื่อ {new Date(v.created_at).toLocaleString("th-TH")}</button>)}</div>}</div><button type="button" className="floating-option" onClick={() => setLanguageOpen(true)}><Icon name="language" size={18}/> ภาษาที่คุยกัน <strong>{speechLanguage.toUpperCase()}</strong></button><button type="button" onClick={() => setInfoOpen(true)} className="floating-option"><Icon name="info" size={18}/> เกี่ยวกับ Vivian</button>
              </>}
            {panel === "settings" && <div className="account-settings"><div><small>ล็อกอินด้วยบัญชี</small><p>{accountEmail || "กำลังเช็กบัญชีให้อยู่…"}</p></div><button type="button" onClick={async () => { const token = window.localStorage.getItem("vivian_auth_token"); window.localStorage.removeItem("vivian_auth_token"); for (const key of [CONVERSATIONS_KEY, "vivian-active-conversation", "vivian-checkin-date", "vivian-streak", "vivian-user-profile-user", "vivian-custom-instructions-user"]) window.localStorage.removeItem(key); if (token) { try { await fetch("https://vivianauth.celestiasora.workers.dev/api/logout", { method: "POST", headers: { Authorization: `Bearer ${token}` } }); } catch { /* best effort */ } } window.location.assign("/login"); }}>ออกจากระบบ <span aria-hidden="true">↗</span></button></div>}
          </div>
        </section>
      </div>
    </div>
    {languageOpen && <div className="chat-backdrop" role="presentation" onClick={() => setLanguageOpen(false)}><section className="info-sheet language-sheet" role="dialog" aria-modal="true" aria-label="ตั้งค่าภาษาที่คุยกัน" onClick={(event) => event.stopPropagation()}><div className="memory-sheet-head"><div><small>LANGUAGE LOCK</small><h1>ภาษาที่คุยกัน</h1><p>ใช้ภาษาเดียวกันทั้งตอนฟังเสียงกับตอนตอบเลย</p></div><button type="button" onClick={() => setLanguageOpen(false)} aria-label="ปิด"><Icon name="close"/></button></div><div className="language-options">{LANGUAGE_OPTIONS.map((option) => <button key={option.code} type="button" className={speechLanguage === option.code ? "is-selected" : ""} onClick={() => { saveLanguage(option.code); setLanguageOpen(false); }}><strong>{option.nativeName}</strong><span>{option.label} · {option.code.toUpperCase()}</span></button>)}</div></section></div>}
    {infoOpen && <div className="chat-backdrop" role="presentation" onClick={() => setInfoOpen(false)}><section className="info-sheet" role="dialog" aria-modal="true" aria-label="ข้อมูลแอป Vivian" onClick={(event) => event.stopPropagation()}><div className="memory-sheet-head"><div><small>VIVIAN INFO</small><h1>ข้อมูลแอป</h1><p>สเปกกับเวอร์ชันของ Vivian ที่กำลังใช้อยู่ตอนนี้</p></div><button type="button" onClick={() => setInfoOpen(false)} aria-label="ปิด"><Icon name="close"/></button></div><div className="info-list"><p><strong>ชื่อแอป</strong>Vivian AI Companion</p><p><strong>โค้ดเนม</strong>{APP_CODENAME}</p><p><strong>เวอร์ชัน</strong>vivian 3.0.0</p><p><strong>ตัวละคร</strong>Nothing</p></div></section></div>}
    <UserOnboardingModal
      open={onboardingOpen}
      profile={userProfile}
      saving={savingUserProfile}
      onSave={saveUserProfile}
      onSkip={dismissOnboarding}
    />
    <RequestSelectedModal
      open={requestModalOpen}
      account={account}
      accountEmail={accountEmail}
      accountId={accountId}
      onClose={() => setRequestModalOpen(false)}
      onSubmitted={(result) => {
        setAccount((prev) =>
          prev
            ? {
                ...prev,
                selectedRequest: result.request,
                mailtoUrl: result.mailtoUrl,
                requestEmail: result.requestEmail,
              }
            : prev,
        );
      }}
      onAccountRefresh={() => refreshAccount()}
    />
    <LimitReachedModal
      open={limitModalOpen}
      account={account}
      onClose={() => setLimitModalOpen(false)}
      onOpenRequest={() => setRequestModalOpen(true)}
    />
  </main>;
}
