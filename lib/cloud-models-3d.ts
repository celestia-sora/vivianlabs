"use client";
/**
 * 3D VRM & FBX Cloud R2 upload/download helpers.
 * Kept separate from lib/cloud-models.ts so Live2D cloud storage stays untouched.
 */
import { authFetch } from "@/lib/auth/fetch";
import {
  CloudModelError,
  SHARED_MODEL_OWNER,
  modelArchive,
  type CloudLibraryTier,
} from "@/lib/cloud-models";
import {
  MODEL_MAX_BYTES,
  MODEL_PART_BYTES,
  type CloudModel,
  type PersonalStorageUsage,
  type StorageUsage,
} from "@/lib/cloud-storage";
import type { ModelPackage as Live2DModelPackage } from "@/lib/local-models";
import {
  importModelFiles as import3DModelFiles,
  inspectPackage as inspect3DPackage,
  type ModelPackage as Model3DPackage,
} from "@/lib/local-models-3d";
import { notifyStorageChanged } from "@/lib/storage-status";
import { modelFormatFromPath } from "@/lib/vrm-metadata";

async function json<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await authFetch(path, {
    ...options,
    cache: "no-store",
    signal: options?.signal ?? AbortSignal.timeout(35_000),
  });
  const body = await response.json();
  if (!response.ok) {
    const requiredTier: CloudLibraryTier | undefined =
      body.requiredTier === "free" || body.requiredTier === "selected" || body.requiredTier === "sorachan"
        ? body.requiredTier
        : undefined;
    throw new CloudModelError(
      typeof body.error === "string" ? body.error : "Cloud storage is unavailable.",
      response.status,
      typeof body.code === "string" ? body.code : undefined,
      requiredTier,
    );
  }
  return body as T;
}

export function is3DCloudModel(model: CloudModel): boolean {
  return Array.isArray(model.manifests) && model.manifests.some((entry) => modelFormatFromPath(entry.path) !== null);
}

export function isLive2DCloudModel(model: CloudModel): boolean {
  return !Array.isArray(model.manifests) || model.manifests.some((entry) => /\.model3\.json$/i.test(entry.path));
}

export function cloud3DModelPlaceholder(model: CloudModel): Model3DPackage | null {
  if (!Array.isArray(model.manifests)) return null;
  const models = model.manifests
    .map((entry) => {
      const format = modelFormatFromPath(entry.path);
      if (!format) return null;
      return {
        id: `${model.id}:${entry.path}`,
        name: entry.name,
        format,
        manifestPath: entry.path,
        expressions: [],
        poses: [],
        motions: [],
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  if (!models.length) return null;
  return {
    id: model.id,
    assets: [],
    ...(model.scope === "shared" ? { cloudOwner: SHARED_MODEL_OWNER } : {}),
    models,
  };
}

export async function uploadCloud3DModel(
  pack: Model3DPackage,
  progress: (message: string) => void,
  originalZip?: File,
  signal?: AbortSignal,
): Promise<{
  pack: Model3DPackage;
  byteSize: number;
  scope?: "private" | "shared";
  usage: StorageUsage | null;
  personalUsage?: PersonalStorageUsage | null;
}> {
  progress("กำลังเตรียมโมเดล 3D อัปขึ้น Cloud ส่วนตัว…");
  const archive = await modelArchive(pack as unknown as Live2DModelPackage, originalZip);
  signal?.throwIfAborted();
  const started = await json<{ id: string; userId: string; scope?: "private" | "shared" }>("/api/models", {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      byteSize: archive.size,
      manifests: pack.models.map((model) => ({ path: model.manifestPath, name: model.name })),
    }),
  });
  notifyStorageChanged();
  let completing = false;
  try {
    const total = Math.ceil(archive.size / MODEL_PART_BYTES);
    for (let first = 1; first <= total; first += 8) {
      const { parts } = await json<{ parts: Array<{ part: number; size: number; url: string }> }>(
        `/api/models/${started.id}/parts?first=${first}`,
        { method: "POST", signal },
      );
      for (const part of parts) {
        const response = await fetch(part.url, {
          method: "PUT",
          body: archive.slice((part.part - 1) * MODEL_PART_BYTES, (part.part - 1) * MODEL_PART_BYTES + part.size),
          credentials: "omit",
          referrerPolicy: "no-referrer",
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
        });
        if (!response.ok) throw new Error("อัปโหลดโมเดล 3D ไม่สำเร็จ ลองใหม่อีกทีนะ");
        progress(`กำลังเซฟโมเดล 3D ขึ้น Cloud… ${Math.round((part.part / total) * 100)}%`);
      }
    }
    completing = true;
    const finished = await json<{ usage?: StorageUsage | null; personalUsage?: PersonalStorageUsage | null }>(
      `/api/models/${started.id}`,
      { method: "POST", signal },
    );
    notifyStorageChanged();
    const stored = await inspect3DPackage(pack.assets, started.id);
    return {
      pack: { ...stored, cloudOwner: started.scope === "shared" ? SHARED_MODEL_OWNER : started.userId },
      byteSize: archive.size,
      scope: started.scope,
      usage: finished.usage ?? null,
      personalUsage: finished.personalUsage ?? null,
    };
  } catch (error) {
    if (!completing) await json(`/api/models/${started.id}`, { method: "DELETE" }).catch(() => {});
    throw error;
  }
}

export async function downloadCloud3DModel(
  model: CloudModel,
  userId: string,
  signal?: AbortSignal,
): Promise<Model3DPackage> {
  const { url, byteSize } = await json<{ url: string; byteSize: number }>(`/api/models/${model.id}`, { signal });
  if (byteSize < 1 || byteSize > MODEL_MAX_BYTES) throw new Error("ขนาดไฟล์โมเดล 3D ไม่ถูกต้อง");
  const response = await fetch(url, {
    credentials: "omit",
    referrerPolicy: "no-referrer",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000),
    cache: "no-store",
  });
  if (!response.ok || !response.body) throw new Error("ดาวน์โหลดโมเดล 3D ไม่สำเร็จ");
  const reader = response.body.getReader();
  const chunks: BlobPart[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > byteSize) {
        await reader.cancel();
        throw new Error("ไฟล์โมเดล 3D ที่ดาวน์โหลดเกินขนาดที่บันทึกไว้");
      }
      chunks.push(new Uint8Array(value));
    }
  } finally {
    reader.releaseLock();
  }
  if (bytes !== byteSize) throw new Error("ดาวน์โหลดไฟล์โมเดล 3D ไม่ครบ");
  const pack = await import3DModelFiles([new File(chunks, "model-3d.zip", { type: "application/zip" })]);
  return {
    ...(await inspect3DPackage(pack.assets, model.id)),
    cloudOwner: model.scope === "shared" ? SHARED_MODEL_OWNER : userId,
  };
}
