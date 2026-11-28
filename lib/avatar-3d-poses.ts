/**
 * Vivian 3D Natural Motion & 24-Pose Semantic Library.
 *
 * Implements the layered semantic pipeline:
 *   LLM / Conversation State -> Semantic Motion Intent -> Pose & Emotion Resolver
 *   -> Animation Controller (vrm-procedural-mocap.ts) -> Anatomical Limits -> 3D Renderer
 *
 * Design invariants:
 *  - LLM/conversation state selects semantic pose IDs from a strict allowlist (never raw bone transforms).
 *  - Every pose declares metadata, synced facial emotion, gaze mode, transition timings, priority,
 *    and safe fallback behavior when required scene props (chair / phone) are unavailable.
 *  - Prop-dependent poses (`casual_sitting`, `phone_interaction`) resolve to safe standing fallbacks
 *    when no seat/phone prop exists rather than faking invisible objects.
 */

import type { AvatarEmotion } from "./avatar-emotion.ts";

export type SemanticPoseCategory = "idle" | "conversation" | "emotion" | "action";

export type SemanticPoseId =
  // A. Idle & natural behavior
  | "relaxed_idle"
  | "weight_shifting"
  | "natural_breathing"
  | "looking_around"
  // B. Conversation & listening
  | "explaining"
  | "attentive_listening"
  | "gentle_nodding"
  | "thinking"
  // C. Emotional expressions
  | "genuine_happiness"
  | "shy_embarrassed"
  | "confused"
  | "sad_concerned"
  | "surprised"
  | "playful_teasing"
  // D. Daily life & interactive actions
  | "greeting_wave"
  | "pointing"
  | "arms_crossed"
  | "casual_sitting"
  | "leaning_forward"
  | "stretching"
  | "hair_adjustment"
  | "natural_laughing"
  | "goodbye"
  | "phone_interaction";

/**
 * 5-tier priority model (lower number = higher priority):
 *  1 = Safety / rig reset
 *  2 = Explicit user-triggered action
 *  3 = Strong conversational reaction (surprise, laughter)
 *  4 = Conversation intent (explaining, listening, thinking)
 *  5 = Background idle behavior
 */
export type MotionPriority = 1 | 2 | 3 | 4 | 5;

export type GazeTargetMode =
  | "user"
  | "away_up"
  | "away_side"
  | "down_soft"
  | "scan"
  | "point_target";

export interface SemanticPoseDefinition {
  id: SemanticPoseId;
  category: SemanticPoseCategory;
  categoryLabelTh: string;
  labelTh: string;
  description: string;
  priority: MotionPriority;
  defaultEmotion: AvatarEmotion | null;
  gazeMode: GazeTargetMode;
  blendInSec: number;
  blendOutSec: number;
  holdSec: number;
  loopable: boolean;
  /** Whether this pose can be rendered natively without external scene props. */
  requiresProp?: "seat" | "phone";
  /** Safe fallback when required prop or rig capability is unavailable. */
  fallbackId?: SemanticPoseId;
  /** Whether to expose as a manual preview button in Character -> ท่าทาง UI. */
  showInManualUi: boolean;
}

export interface SemanticMotionIntent {
  pose_id: string;
  emotion_id?: AvatarEmotion | null;
  intensity?: number;
  gaze_target?: GazeTargetMode;
  duration?: number | null;
  priority?: MotionPriority;
}

export interface PoseResolutionContext {
  hasSeatProp?: boolean;
  hasPhoneProp?: boolean;
  activePoseId?: SemanticPoseId | null;
  activePriority?: MotionPriority | null;
}

export interface ResolvedSemanticPose {
  requestedId: string;
  resolvedId: SemanticPoseId;
  definition: SemanticPoseDefinition;
  usedFallback: boolean;
  fallbackReason?: string;
  emotion: AvatarEmotion | null;
  intensity: number;
  gazeMode: GazeTargetMode;
  durationSec: number | null;
  priority: MotionPriority;
  accepted: boolean;
}

export const SEMANTIC_POSE_CATEGORY_LABELS: Record<SemanticPoseCategory, string> = {
  idle: "ท่าพักและธรรมชาติ",
  conversation: "คุยและรับฟัง",
  emotion: "อารมณ์และความรู้สึก",
  action: "ท่าทางประจำวัน",
};

export const SEMANTIC_POSE_LIBRARY: readonly SemanticPoseDefinition[] = [
  // --- A. Idle & natural behavior ---
  {
    id: "relaxed_idle",
    category: "idle",
    categoryLabelTh: SEMANTIC_POSE_CATEGORY_LABELS.idle,
    labelTh: "ยืนพักผ่อนสบาย ๆ",
    description: "Default upright relaxed standing posture with soft weight balance and natural breathing.",
    priority: 5,
    defaultEmotion: null,
    gazeMode: "user",
    blendInSec: 0.4,
    blendOutSec: 0.4,
    holdSec: 6.0,
    loopable: true,
    showInManualUi: true,
  },
  {
    id: "weight_shifting",
    category: "idle",
    categoryLabelTh: SEMANTIC_POSE_CATEGORY_LABELS.idle,
    labelTh: "ถ่ายน้ำหนักตัว",
    description: "Slow, low-amplitude weight transfer between legs with subtle torso counterbalance.",
    priority: 5,
    defaultEmotion: null,
    gazeMode: "user",
    blendInSec: 0.45,
    blendOutSec: 0.45,
    holdSec: 5.5,
    loopable: true,
    showInManualUi: true,
  },
  {
    id: "natural_breathing",
    category: "idle",
    categoryLabelTh: SEMANTIC_POSE_CATEGORY_LABELS.idle,
    labelTh: "หายใจเป็นธรรมชาติ",
    description: "Subtle continuous chest/spine breathing without shoulder pumping.",
    priority: 5,
    defaultEmotion: null,
    gazeMode: "user",
    blendInSec: 0.4,
    blendOutSec: 0.4,
    holdSec: 6.0,
    loopable: true,
    showInManualUi: false,
  },
  {
    id: "looking_around",
    category: "idle",
    categoryLabelTh: SEMANTIC_POSE_CATEGORY_LABELS.idle,
    labelTh: "มองสำรวจรอบ ๆ",
    description: "Gaze-first smooth observation with subtle head and upper-torso follow-through.",
    priority: 5,
    defaultEmotion: "eyes",
    gazeMode: "scan",
    blendInSec: 0.4,
    blendOutSec: 0.45,
    holdSec: 4.8,
    loopable: true,
    showInManualUi: true,
  },

  // --- B. Conversation & listening ---
  {
    id: "explaining",
    category: "conversation",
    categoryLabelTh: SEMANTIC_POSE_CATEGORY_LABELS.conversation,
    labelTh: "อธิบาย / เล่าเรื่อง",
    description: "Engaged upright posture with one open relaxed hand gesturing at chest level.",
    priority: 4,
    defaultEmotion: "happy",
    gazeMode: "user",
    blendInSec: 0.35,
    blendOutSec: 0.4,
    holdSec: 4.2,
    loopable: true,
    showInManualUi: true,
  },
  {
    id: "attentive_listening",
    category: "conversation",
    categoryLabelTh: SEMANTIC_POSE_CATEGORY_LABELS.conversation,
    labelTh: "ตั้งใจฟัง",
    description: "Calm attentive stance with a gentle 6–9 degree head tilt and engaged gaze.",
    priority: 4,
    defaultEmotion: "warm" as unknown as AvatarEmotion, // resolved safely to null/happy below
    gazeMode: "user",
    blendInSec: 0.35,
    blendOutSec: 0.4,
    holdSec: 4.5,
    loopable: true,
    showInManualUi: true,
  },
  {
    id: "gentle_nodding",
    category: "conversation",
    categoryLabelTh: SEMANTIC_POSE_CATEGORY_LABELS.conversation,
    labelTh: "พยักหน้ารับเบา ๆ",
    description: "Discrete soft agreement nods from neck/head chain while keeping body steady.",
    priority: 4,
    defaultEmotion: "happy",
    gazeMode: "user",
    blendInSec: 0.25,
    blendOutSec: 0.35,
    holdSec: 2.8,
    loopable: true,
    showInManualUi: true,
  },
  {
    id: "thinking",
    category: "conversation",
    categoryLabelTh: SEMANTIC_POSE_CATEGORY_LABELS.conversation,
    labelTh: "ครุ่นคิด",
    description: "Gaze-first contemplative pose with head tilt and hand approaching chin cleanly.",
    priority: 4,
    defaultEmotion: "thinking",
    gazeMode: "away_up",
    blendInSec: 0.4,
    blendOutSec: 0.4,
    holdSec: 4.4,
    loopable: true,
    showInManualUi: true,
  },

  // --- C. Emotional expressions ---
  {
    id: "genuine_happiness",
    category: "emotion",
    categoryLabelTh: SEMANTIC_POSE_CATEGORY_LABELS.emotion,
    labelTh: "ดีใจร่าเริง",
    description: "Open joyful posture with gentle upward lift and warm cheerful expression.",
    priority: 3,
    defaultEmotion: "happy",
    gazeMode: "user",
    blendInSec: 0.3,
    blendOutSec: 0.45,
    holdSec: 3.6,
    loopable: true,
    showInManualUi: true,
  },
  {
    id: "shy_embarrassed",
    category: "emotion",
    categoryLabelTh: SEMANTIC_POSE_CATEGORY_LABELS.emotion,
    labelTh: "เขิน / ซึนเดเระ",
    description: "Soft inward posture with fingertips lightly meeting in front and shy glance away.",
    priority: 3,
    defaultEmotion: "blush",
    gazeMode: "away_side",
    blendInSec: 0.38,
    blendOutSec: 0.45,
    holdSec: 4.2,
    loopable: true,
    showInManualUi: true,
  },
  {
    id: "confused",
    category: "emotion",
    categoryLabelTh: SEMANTIC_POSE_CATEGORY_LABELS.emotion,
    labelTh: "งง / สงสัย",
    description: "Mild head tilt with a small open-palm questioning gesture.",
    priority: 3,
    defaultEmotion: "confused",
    gazeMode: "user",
    blendInSec: 0.32,
    blendOutSec: 0.4,
    holdSec: 3.6,
    loopable: true,
    showInManualUi: true,
  },
  {
    id: "sad_concerned",
    category: "emotion",
    categoryLabelTh: SEMANTIC_POSE_CATEGORY_LABELS.emotion,
    labelTh: "เศร้า / เป็นห่วง",
    description: "Restrained empathetic stance with lowered shoulders, hands softly together, gentle downcast gaze.",
    priority: 3,
    defaultEmotion: "sad",
    gazeMode: "down_soft",
    blendInSec: 0.45,
    blendOutSec: 0.5,
    holdSec: 4.4,
    loopable: true,
    showInManualUi: true,
  },
  {
    id: "surprised",
    category: "emotion",
    categoryLabelTh: SEMANTIC_POSE_CATEGORY_LABELS.emotion,
    labelTh: "ตกใจ / ว้าว",
    description: "Controlled brief recoil with both relaxed open hands rising toward chest level.",
    priority: 3,
    defaultEmotion: "surprised",
    gazeMode: "user",
    blendInSec: 0.22,
    blendOutSec: 0.42,
    holdSec: 2.8,
    loopable: true,
    showInManualUi: true,
  },
  {
    id: "playful_teasing",
    category: "emotion",
    categoryLabelTh: SEMANTIC_POSE_CATEGORY_LABELS.emotion,
    labelTh: "ขี้เล่นแซว / เท้าสะเอว",
    description: "Confident asymmetric stance with hip shift, playful tilt, and teasing index gesture.",
    priority: 3,
    defaultEmotion: "tease",
    gazeMode: "user",
    blendInSec: 0.32,
    blendOutSec: 0.4,
    holdSec: 3.8,
    loopable: true,
    showInManualUi: true,
  },

  // --- D. Daily life & interactive actions ---
  {
    id: "greeting_wave",
    category: "action",
    categoryLabelTh: SEMANTIC_POSE_CATEGORY_LABELS.action,
    labelTh: "โบกมือทักทาย",
    description: "Friendly shoulder-height wave with natural wrist follow-through and warm smile.",
    priority: 2,
    defaultEmotion: "happy",
    gazeMode: "user",
    blendInSec: 0.3,
    blendOutSec: 0.4,
    holdSec: 3.4,
    loopable: true,
    showInManualUi: true,
  },
  {
    id: "pointing",
    category: "action",
    categoryLabelTh: SEMANTIC_POSE_CATEGORY_LABELS.action,
    labelTh: "ชี้แนะนำ",
    description: "Arm reaches smoothly forward with extended index finger and oriented gaze.",
    priority: 2,
    defaultEmotion: "happy",
    gazeMode: "point_target",
    blendInSec: 0.35,
    blendOutSec: 0.4,
    holdSec: 3.4,
    loopable: true,
    showInManualUi: true,
  },
  {
    id: "arms_crossed",
    category: "action",
    categoryLabelTh: SEMANTIC_POSE_CATEGORY_LABELS.action,
    labelTh: "กอดอกครุ่นคิด",
    description: "Balanced reflective stance with forearms comfortably folded across the torso.",
    priority: 4,
    defaultEmotion: "angry",
    gazeMode: "user",
    blendInSec: 0.42,
    blendOutSec: 0.42,
    holdSec: 4.5,
    loopable: true,
    showInManualUi: true,
  },
  {
    id: "casual_sitting",
    category: "action",
    categoryLabelTh: SEMANTIC_POSE_CATEGORY_LABELS.action,
    labelTh: "นั่งคุยสบาย ๆ",
    description: "Seated conversation posture (requires a visible seat prop; falls back to relaxed_idle otherwise).",
    priority: 4,
    defaultEmotion: null,
    gazeMode: "user",
    blendInSec: 0.5,
    blendOutSec: 0.5,
    holdSec: 6.0,
    loopable: true,
    requiresProp: "seat",
    fallbackId: "relaxed_idle",
    showInManualUi: false,
  },
  {
    id: "leaning_forward",
    category: "action",
    categoryLabelTh: SEMANTIC_POSE_CATEGORY_LABELS.action,
    labelTh: "โน้มตัวตั้งใจฟัง",
    description: "Subtle engaged lean from the hips with balanced spine and attentive gaze.",
    priority: 4,
    defaultEmotion: "eyes",
    gazeMode: "user",
    blendInSec: 0.38,
    blendOutSec: 0.42,
    holdSec: 4.0,
    loopable: true,
    showInManualUi: true,
  },
  {
    id: "stretching",
    category: "action",
    categoryLabelTh: SEMANTIC_POSE_CATEGORY_LABELS.action,
    labelTh: "บิดขี้เกียจ / ยืดเส้น",
    description: "Slow, comfortable overhead stretch without locking elbows or over-arching spine.",
    priority: 2,
    defaultEmotion: "happy",
    gazeMode: "away_up",
    blendInSec: 0.55,
    blendOutSec: 0.55,
    holdSec: 4.0,
    loopable: true,
    showInManualUi: true,
  },
  {
    id: "hair_adjustment",
    category: "action",
    categoryLabelTh: SEMANTIC_POSE_CATEGORY_LABELS.action,
    labelTh: "ทัดผม / จัดผม",
    description: "Brief casual grooming gesture approaching temple/ear with safe mesh clearance.",
    priority: 2,
    defaultEmotion: "hair",
    gazeMode: "away_side",
    blendInSec: 0.38,
    blendOutSec: 0.42,
    holdSec: 3.4,
    loopable: true,
    showInManualUi: true,
  },
  {
    id: "natural_laughing",
    category: "action",
    categoryLabelTh: SEMANTIC_POSE_CATEGORY_LABELS.action,
    labelTh: "หัวเราะอย่างเป็นธรรมชาติ",
    description: "Organic laughing shoulders and loose hand near mouth without covering the whole face.",
    priority: 3,
    defaultEmotion: "laugh",
    gazeMode: "user",
    blendInSec: 0.28,
    blendOutSec: 0.42,
    holdSec: 3.4,
    loopable: true,
    showInManualUi: true,
  },
  {
    id: "goodbye",
    category: "action",
    categoryLabelTh: SEMANTIC_POSE_CATEGORY_LABELS.action,
    labelTh: "โบกมือลา",
    description: "Gentle slower farewell wave with warm smile and smooth return to idle.",
    priority: 2,
    defaultEmotion: "happy",
    gazeMode: "user",
    blendInSec: 0.35,
    blendOutSec: 0.45,
    holdSec: 3.6,
    loopable: true,
    showInManualUi: true,
  },
  {
    id: "phone_interaction",
    category: "action",
    categoryLabelTh: SEMANTIC_POSE_CATEGORY_LABELS.action,
    labelTh: "เล่นมือถือ",
    description: "Holding and interacting with a phone (requires a visible phone prop; falls back to attentive_listening).",
    priority: 4,
    defaultEmotion: null,
    gazeMode: "down_soft",
    blendInSec: 0.4,
    blendOutSec: 0.4,
    holdSec: 5.0,
    loopable: true,
    requiresProp: "phone",
    fallbackId: "attentive_listening",
    showInManualUi: false,
  },
];

// Clean up attentive_listening's defaultEmotion to a valid AvatarEmotion | null
const POSE_MAP = new Map<SemanticPoseId, SemanticPoseDefinition>();
for (const def of SEMANTIC_POSE_LIBRARY) {
  const normalized: SemanticPoseDefinition =
    def.id === "attentive_listening" ? { ...def, defaultEmotion: null } : def;
  POSE_MAP.set(normalized.id, normalized);
}

/** Legacy VRM gesture IDs mapped onto the canonical 24-pose semantic IDs for backwards compatibility. */
const LEGACY_GESTURE_ALIASES: Record<string, SemanticPoseId> = {
  shy_fidget: "shy_embarrassed",
  pout_hips: "arms_crossed",
  happy_cheer: "genuine_happiness",
  thinking_chin: "thinking",
  playful_tilt: "playful_teasing",
  surprised_gasp: "surprised",
  peace_pose: "playful_teasing",
  sad_hug: "sad_concerned",
};

export function isValidSemanticPoseId(id: string): id is SemanticPoseId {
  return POSE_MAP.has(id as SemanticPoseId);
}

export function getSemanticPoseDefinition(id: SemanticPoseId): SemanticPoseDefinition {
  return POSE_MAP.get(id) ?? POSE_MAP.get("relaxed_idle")!;
}

/**
 * Validate and resolve a SemanticMotionIntent against the 24-pose allowlist,
 * prop requirements, and priority/conflict rules.
 */
export function resolveSemanticPose(
  intent: SemanticMotionIntent,
  context: PoseResolutionContext = {},
): ResolvedSemanticPose {
  const rawId = typeof intent.pose_id === "string" ? intent.pose_id.trim() : "";
  const canonicalId: SemanticPoseId | null = isValidSemanticPoseId(rawId)
    ? rawId
    : LEGACY_GESTURE_ALIASES[rawId] ?? null;

  let resolvedId: SemanticPoseId = canonicalId ?? "relaxed_idle";
  let usedFallback = canonicalId === null;
  let fallbackReason = canonicalId === null ? `Unknown pose_id "${rawId}"` : undefined;

  let def = getSemanticPoseDefinition(resolvedId);

  // Enforce prop guards: never fake an invisible chair or phone
  if (def.requiresProp === "seat" && !context.hasSeatProp) {
    resolvedId = def.fallbackId ?? "relaxed_idle";
    def = getSemanticPoseDefinition(resolvedId);
    usedFallback = true;
    fallbackReason = "No seat prop available in scene";
  } else if (def.requiresProp === "phone" && !context.hasPhoneProp) {
    resolvedId = def.fallbackId ?? "attentive_listening";
    def = getSemanticPoseDefinition(resolvedId);
    usedFallback = true;
    fallbackReason = "No phone prop available in scene";
  }

  const priority = intent.priority ?? def.priority;
  const activePriority = context.activePriority ?? null;
  // Lower number = higher priority. Reject if a strictly higher-priority action currently owns the body.
  const accepted = activePriority === null || priority <= activePriority;

  const intensity = Math.max(0.15, Math.min(1.25, intent.intensity ?? 0.85));
  const emotion = intent.emotion_id !== undefined ? intent.emotion_id : def.defaultEmotion;
  const gazeMode = intent.gaze_target ?? def.gazeMode;
  const durationSec = intent.duration !== undefined ? intent.duration : def.holdSec;

  return {
    requestedId: rawId,
    resolvedId,
    definition: def,
    usedFallback,
    fallbackReason,
    emotion,
    intensity,
    gazeMode,
    durationSec,
    priority,
    accepted,
  };
}

export interface ConversationPoseInput {
  emotion: AvatarEmotion;
  userText?: string;
  reply?: string;
  intensity?: number;
}

const GREETING_RE = /\b(hi|hello|hey|morning|evening)\b|สวัสดี|หวัดดี|มอนิ่ง|อรุณสวัสดิ์|ดีจ้า|ทักทาย/i;
const GOODBYE_RE = /\b(bye|goodbye|see ya|good night|gn)\b|บาย|ลาก่อน|ฝันดี|ไปนอน|ไว้เจอกัน/i;
const EXPLAIN_RE = /เพราะว่า|อธิบาย|วิธี|ขั้นตอน|สรุปคือ|หมายถึง|basically|because|here'?s how/i;

/**
 * Deterministic conversation-intent mapper: combines detected emotion + conversational context
 * into a semantic pose intent without relying solely on brittle keywords.
 */
export function resolveConversationPoseIntent(input: ConversationPoseInput): SemanticMotionIntent {
  const combined = `${input.userText ?? ""} ${input.reply ?? ""}`;
  const intensity = Math.max(0.35, Math.min(1.15, (input.intensity ?? 55) / 70));

  if (GOODBYE_RE.test(combined)) {
    return { pose_id: "goodbye", emotion_id: "happy", intensity, priority: 2 };
  }
  if (GREETING_RE.test(input.userText ?? "") && (input.emotion === "happy" || input.emotion === "eyes")) {
    return { pose_id: "greeting_wave", emotion_id: "happy", intensity, priority: 2 };
  }

  switch (input.emotion) {
    case "laugh":
      return { pose_id: "natural_laughing", emotion_id: "laugh", intensity, priority: 3 };
    case "happy":
      return EXPLAIN_RE.test(input.reply ?? "")
        ? { pose_id: "explaining", emotion_id: "happy", intensity, priority: 4 }
        : { pose_id: "genuine_happiness", emotion_id: "happy", intensity, priority: 3 };
    case "blush":
    case "love":
      return { pose_id: "shy_embarrassed", emotion_id: input.emotion, intensity, priority: 3 };
    case "surprised":
      return { pose_id: "surprised", emotion_id: "surprised", intensity, priority: 3 };
    case "sad":
      return { pose_id: "sad_concerned", emotion_id: "sad", intensity: Math.min(intensity, 0.8), priority: 3 };
    case "angry":
      return { pose_id: "arms_crossed", emotion_id: "angry", intensity, priority: 3 };
    case "tease":
      return { pose_id: "playful_teasing", emotion_id: "tease", intensity, priority: 3 };
    case "thinking":
      return { pose_id: "thinking", emotion_id: "thinking", intensity, priority: 4 };
    case "confused":
      return { pose_id: "confused", emotion_id: "confused", intensity, priority: 3 };
    case "hair":
      return { pose_id: "hair_adjustment", emotion_id: "hair", intensity, priority: 2 };
    default:
      if (EXPLAIN_RE.test(input.reply ?? "")) {
        return { pose_id: "explaining", emotion_id: null, intensity: 0.75, priority: 4 };
      }
      return { pose_id: "attentive_listening", emotion_id: null, intensity: 0.65, priority: 4 };
  }
}
