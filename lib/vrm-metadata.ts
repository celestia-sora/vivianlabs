/**
 * Lightweight binary metadata inspector for VRM (GLB 2.0) and FBX files.
 * Runs in both browser and Node without booting Three.js / WebGL, so package
 * validation, IndexedDB catalog creation, and tests stay fast and isolated.
 */

export type ModelFormat = "vrm" | "fbx";

export interface VrmMetadata {
  version: "1.0" | "0.x" | "glb";
  name?: string;
  expressions: string[];
  thumbnailBytes?: Uint8Array;
  thumbnailMime?: string;
}

const GLB_MAGIC = 0x46546c67; // "glTF"
const GLB_JSON_CHUNK = 0x4e4f534a; // "JSON"
const GLB_BIN_CHUNK = 0x004e4942; // "BIN\0"

const SYSTEM_VRM_EXPRESSIONS = new Set([
  "aa", "ih", "ou", "ee", "oh",
  "a", "i", "u", "e", "o",
  "blink", "blinkleft", "blinkright", "blink_l", "blink_r",
  "lookup", "lookdown", "lookleft", "lookright",
]);

export function isSystemExpressionName(name: string): boolean {
  return SYSTEM_VRM_EXPRESSIONS.has(name.trim().toLowerCase());
}

/**
 * Parse the GLB header + JSON chunk of a VRM file (supports both VRM 1.0
 * `VRMC_vrm` and VRM 0.x `VRM` extensions), extracting display name,
 * selectable expressions, and any embedded thumbnail image bytes.
 */
export function inspectVrmBuffer(bytes: Uint8Array): VrmMetadata {
  if (bytes.byteLength < 20) {
    throw new Error("ไฟล์ VRM ไม่สมบูรณ์ (ขนาดไฟล์เล็กเกินไป)");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0, true);
  const version = view.getUint32(4, true);
  if (magic !== GLB_MAGIC || version !== 2) {
    throw new Error("ไฟล์นี้ไม่ใช่ VRM (glTF Binary v2) ที่ถูกต้อง");
  }

  let offset = 12;
  let jsonChunk: Uint8Array | null = null;
  let binChunk: Uint8Array | null = null;

  while (offset + 8 <= bytes.byteLength) {
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkLength;
    if (dataEnd > bytes.byteLength) break;
    if (chunkType === GLB_JSON_CHUNK && !jsonChunk) {
      jsonChunk = bytes.subarray(dataStart, dataEnd);
    } else if (chunkType === GLB_BIN_CHUNK && !binChunk) {
      binChunk = bytes.subarray(dataStart, dataEnd);
    }
    offset = dataEnd;
  }

  if (!jsonChunk) {
    throw new Error("ไม่พบข้อมูล JSON ในไฟล์ VRM นี้");
  }

  let gltf: Record<string, unknown>;
  try {
    gltf = JSON.parse(new TextDecoder().decode(jsonChunk)) as Record<string, unknown>;
  } catch {
    throw new Error("อ่านข้อมูลโครงสร้าง VRM ไม่สำเร็จ");
  }

  const extensions = (gltf.extensions && typeof gltf.extensions === "object"
    ? gltf.extensions
    : {}) as Record<string, unknown>;

  const vrm1 = extensions.VRMC_vrm as Record<string, unknown> | undefined;
  const vrm0 = extensions.VRM as Record<string, unknown> | undefined;

  let vrmVersion: VrmMetadata["version"] = "glb";
  let name: string | undefined;
  const expressions: string[] = [];
  let thumbnailImageIndex: number | undefined;

  if (vrm1 && typeof vrm1 === "object") {
    vrmVersion = "1.0";
    const meta = vrm1.meta as Record<string, unknown> | undefined;
    if (typeof meta?.name === "string" && meta.name.trim()) {
      name = meta.name.trim();
    }
    if (typeof meta?.thumbnailImage === "number" && Number.isInteger(meta.thumbnailImage)) {
      thumbnailImageIndex = meta.thumbnailImage;
    }
    const expr = vrm1.expressions as {
      preset?: Record<string, unknown>;
      custom?: Record<string, unknown>;
    } | undefined;
    for (const key of Object.keys(expr?.preset ?? {})) {
      if (!isSystemExpressionName(key) && !expressions.includes(key)) expressions.push(key);
    }
    for (const key of Object.keys(expr?.custom ?? {})) {
      if (!isSystemExpressionName(key) && !expressions.includes(key)) expressions.push(key);
    }
  } else if (vrm0 && typeof vrm0 === "object") {
    vrmVersion = "0.x";
    const meta = vrm0.meta as Record<string, unknown> | undefined;
    if (typeof meta?.title === "string" && meta.title.trim()) {
      name = meta.title.trim();
    }
    if (typeof meta?.texture === "number" && Number.isInteger(meta.texture)) {
      const textures = Array.isArray(gltf.textures) ? gltf.textures as Array<{ source?: number }> : [];
      const source = textures[meta.texture]?.source;
      if (typeof source === "number" && Number.isInteger(source)) {
        thumbnailImageIndex = source;
      }
    }
    const blendShapeMaster = vrm0.blendShapeMaster as {
      blendShapeGroups?: Array<{ name?: string; presetName?: string }>;
    } | undefined;
    for (const group of blendShapeMaster?.blendShapeGroups ?? []) {
      const label = (typeof group.presetName === "string" && group.presetName !== "unknown" && group.presetName.trim())
        ? group.presetName.trim()
        : (typeof group.name === "string" ? group.name.trim() : "");
      if (label && !isSystemExpressionName(label) && !expressions.includes(label)) {
        expressions.push(label);
      }
    }
  }

  let thumbnailBytes: Uint8Array | undefined;
  let thumbnailMime: string | undefined;
  if (thumbnailImageIndex !== undefined && binChunk) {
    const images = Array.isArray(gltf.images)
      ? gltf.images as Array<{ bufferView?: number; mimeType?: string }>
      : [];
    const bufferViews = Array.isArray(gltf.bufferViews)
      ? gltf.bufferViews as Array<{ byteOffset?: number; byteLength?: number }>
      : [];
    const image = images[thumbnailImageIndex];
    const bv = typeof image?.bufferView === "number" ? bufferViews[image.bufferView] : undefined;
    if (bv && typeof bv.byteLength === "number" && bv.byteLength > 0 && bv.byteLength <= 16 * 1024 * 1024) {
      const start = bv.byteOffset ?? 0;
      const end = start + bv.byteLength;
      if (start >= 0 && end <= binChunk.byteLength) {
        thumbnailBytes = binChunk.slice(start, end);
        thumbnailMime = typeof image?.mimeType === "string" ? image.mimeType : "image/png";
      }
    }
  }

  return { version: vrmVersion, name, expressions, thumbnailBytes, thumbnailMime };
}

/** Validate whether a buffer starts with a Binary or ASCII FBX header. */
export function isFbxBuffer(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 18) return false;
  const head = new TextDecoder("ascii", { fatal: false }).decode(bytes.subarray(0, Math.min(256, bytes.byteLength)));
  if (head.startsWith("Kaydara FBX Binary")) return true;
  if (/;\s*FBX\s/i.test(head) || /FBXHeaderExtension\s*:/i.test(head)) return true;
  return false;
}

const MOTION_DIR_PATTERN = /(?:^|\/)(?:motions?|animations?|anims?|poses?|mixamo)\//i;
const MOTION_FILE_PATTERN = /(?:^|[_\-\s.])(?:anim|animation|motion|idle|wave|dance|walk|run|jump|bow|cheer|clap|sit|stand|talk|greeting|happy|sad|angry|shy|think)(?:[_\-\s.]|$)/i;

/**
 * Determine whether an `.fbx` file inside a multi-file package is a companion
 * animation clip rather than a standalone avatar character.
 */
export function isCompanionMotionFbx(path: string, allAvatarCandidates: readonly string[]): boolean {
  if (!/\.fbx$/i.test(path)) return false;
  const hasVrm = allAvatarCandidates.some((candidate) => /\.vrm$/i.test(candidate));
  const otherFbx = allAvatarCandidates.filter((candidate) => /\.fbx$/i.test(candidate) && candidate !== path);
  if (!hasVrm && otherFbx.length === 0) return false;
  if (MOTION_DIR_PATTERN.test(path)) return true;
  if (hasVrm) {
    // When a VRM avatar is present alongside FBX files, FBX files in the same
    // package are very commonly Mixamo/retargetable animation clips unless
    // explicitly placed in a separate avatar/outfit folder.
    const filename = path.split("/").at(-1)?.replace(/\.fbx$/i, "") ?? "";
    if (MOTION_FILE_PATTERN.test(filename)) return true;
  }
  return false;
}

/** Validate whether a buffer starts with a glTF 2.0 Binary header (used by .vrma animations). */
export function isVrmaBuffer(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 12) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(0, true) === GLB_MAGIC && view.getUint32(4, true) === 2;
}

export function isVrmaPath(path: string): boolean {
  return /\.vrma$/i.test(path);
}

export function modelFormatFromPath(path: string): ModelFormat | null {
  if (/\.vrm$/i.test(path)) return "vrm";
  if (/\.fbx$/i.test(path)) return "fbx";
  return null;
}
