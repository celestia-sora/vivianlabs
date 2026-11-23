"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { authFetch } from "@/lib/auth/fetch";
import { formatStorageBytes, storagePercentage, type ProviderStorageStatus } from "@/lib/storage-status";
import type { StorageUsage } from "@/lib/cloud-storage";
import {
  CLOUD_TIER_REQUIRED_MESSAGE,
  SELECTED_STORAGE_LIMIT_BYTES,
  formatPersonalMb,
  type AccountSummary,
  type TierKey,
} from "@/app/components/tier-panel";

interface StorageStatusResponse {
  cloudAllowed?: boolean;
  tier?: TierKey;
  usedBytes?: number | null;
  personalLimitBytes?: number | null;
  limitBytes?: number | null;
  personal?: { usedBytes?: number | null; limitBytes?: number | null } | null;
  storage?: { usedBytes?: number | null; limitBytes?: number | null } | null;
  supabase?: ProviderStorageStatus | null;
  r2?: (ProviderStorageStatus & {
    categories?: StorageUsage | null;
    quotaUsage?: StorageUsage | null;
    personalLimitBytes?: number | null;
  }) | null;
  checkedAt?: string;
}

function StorageMeter({
  name,
  used,
  limit,
  description,
  usedText,
  limitText,
}: {
  name: string;
  used: number | null;
  limit: number;
  description?: string;
  usedText?: string;
  limitText?: string;
}) {
  const percentage = used === null || limit <= 0 ? null : storagePercentage(used, limit);
  return <article className="storage-status-card">
    <div className="storage-status-heading"><strong>{name}</strong><span>{percentage === null ? "Unavailable" : `${percentage.toFixed(1)}%`}</span></div>
    <progress aria-label={`${name} storage usage`} max={100} value={percentage === null ? 0 : Math.min(100, percentage)} className={percentage !== null && percentage >= 90 ? "is-near-limit" : ""} />
    <p>{used === null ? "Usage could not be checked" : usedText ?? `${formatStorageBytes(used)} used`}<span>{limitText ?? `${formatStorageBytes(limit)} capacity`}</span></p>
    {description && <small>{description}</small>}
  </article>;
}

export function StorageStatusPanel({
  account,
  onRequestSelected,
}: {
  account?: AccountSummary | null;
  onRequestSelected?: () => void;
}) {
  const [status, setStatus] = useState<StorageStatusResponse | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const inFlight = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    if (inFlight.current || document.hidden) return;
    inFlight.current = true; setRefreshing(true);
    const abort = new AbortController(); controller.current = abort;
    try {
      const response = await authFetch("/api/storage/status", { cache: "no-store", signal: AbortSignal.any([abort.signal, AbortSignal.timeout(12_000)]) });
      if (!response.ok) throw new Error("Storage status is temporarily unavailable.");
      const next = await response.json() as StorageStatusResponse;
      if (!abort.signal.aborted) { setStatus(next); setNotice(null); }
    } catch {
      if (!abort.signal.aborted) setNotice("Could not refresh storage usage. Showing the last available update.");
    } finally { inFlight.current = false; if (!abort.signal.aborted) setRefreshing(false); }
  }, []);
  useEffect(() => {
    const initial = window.setTimeout(() => { void refresh(); }, 0);
    const timer = window.setInterval(() => { void refresh(); }, 5000);
    const update = () => { void refresh(); };
    window.addEventListener("vivian-storage-changed", update);
    document.addEventListener("visibilitychange", update);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); controller.current?.abort(); window.removeEventListener("vivian-storage-changed", update); document.removeEventListener("visibilitychange", update); };
  }, [refresh]);

  const effectiveTier = status?.tier ?? account?.tier;
  const isFree = status?.cloudAllowed === false || effectiveTier === "free";
  const isSelected = !isFree && effectiveTier === "selected";

  if (isFree) {
    return <div className="storage-status-panel">
      <article className="storage-status-card tier-gate-card">
        <div className="storage-status-heading"><strong>Cloud R2 Storage</strong><span className="tier-badge is-free">Free</span></div>
        <p className="tier-gate-copy">{CLOUD_TIER_REQUIRED_MESSAGE}</p>
        <small>โมเดลที่นำเข้าจาก ZIP/Folder จะถูกเก็บไว้ในเบราว์เซอร์เครื่องนี้ และฉากสำเร็จรูปยังคงใช้งานได้ตามปกติ</small>
        {onRequestSelected && (
          <button type="button" className="floating-option model-import-primary" onClick={onRequestSelected}>
            Request Selected Tier
          </button>
        )}
      </article>
      {notice && <p role="status" className="model-notice">{notice}</p>}
    </div>;
  }

  if (isSelected) {
    const personalUsed =
      status?.usedBytes ??
      status?.personal?.usedBytes ??
      status?.storage?.usedBytes ??
      status?.r2?.usedBytes ??
      account?.storage.usedBytes ??
      null;
    const personalLimit =
      status?.personalLimitBytes ??
      status?.limitBytes ??
      status?.personal?.limitBytes ??
      status?.storage?.limitBytes ??
      status?.r2?.personalLimitBytes ??
      status?.r2?.limitBytes ??
      account?.storage.limitBytes ??
      SELECTED_STORAGE_LIMIT_BYTES;
    const usedMbLabel = personalUsed === null ? null : `${formatPersonalMb(personalUsed)} used`;
    const limitMbLabel = `${Math.round(personalLimit / (1024 * 1024))} MB limit`;

    return <div className="storage-status-panel">
      <p className="floating-note">Personal cloud storage usage refreshes automatically while this panel is open.</p>
      <StorageMeter
        name="Personal Cloud R2"
        used={personalUsed}
        limit={personalLimit}
        usedText={usedMbLabel ? `${usedMbLabel} (${formatPersonalMb(personalUsed!)} / ${Math.round(personalLimit / (1024 * 1024))} MB)` : undefined}
        limitText={limitMbLabel}
        description="พื้นที่จัดเก็บส่วนตัวบน Cloud R2 สำหรับโมเดล Live2D และฉากของคุณ (สูงสุด 512 MB)"
      />
      <div className="storage-status-footer">
        <small>{status?.checkedAt ? `Checked ${new Date(status.checkedAt).toLocaleTimeString()}` : "Checking personal storage…"}</small>
        <button type="button" className="floating-option" disabled={refreshing} onClick={() => { void refresh(); }}>{refreshing ? "Refreshing…" : "Refresh"}</button>
      </div>
      {notice && <p role="status" className="model-notice">{notice}</p>}
    </div>;
  }

  return <div className="storage-status-panel">
    <p className="floating-note">Storage usage refreshes every 5 seconds while this panel is open.</p>
    <StorageMeter name="Supabase" used={status?.supabase?.usedBytes ?? null} limit={status?.supabase?.limitBytes ?? 1e9} description="File storage in this Supabase project." />
    <StorageMeter name="Cloudflare R2" used={status?.r2?.usedBytes ?? null} limit={status?.r2?.limitBytes ?? 8e9} description={status?.r2?.connected ? "Models and scenes share 8 GB. The remaining 2 GB is an unused safety buffer." : "R2 connection is not available."} />
    <div className="storage-category-meters">
      <StorageMeter name="Live2D models" used={status?.r2?.categories?.live2d.used ?? null} limit={8e9} description={status?.r2?.quotaUsage ? `Models committed: ${formatStorageBytes(status.r2.quotaUsage.live2d.used)} within the shared 8 GB budget.` : "Upload quota could not be checked."} />
      <StorageMeter name="Scenes and other files" used={status?.r2?.categories?.other.used ?? null} limit={8e9} description={status?.r2?.quotaUsage ? `Scenes/other committed: ${formatStorageBytes(status.r2.quotaUsage.other.used)} within the shared 8 GB budget.` : "Upload quota could not be checked."} />
    </div>
    <div className="storage-status-footer"><small>{status?.checkedAt ? `Checked ${new Date(status.checkedAt).toLocaleTimeString()}` : "Waiting for storage status…"}</small><button type="button" className="floating-option" disabled={refreshing} onClick={() => { void refresh(); }}>{refreshing ? "Refreshing…" : "Refresh"}</button></div>
    {notice && <p role="status" className="model-notice">{notice}</p>}
  </div>;
}
