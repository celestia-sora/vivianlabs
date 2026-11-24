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
    <div className="storage-status-heading"><strong>{name}</strong><span>{percentage === null ? "เช็กไม่ได้" : `${percentage.toFixed(1)}%`}</span></div>
    <progress aria-label={`พื้นที่ใช้งานของ ${name}`} max={100} value={percentage === null ? 0 : Math.min(100, percentage)} className={percentage !== null && percentage >= 90 ? "is-near-limit" : ""} />
    <p>{used === null ? "ยังเช็กพื้นที่ไม่ได้แฮะ" : usedText ?? `ใช้ไปแล้ว ${formatStorageBytes(used)}`}<span>{limitText ?? `เต็ม ${formatStorageBytes(limit)}`}</span></p>
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
      if (!response.ok) throw new Error("ตอนนี้ยังเช็กพื้นที่ไม่ติดแฮะ ลองใหม่อีกแป๊บนะ");
      const next = await response.json() as StorageStatusResponse;
      if (!abort.signal.aborted) { setStatus(next); setNotice(null); }
    } catch {
      if (!abort.signal.aborted) setNotice("รีเฟรชล่าสุดไม่สำเร็จ โชว์ข้อมูลล่าสุดที่เช็กได้ให้ก่อนน้า");
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
        <div className="storage-status-heading"><strong>พื้นที่ Cloud R2</strong><span className="tier-badge is-free">Free</span></div>
        <p className="tier-gate-copy">{CLOUD_TIER_REQUIRED_MESSAGE}</p>
        <small>โมเดลที่เอาเข้าจากไฟล์ ZIP หรือโฟลเดอร์จะเซฟอยู่ในเครื่องนี้ให้เลย ส่วนฉากสำเร็จรูปก็สลับเล่นได้ตามปกติ</small>
        {onRequestSelected && (
          <button type="button" className="floating-option model-import-primary" onClick={onRequestSelected}>
            ขออัปเป็น Selected
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
    const usedMbLabel = personalUsed === null ? null : `ใช้ไปแล้ว ${formatPersonalMb(personalUsed)}`;
    const limitMbLabel = `โควตา ${Math.round(personalLimit / (1024 * 1024))} MB`;

    return <div className="storage-status-panel">
      <p className="floating-note">หน้านี้เช็กพื้นที่บนคลาวด์ส่วนตัวให้อัตโนมัติเรื่อย ๆ เลยน้า</p>
      <StorageMeter
        name="Cloud R2 ส่วนตัว"
        used={personalUsed}
        limit={personalLimit}
        usedText={usedMbLabel ? `${usedMbLabel} (${formatPersonalMb(personalUsed!)} / ${Math.round(personalLimit / (1024 * 1024))} MB)` : undefined}
        limitText={limitMbLabel}
        description="พื้นที่เก็บโมเดล Live2D กับฉากส่วนตัวของเธอไว้บน Cloud R2 (ได้สูงสุด 512 MB)"
      />
      <div className="storage-status-footer">
        <small>{status?.checkedAt ? `เช็กล่าสุด ${new Date(status.checkedAt).toLocaleTimeString()}` : "กำลังเช็กพื้นที่ให้อยู่…"}</small>
        <button type="button" className="floating-option" disabled={refreshing} onClick={() => { void refresh(); }}>{refreshing ? "กำลังอัปเดต…" : "รีเฟรช"}</button>
      </div>
      {notice && <p role="status" className="model-notice">{notice}</p>}
    </div>;
  }

  return <div className="storage-status-panel">
    <p className="floating-note">หน้านี้จะอัปเดตพื้นที่ให้อัตโนมัติทุก 5 วิเลยนะ</p>
    <StorageMeter name="ระบบเก็บข้อมูลแชต &amp; ความจำ" used={status?.supabase?.usedBytes ?? null} limit={status?.supabase?.limitBytes ?? 1e9} description="พื้นที่เก็บไฟล์แชตกับความทรงจำต่าง ๆ" />
    <StorageMeter name="Cloud R2" used={status?.r2?.usedBytes ?? null} limit={status?.r2?.limitBytes ?? 8e9} description={status?.r2?.connected ? "โมเดลกับฉากใช้โควตารวมกัน 8 GB (เหลืออีก 2 GB กันเหนียวไว้ไม่ให้เต็ม)" : "ตอนนี้ยังต่อ Cloud R2 ไม่ได้แฮะ"} />
    <div className="storage-category-meters">
      <StorageMeter name="โมเดล Live2D" used={status?.r2?.categories?.live2d.used ?? null} limit={8e9} description={status?.r2?.quotaUsage ? `ใช้พื้นที่โมเดลไปแล้ว ${formatStorageBytes(status.r2.quotaUsage.live2d.used)} จากโควตารวม 8 GB` : "ยังเช็กโควตาอัปโหลดไม่ได้แฮะ"} />
      <StorageMeter name="ฉากและไฟล์อื่น ๆ" used={status?.r2?.categories?.other.used ?? null} limit={8e9} description={status?.r2?.quotaUsage ? `ใช้พื้นที่ฉาก/ไฟล์อื่นไปแล้ว ${formatStorageBytes(status.r2.quotaUsage.other.used)} จากโควตารวม 8 GB` : "ยังเช็กโควตาอัปโหลดไม่ได้แฮะ"} />
    </div>
    <div className="storage-status-footer"><small>{status?.checkedAt ? `เช็กล่าสุด ${new Date(status.checkedAt).toLocaleTimeString()}` : "กำลังเช็กพื้นที่ให้อยู่…"}</small><button type="button" className="floating-option" disabled={refreshing} onClick={() => { void refresh(); }}>{refreshing ? "กำลังอัปเดต…" : "รีเฟรช"}</button></div>
    {notice && <p role="status" className="model-notice">{notice}</p>}
  </div>;
}
