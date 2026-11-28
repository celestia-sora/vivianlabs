/** Validated 3D VRM & FBX packages; originals stay in IndexedDB and may sync to private R2. */
import {
  inspectVrmBuffer,
  isCompanionMotionFbx,
  isFbxBuffer,
  isVrmaBuffer,
  isVrmaPath,
  modelFormatFromPath,
  type ModelFormat,
} from "./vrm-metadata.ts";

export type { ModelFormat };
export interface ModelAsset { path: string; blob: Blob }
export interface ModelMotion { group: string; index: number; name: string; path?: string }
export interface LocalModel {
  id: string;
  name: string;
  format: ModelFormat;
  manifestPath: string;
  expressions: string[];
  poses: string[];
  motions: ModelMotion[];
  previewPath?: string;
}
export interface ModelPackage {
  id: string;
  assets: ModelAsset[];
  models: LocalModel[];
  cloudOwner?: string;
  renderRevision?: string;
}
export interface ModelSelectionRecord { modelId: string; lastSelectedAt: number; revision: number }

/** Resolve a saved selection against the packages available in this startup snapshot. */
export function resolveStartupModel(packages: ModelPackage[], savedId: string | null, selection: ModelSelectionRecord | null): string | null {
  const available = new Set(packages.flatMap((pack) => pack.models.map((model) => model.id)));
  if (selection && available.has(selection.modelId)) return selection.modelId;
  if (savedId && available.has(savedId)) return savedId;
  return packages.flatMap((pack) => pack.models).at(-1)?.id ?? null;
}

export function readModelSelection(storage: Pick<Storage, "getItem">): ModelSelectionRecord | null {
  try {
    const raw = storage.getItem("vivian-model-selection-3d");
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<ModelSelectionRecord>;
    return typeof value.modelId === "string" && Number.isFinite(value.lastSelectedAt) && Number.isSafeInteger(value.revision)
      ? value as ModelSelectionRecord : null;
  } catch { return null; }
}

export function writeModelSelection(storage: Pick<Storage, "getItem" | "setItem">, modelId: string): ModelSelectionRecord {
  const prior = readModelSelection(storage);
  const record = { modelId, lastSelectedAt: Date.now(), revision: (prior?.revision ?? 0) + 1 };
  storage.setItem("vivian-model-selection-3d", JSON.stringify(record));
  storage.setItem("vivian-local-model-3d", modelId);
  return record;
}

const MAX_BYTES = 512 * 1024 * 1024;
const MAX_FILES = 3000;
const IMAGE = /\.(png|jpe?g|webp|gif)$/i;
const MODEL_FILE = /\.(vrm|fbx)$/i;

export function normalizePath(path: string): string {
  if (/^(?:[a-z][\w+.-]*:|\/|\\)/i.test(path) || /[\0]/.test(path)) throw new Error(`Invalid local asset path: ${path}`);
  const result: string[] = [];
  for (const part of path.replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!result.length) throw new Error("Asset path leaves the model package.");
      result.pop();
    } else result.push(part);
  }
  return result.join("/");
}

export function resolveAsset(manifestPath: string, reference: string): string {
  if (/^(?:[a-z][\w+.-]*:|\/|\\)/i.test(reference)) throw new Error("Models must reference local assets only.");
  return normalizePath(manifestPath.slice(0, manifestPath.lastIndexOf("/") + 1) + reference);
}

function fileLabel(path: string): string {
  return path.split("/").at(-1)!.replace(/\.(?:vrm|vrma|fbx)$/i, "");
}

const TEXTURE_IMAGE = /(?:^|\/)textures?\//i;
const TEXTURE_NAME = /(?:^|[_\-\s.])(?:tex|texture|diffuse|albedo|basecolor|base_color|color|normal|nrm|bump|rough|roughness|metal|metallic|spec|specular|ao|ambient|emissive|alpha|mask|uv|atlas)(?:[_\-\s.]|$)/i;

function isLikelyTextureImage(path: string): boolean {
  if (TEXTURE_IMAGE.test(path)) return true;
  const stem = path.split("/").at(-1)?.replace(IMAGE, "") ?? "";
  return TEXTURE_NAME.test(stem);
}

function previewScore(path: string, directory: string): number {
  const filename = path.slice(directory.length);
  if (/(?:preview|thumbnail|thumb|icon|portrait|cover|预览|封面|立绘|サムネ|アイコン)/i.test(filename)) {
    return 10 + (filename.includes("/") ? 0 : 1);
  }
  return 0;
}

function mime(path: string): string {
  if (/\.vrma?$/i.test(path)) return "model/gltf-binary";
  if (/\.fbx$/i.test(path)) return "application/octet-stream";
  if (/\.png$/i.test(path)) return "image/png";
  if (/\.jpe?g$/i.test(path)) return "image/jpeg";
  if (/\.webp$/i.test(path)) return "image/webp";
  if (/\.gif$/i.test(path)) return "image/gif";
  if (/\.tga$/i.test(path)) return "image/x-tga";
  if (/\.bmp$/i.test(path)) return "image/bmp";
  if (/\.json$/i.test(path)) return "application/json";
  if (/\.wav$/i.test(path)) return "audio/wav";
  if (/\.mp3$/i.test(path)) return "audio/mpeg";
  if (/\.ogg$/i.test(path)) return "audio/ogg";
  return "application/octet-stream";
}

function extensionForImageMime(mimeType: string): string {
  if (/jpeg|jpg/i.test(mimeType)) return "jpg";
  if (/webp/i.test(mimeType)) return "webp";
  return "png";
}

const RUNTIME_3D_ASSET = /\.(?:vrm|vrma|fbx|png|jpe?g|webp|gif|tga|bmp|json|wav|mp3|ogg)$/i;

/**
 * Inspect and validate a 3D model package containing `.vrm` and/or `.fbx` files,
 * optional textures, optional preview images, and optional companion `.vrma` / `.fbx`
 * animation clips.
 */
export async function inspectPackage(rawAssets: ModelAsset[], id = crypto.randomUUID()): Promise<ModelPackage> {
  if (rawAssets.length > MAX_FILES || rawAssets.reduce((sum, asset) => sum + asset.blob.size, 0) > MAX_BYTES) {
    throw new Error("ขนาดแพ็กเกจโมเดลเกินกำหนด (สูงสุด 512 MB และ 3,000 ไฟล์)");
  }
  const assetsByPath = new Map<string, ModelAsset>();
  for (const raw of rawAssets) {
    const normalized = normalizePath(raw.path);
    if (!normalized) continue;
    // Ignore macOS metadata folders inside ZIPs.
    if (normalized.startsWith("__MACOSX/") || normalized.split("/").at(-1)?.startsWith("._")) continue;
    const existing = assetsByPath.get(normalized);
    if (existing) {
      if (MODEL_FILE.test(normalized)) {
        throw new Error(`พบไฟล์โมเดลชื่อซ้ำในแพ็กเกจ: ${normalized}`);
      }
      // Sketchfab ZIPs occasionally truncate long texture filenames so two
      // entries share the same path; keep the larger (typically base color) file.
      if (raw.blob.size > existing.blob.size) {
        assetsByPath.set(normalized, { path: normalized, blob: raw.blob });
      }
      continue;
    }
    assetsByPath.set(normalized, { path: normalized, blob: raw.blob });
  }
  const assets = [...assetsByPath.values()];
  const paths = new Set(assetsByPath.keys());

  const candidateAssets = assets.filter((asset) => MODEL_FILE.test(asset.path));
  if (!candidateAssets.length) {
    throw new Error("ไม่พบไฟล์ .vrm หรือ .fbx ในไฟล์ที่เลือก กรุณาเลือกไฟล์ 3D VRM หรือ FBX");
  }

  const candidatePaths = candidateAssets.map((asset) => asset.path);
  const avatarAssets: ModelAsset[] = [];
  const motionAssets: ModelAsset[] = [];

  for (const asset of candidateAssets) {
    if (isCompanionMotionFbx(asset.path, candidatePaths)) {
      motionAssets.push(asset);
    } else {
      avatarAssets.push(asset);
    }
  }
  // Also discover native VRM Animation (.vrma) companion mocap clips in the package.
  for (const asset of assets) {
    if (isVrmaPath(asset.path)) {
      motionAssets.push(asset);
    }
  }
  // Safety net: if all FBX files looked like motions, treat them as selectable avatars.
  if (!avatarAssets.length) {
    avatarAssets.push(...motionAssets.filter((m) => !isVrmaPath(m.path)));
    motionAssets.splice(0, motionAssets.length, ...motionAssets.filter((m) => isVrmaPath(m.path)));
  }

  // Validate companion motion headers quickly.
  for (const motionAsset of motionAssets) {
    const header = new Uint8Array(await motionAsset.blob.slice(0, 256).arrayBuffer());
    if (isVrmaPath(motionAsset.path)) {
      if (!isVrmaBuffer(header)) {
        throw new Error(`ไฟล์อนิเมชัน VRMA ไม่ถูกต้อง: ${motionAsset.path}`);
      }
    } else if (!isFbxBuffer(header)) {
      throw new Error(`ไฟล์อนิเมชัน FBX ไม่ถูกต้อง: ${motionAsset.path}`);
    }
  }

  const models: LocalModel[] = [];
  const syntheticAssets: ModelAsset[] = [];

  for (const asset of avatarAssets) {
    const format = modelFormatFromPath(asset.path);
    if (!format) continue;

    let displayName = fileLabel(asset.path);
    let expressions: string[] = [];
    let embeddedThumb: { bytes: Uint8Array; mime: string } | undefined;

    if (format === "vrm") {
      // Read the full VRM bytes only once during inspection to parse GLB JSON + embedded thumbnail.
      const bytes = new Uint8Array(await asset.blob.arrayBuffer());
      const meta = inspectVrmBuffer(bytes);
      if (meta.name) displayName = meta.name;
      expressions = meta.expressions;
      if (meta.thumbnailBytes && meta.thumbnailMime) {
        embeddedThumb = { bytes: meta.thumbnailBytes, mime: meta.thumbnailMime };
      }
    } else {
      const header = new Uint8Array(await asset.blob.slice(0, 256).arrayBuffer());
      if (!isFbxBuffer(header)) {
        throw new Error(`ไฟล์นี้ไม่ใช่ FBX ที่ถูกต้อง: ${asset.path}`);
      }
    }

    const directory = asset.path.slice(0, asset.path.lastIndexOf("/") + 1);
    const imageCandidates = assets.filter(
      (file) => IMAGE.test(file.path) && file.path.startsWith(directory) && !isLikelyTextureImage(file.path),
    );
    const modelStem = fileLabel(asset.path).toLowerCase();
    const score = (path: string) =>
      previewScore(path, directory)
      + (path.slice(directory.length).replace(IMAGE, "").toLowerCase() === modelStem ? 5 : 0);
    const matchedPreview = [...imageCandidates].sort((a, b) => score(b.path) - score(a.path))[0];
    let previewPath = matchedPreview && (score(matchedPreview.path) > 0 || imageCandidates.length === 1)
      ? matchedPreview.path
      : undefined;

    if (!previewPath && embeddedThumb) {
      const ext = extensionForImageMime(embeddedThumb.mime);
      const syntheticPath = `${directory}__vrm_thumb_${models.length}.${ext}`;
      if (!paths.has(syntheticPath)) {
        paths.add(syntheticPath);
        syntheticAssets.push({
          path: syntheticPath,
          blob: new Blob([new Uint8Array(embeddedThumb.bytes)], { type: embeddedThumb.mime }),
        });
      }
      previewPath = syntheticPath;
    }

    // Attach companion FBX and (for VRM) VRMA motions located in the same package/folder.
    const compatibleMotions = format === "vrm"
      ? motionAssets
      : motionAssets.filter((m) => !isVrmaPath(m.path));
    const motions: ModelMotion[] = compatibleMotions.map((motion, index) => {
      const parts = motion.path.split("/");
      const parent = parts.length >= 2 ? parts[parts.length - 2] : (isVrmaPath(motion.path) ? "VRM Animation" : "Motions");
      const group = /^(?:motions?|animations?|anims?|mixamo|vrma)$/i.test(parent) ? "Animations" : parent;
      return {
        group,
        index,
        name: fileLabel(motion.path),
        path: motion.path,
      };
    });

    const poses = expressions.filter((name) => /(?:pose|sit|stand|kneel|wink|peace|ท่านั่ง|ท่ายืน)/i.test(name));

    models.push({
      id: `${id}:${asset.path}`,
      name: displayName,
      format,
      manifestPath: asset.path,
      expressions,
      poses,
      motions,
      previewPath,
    });
  }

  return { id, assets: [...assets, ...syntheticAssets], models };
}

/**
 * Unwrap nested `.zip` archives (common in Sketchfab downloads where `source/*.zip`
 * wraps the `.fbx`/`.vrm` alongside outer `textures/`) while keeping only runtime 3D
 * assets and deduplicating overlapping paths.
 */
async function unwrapNestedZipAssets(assets: ModelAsset[], onProgress?: (ratio: number) => void): Promise<ModelAsset[]> {
  if (assets.some((asset) => MODEL_FILE.test(asset.path))) return assets;
  const nestedZips = assets.filter((asset) => /\.zip$/i.test(asset.path));
  if (!nestedZips.length) return assets;

  const { extractModelZip } = await import("./model-zip.ts");
  const merged = new Map<string, ModelAsset>();
  let totalBytes = 0;

  // Keep non-zip outer files first (e.g., `textures/*.png`)
  for (const asset of assets) {
    if (/\.zip$/i.test(asset.path)) continue;
    if (!RUNTIME_3D_ASSET.test(asset.path)) continue;
    const norm = normalizePath(asset.path);
    if (!norm || norm.startsWith("__MACOSX/")) continue;
    merged.set(norm, { path: norm, blob: asset.blob });
    totalBytes += asset.blob.size;
  }

  for (const nested of nestedZips) {
    if (nested.blob.size > MAX_BYTES) throw new Error("ไฟล์ ZIP ด้านในใหญ่เกิน 512 MB");
    const nestedFile = new File([nested.blob], nested.path.split("/").at(-1) ?? "nested.zip", { type: "application/zip" });
    const extracted = await extractModelZip(nestedFile, MAX_BYTES, MAX_FILES, onProgress);
    const parentDir = nested.path.slice(0, nested.path.lastIndexOf("/") + 1);
    const preferredPaths = extracted.paths[0];

    for (const entry of extracted.assets) {
      const decodedPath = preferredPaths?.get(entry.path) ?? entry.path;
      const clean = normalizePath(decodedPath);
      if (!clean || clean.startsWith("__MACOSX/") || clean.split("/").at(-1)?.startsWith("._")) continue;
      if (!RUNTIME_3D_ASSET.test(clean)) continue;
      const scopedPath = normalizePath(parentDir + clean);
      if (merged.has(scopedPath)) continue;
      totalBytes += entry.blob.size;
      if (totalBytes > MAX_BYTES || merged.size >= MAX_FILES) {
        throw new Error("ขนาดแพ็กเกจโมเดลเกินกำหนด (สูงสุด 512 MB และ 3,000 ไฟล์)");
      }
      merged.set(scopedPath, { path: scopedPath, blob: new Blob([entry.blob], { type: mime(scopedPath) }) });
    }
  }

  return [...merged.values()];
}

export async function importModelFiles(files: File[], onProgress?: (ratio: number) => void): Promise<ModelPackage> {
  if (!files.length) throw new Error("เลือกไฟล์ .vrm, .fbx, .zip หรือโฟลเดอร์โมเดล 3D ก่อนนะ");
  let assets: ModelAsset[];
  if (files.length === 1 && /\.zip$/i.test(files[0].name)) {
    if (files[0].size > MAX_BYTES) throw new Error("ไฟล์ ZIP ใหญ่เกิน 512 MB");
    const { extractModelZip } = await import("./model-zip.ts");
    const extracted = await extractModelZip(files[0], MAX_BYTES, MAX_FILES, onProgress ? (ratio) => onProgress(ratio * 0.7) : undefined);
    assets = extracted.assets.map((asset) => ({ path: asset.path, blob: new Blob([asset.blob], { type: mime(asset.path) }) }));
    let pathError: unknown;
    for (const paths of extracted.paths) {
      try {
        const mapped = assets.map((asset) => ({ ...asset, path: paths.get(asset.path) ?? asset.path }));
        const unwrapped = await unwrapNestedZipAssets(mapped, onProgress ? (ratio) => onProgress(0.7 + ratio * 0.3) : undefined);
        return await inspectPackage(unwrapped);
      } catch (error) { pathError ??= error; }
    }
    throw pathError;
  } else {
    assets = files.map((file) => ({ path: file.webkitRelativePath || file.name, blob: file }));
    assets = await unwrapNestedZipAssets(assets, onProgress);
  }
  return inspectPackage(assets);
}

export interface Model3DResources {
  format: ModelFormat;
  entryPath: string;
  entryUrl: string;
  companionMotionUrls: Array<{ group: string; index: number; name: string; path: string; url: string }>;
  resolveAssetUrl: (requestedUrl: string) => string | null;
  findTextureForMaterial: (materialName: string) => string | null;
  dispose: () => void;
}

const NON_COLOR_MAP = /(?:^|[_\-\s.])(?:normal|nrm|nor|bump|rough|roughness|metal|metallic|spec|specular|gloss|ao|ambient|occlusion|emissive|emit|opacity|alpha|height|disp|displacement)(?:[_\-\s.]|$)/i;
const COLOR_MAP_HINT = /(?:^|[_\-\s.])(?:baseco\w*|base_?col\w*|albedo|diffuse|diff|color|col|tex|d)(?:[_\-\s.]|$)/i;
const PREVIEW_IMAGE_NAME = /(?:^|[_\-\s./])(?:__vrm_thumb_|preview|thumbnail|thumb|icon|portrait|cover)/i;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Create scoped revocable Blob URLs for a 3D VRM or FBX model and all of its
 * companion assets/textures inside `pack`. External URLs are never fetched.
 */
export async function createModelResources(pack: ModelPackage, model: LocalModel): Promise<Model3DResources> {
  const entry = pack.assets.find((item) => item.path === model.manifestPath);
  if (!entry) throw new Error("ไม่พบไฟล์โมเดล 3D หลักในแพ็กเกจ");

  const urls = new Map<string, string>();
  const createdBlobUrls = new Set<string>();
  let disposed = false;

  const urlForAsset = (asset: ModelAsset): string => {
    if (disposed) throw new Error("Model resources have been released.");
    let existing = urls.get(asset.path);
    if (!existing) {
      existing = URL.createObjectURL(new Blob([asset.blob], { type: asset.blob.type || mime(asset.path) }));
      urls.set(asset.path, existing);
      createdBlobUrls.add(existing);
    }
    return existing;
  };

  // Pre-index assets by normalized lowercase path and basename for FBX external textures.
  const byLowerPath = new Map<string, ModelAsset>();
  const byBaseName = new Map<string, ModelAsset>();
  const textureCandidates: Array<{ asset: ModelAsset; stem: string }> = [];
  for (const asset of pack.assets) {
    byLowerPath.set(asset.path.toLowerCase(), asset);
    const base = asset.path.split("/").at(-1)?.toLowerCase();
    if (base && !byBaseName.has(base)) byBaseName.set(base, asset);
    if (IMAGE.test(asset.path) && !PREVIEW_IMAGE_NAME.test(asset.path)) {
      const stem = (base ?? "").replace(IMAGE, "");
      if (stem) textureCandidates.push({ asset, stem });
    }
  }

  const baseDir = model.manifestPath.slice(0, model.manifestPath.lastIndexOf("/") + 1);
  const entryUrl = urlForAsset(entry);

  const companionMotionUrls = (model.motions ?? [])
    .filter((motion): motion is ModelMotion & { path: string } => typeof motion.path === "string" && motion.path.length > 0)
    .map((motion) => {
      const asset = pack.assets.find((item) => item.path === motion.path);
      return asset ? { ...motion, url: urlForAsset(asset) } : null;
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);

  const resolveAssetUrl = (requestedUrl: string): string | null => {
    if (disposed) return null;
    if (requestedUrl === entryUrl || createdBlobUrls.has(requestedUrl) || requestedUrl.startsWith("data:")) {
      return requestedUrl;
    }
    // Strip query/hash and decode URI components safely.
    let clean = requestedUrl.split(/[?#]/, 1)[0];
    try { clean = decodeURIComponent(clean); } catch { /* Keep raw string. */ }
    clean = clean.replaceAll("\\", "/");

    // Three.js FBXLoader / GLTFLoader compute resourcePath from entryUrl (`blob:https://host/`),
    // turning relative texture paths like `Hair_Tex.png` into `blob:https://host/Hair_Tex.png`.
    if (/^blob:/i.test(clean)) {
      clean = clean.replace(/^blob:(?:https?:\/\/[^/]+)?\/?/i, "");
    }

    // Never allow external HTTP/HTTPS texture requests from untrusted FBX files.
    if (/^(?:https?:|file:|ftp:)/i.test(clean)) {
      const baseOnly = clean.split("/").at(-1)?.toLowerCase();
      const matched = baseOnly ? byBaseName.get(baseOnly) : undefined;
      return matched ? urlForAsset(matched) : null;
    }

    // 1. Try relative to the model's directory.
    try {
      const rel = normalizePath(baseDir + clean.replace(/^\/+/, ""));
      const exact = byLowerPath.get(rel.toLowerCase());
      if (exact) return urlForAsset(exact);
    } catch { /* Fall through to root/basename lookup. */ }

    // 2. Try package-root normalized path.
    try {
      const root = normalizePath(clean.replace(/^\/+/, ""));
      const exact = byLowerPath.get(root.toLowerCase());
      if (exact) return urlForAsset(exact);
    } catch { /* Fall through to basename lookup. */ }

    // 3. FBX files frequently embed Windows paths like `C:\Users\...\textures\skin.png`.
    const base = clean.split("/").at(-1)?.toLowerCase();
    if (base) {
      const matched = byBaseName.get(base);
      if (matched) return urlForAsset(matched);

      // 4. Sketchfab ZIPs truncate long texture filenames at ~45-47 chars (e.g. `..._Body_BaseCo.png`
      //    for `..._Body_BaseColor.png`). Match the longest shared stem prefix when >= 16 chars.
      const reqStem = base.replace(/\.[^.]+$/, "");
      if (reqStem.length >= 16) {
        let bestAsset: ModelAsset | undefined;
        let bestLen = 0;
        for (const [assetBase, asset] of byBaseName) {
          const assetStem = assetBase.replace(/\.[^.]+$/, "");
          if (assetStem.length >= 16 && (reqStem.startsWith(assetStem) || assetStem.startsWith(reqStem))) {
            const shared = Math.min(reqStem.length, assetStem.length);
            if (shared > bestLen) {
              bestLen = shared;
              bestAsset = asset;
            }
          }
        }
        if (bestAsset) return urlForAsset(bestAsset);
      }
    }
    return null;
  };

  /**
   * Match an unmapped FBX material name (e.g., Blender toon node materials like
   * `Body`, `Hair`, `Overcoat_F`, `WhiteDress_B`) to its base-color texture in
   * the package using token-boundary matching.
   */
  const findTextureForMaterial = (materialName: string): string | null => {
    if (disposed || !textureCandidates.length) return null;
    const cleaned = materialName
      .trim()
      .toLowerCase()
      .replace(/\.\d+$/, "")
      .replace(/(?:_?(?:mat|material|shader))+$/i, "");
    if (!cleaned || cleaned === "__default" || cleaned.length < 2) return null;

    const strippedSide = cleaned.replace(/[_\-\s.](?:f|b|front|back|inner|outer|inside|outside)$/i, "");
    const keys: Array<{ key: string; weight: number }> = [{ key: cleaned, weight: 100 }];
    if (strippedSide && strippedSide !== cleaned && strippedSide.length >= 2) {
      keys.push({ key: strippedSide, weight: 65 });
    }

    let bestAsset: ModelAsset | null = null;
    let bestScore = 0;
    for (const candidate of textureCandidates) {
      const { stem, asset } = candidate;
      let score = 0;
      for (const { key, weight } of keys) {
        if (stem === key) {
          score = Math.max(score, weight + 30);
        } else {
          const boundary = new RegExp(`(?:^|[_\\-\\s.])${escapeRegex(key)}(?:[_\\-\\s.]|$)`, "i");
          if (boundary.test(stem)) {
            score = Math.max(score, weight);
          }
        }
      }
      if (score <= 0) continue;
      if (NON_COLOR_MAP.test(stem)) score -= 60;
      if (COLOR_MAP_HINT.test(stem)) score += 10;
      if (score > bestScore) {
        bestScore = score;
        bestAsset = asset;
      }
    }
    return bestAsset ? urlForAsset(bestAsset) : null;
  };

  return {
    format: model.format,
    entryPath: model.manifestPath,
    entryUrl,
    companionMotionUrls,
    resolveAssetUrl,
    findTextureForMaterial,
    dispose: () => {
      disposed = true;
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
      createdBlobUrls.clear();
    },
  };
}

async function openStorage(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("vivian-local-models-3d", 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      const packages = db.objectStoreNames.contains("packages")
        ? request.transaction!.objectStore("packages")
        : db.createObjectStore("packages", { keyPath: "id" });
      const catalog = db.objectStoreNames.contains("catalog")
        ? request.transaction!.objectStore("catalog")
        : db.createObjectStore("catalog", { keyPath: "id" });
      const cursor = packages.openCursor();
      cursor.onsuccess = () => {
        const entry = cursor.result;
        if (!entry) return;
        catalog.put(modelCatalogEntry(entry.value));
        entry.continue();
      };
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function modelCatalogEntry(pack: ModelPackage): ModelPackage {
  return {
    id: pack.id,
    models: pack.models,
    assets: [],
    ...(pack.renderRevision ? { renderRevision: pack.renderRevision } : {}),
    ...(pack.cloudOwner ? { cloudOwner: pack.cloudOwner } : {}),
  };
}

async function storage<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>, storeName = "packages"): Promise<T> {
  const db = await openStorage();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(mode === "readwrite" ? ["packages", "catalog"] : storeName, mode);
    const request = operation(tx.objectStore(storeName));
    let result: T;
    request.onsuccess = () => { result = request.result; };
    tx.oncomplete = () => { db.close(); resolve(result); };
    tx.onabort = tx.onerror = () => { db.close(); reject(tx.error ?? new Error("Model storage unavailable.")); };
  });
}

export async function loadModelPackages(): Promise<ModelPackage[]> {
  const packages = await storage<ModelPackage[]>("readonly", (store) => store.getAll());
  return Promise.all(packages.map(async (pack) => ({
    ...await inspectPackage(pack.assets, pack.id),
    ...(pack.renderRevision ? { renderRevision: pack.renderRevision } : {}),
    ...(pack.cloudOwner ? { cloudOwner: pack.cloudOwner } : {}),
  })));
}

export const loadModelCatalog = (): Promise<ModelPackage[]> => storage("readonly", (store) => store.getAll(), "catalog");

export async function loadModelPackage(id: string): Promise<ModelPackage | undefined> {
  const pack = await storage<ModelPackage | undefined>("readonly", (store) => store.get(id));
  if (!pack?.assets.length) return undefined;
  return {
    ...await inspectPackage(pack.assets, pack.id),
    ...(pack.renderRevision ? { renderRevision: pack.renderRevision } : {}),
    ...(pack.cloudOwner ? { cloudOwner: pack.cloudOwner } : {}),
  };
}

export function isModelBlobReadError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { name, message } = error as { name?: string; message?: string };
  return name === "NotFoundError" || name === "NotReadableError"
    || /(?:blob object.*not.*found|requested object.*could not be found|I\/O read operation failed)/i.test(message ?? "");
}

async function checkModelBlobs(pack: ModelPackage, signal?: AbortSignal): Promise<void> {
  const CONCURRENCY = 8;
  let next = 0;
  const probe = async () => {
    while (next < pack.assets.length) {
      signal?.throwIfAborted();
      const asset = pack.assets[next++];
      if (asset.blob.size) await asset.blob.slice(0, 1).arrayBuffer();
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pack.assets.length) }, probe));
  signal?.throwIfAborted();
}

export async function hydrateModelPackage(
  pack: ModelPackage,
  options?: { recover?: () => Promise<ModelPackage>; signal?: AbortSignal },
): Promise<ModelPackage | undefined> {
  let source: ModelPackage | undefined;
  let cacheError: unknown;
  try {
    options?.signal?.throwIfAborted();
    source = pack.assets.length ? pack : await loadModelPackage(pack.id);
    if (source) await checkModelBlobs(source, options?.signal);
  } catch (error) {
    if (!isModelBlobReadError(error)) throw error;
    cacheError = error;
    source = undefined;
  }
  if (source) return source;
  if (options?.recover) {
    options.signal?.throwIfAborted();
    const recovered = await options.recover();
    await checkModelBlobs(recovered, options.signal);
    return recovered;
  }
  if (cacheError) {
    throw new Error("อ่านไฟล์โมเดล 3D ที่เซฟไว้ในเครื่องไม่ได้ ลองอัปโหลดใหม่หรือเชื่อมต่อคลาวด์อีกครั้งนะ", { cause: cacheError });
  }
  return undefined;
}

export const saveModelPackage = (pack: ModelPackage): Promise<IDBValidKey> => {
  if (!pack.assets.length || pack.models.some((model) => !pack.assets.some((asset) => asset.path === model.manifestPath))) {
    return Promise.reject(new Error("Cannot save a model catalog entry without its original model files."));
  }
  pack.renderRevision = crypto.randomUUID();
  return storage("readwrite", (store) => {
    store.transaction.objectStore("catalog").put(modelCatalogEntry(pack));
    return store.put(pack);
  });
};

export const removeModelPackage = async (id: string): Promise<undefined> => {
  return storage("readwrite", (store) => {
    store.transaction.objectStore("catalog").delete(id);
    return store.delete(id);
  });
};
