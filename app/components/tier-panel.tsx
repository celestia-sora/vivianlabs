"use client";

import { useCallback, useEffect, useState } from "react";
import { authFetch } from "@/lib/auth/fetch";

export type TierKey = "free" | "selected" | "sorachan";

export const SELECTED_REQUEST_EMAIL = "viviannextlabs@gmail.com";
export const SELECTED_STORAGE_LIMIT_BYTES = 512 * 1024 * 1024;
export const CLOUD_TIER_REQUIRED_MESSAGE =
  "ต้องเป็น Selected tier ขึ้นไปจึงจะใช้ Cloud R2 ได้ (นำเข้าแบบ local บนเครื่องได้ปกติ)";

export interface AccountTierCapabilities {
  tier: TierKey;
  dailyChatLimit: number | null;
  canUseCloudModels: boolean;
  canUseCloudScenes: boolean;
  canViewSharedModels: boolean;
  personalStorageLimitBytes: number | null;
  isAdmin: boolean;
}

export interface AccountChatQuota {
  allowed: boolean;
  tier: TierKey;
  used: number;
  limit: number | null;
  remaining: number | null;
  usageDate: string;
  resetAt: string;
}

export interface AccountTierRequestRecord {
  id: string;
  userId: string;
  email: string;
  displayName: string;
  reason: string;
  status: "pending" | "approved" | "rejected";
  reviewedBy: string | null;
  reviewNote: string;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AccountSummary {
  user: { id: string; email: string };
  tier: TierKey;
  isSorachan?: boolean;
  userProfile?: {
    userId?: string;
    displayName?: string;
    relationship?: string;
    pronouns?: string;
    styleNotes?: string;
    onboarded?: boolean;
    updatedAt?: string | null;
  };
  capabilities: AccountTierCapabilities;
  chatQuota: AccountChatQuota;
  storage: {
    usedBytes: number;
    limitBytes: number | null;
  };
  selectedRequest: AccountTierRequestRecord | null;
  mailtoUrl: string;
  requestEmail: string;
}

export interface TierRequestSubmitResult {
  request: AccountTierRequestRecord;
  alreadyPending: boolean;
  emailSent: boolean;
  mailtoUrl: string;
  requestEmail: string;
}

export interface AdminTierAccount {
  userId: string;
  email: string;
  tier: TierKey;
  updatedAt: string;
}

export interface AdminTierDataResponse {
  requests: AccountTierRequestRecord[];
  accounts: AdminTierAccount[];
}

export function tierDisplayName(tier: TierKey): string {
  if (tier === "sorachan") return "Sorachan";
  if (tier === "selected") return "Selected";
  return "Free";
}

export function isQuotaDepleted(
  quota: AccountChatQuota | null | undefined,
  nowMs = Date.now(),
): boolean {
  if (!quota || quota.limit === null || quota.tier === "sorachan") return false;
  if (quota.resetAt) {
    const resetMs = Date.parse(quota.resetAt);
    if (Number.isFinite(resetMs) && nowMs >= resetMs) return false;
  }
  if (typeof quota.remaining === "number") return quota.remaining <= 0;
  return quota.allowed === false;
}

export function formatTierChatBadge(
  tier: TierKey,
  chatQuota?: AccountChatQuota | null,
): string {
  if (tier === "sorachan") return "Sorachan · Unlimited";
  const fallbackLimit = tier === "selected" ? 20 : 5;
  const limit = chatQuota?.limit ?? fallbackLimit;
  const remaining = chatQuota
    ? Math.max(0, chatQuota.remaining ?? Math.max(0, limit - chatQuota.used))
    : limit;
  return `${tierDisplayName(tier)} · ${remaining}/${limit} chats today`;
}

export function formatPersonalMb(bytes: number): string {
  const safeBytes = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  return `${(safeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatBangkokResetLabel(): string {
  return "รีเซ็ตเที่ยงคืนเวลาไทย (00:00 UTC+7)";
}

export function vivianQuotaExceededReply(tier: TierKey): string {
  if (tier === "selected") {
    return "อ๊ะ... วันนี้คุยกันครบโควตาของวันนี้แล้วค่ะ ไม่ได้ไล่สักหน่อยนะ แค่ต้องพักรอรีเซ็ตตอนเที่ยงคืนเวลาไทย (UTC+7) พรุ่งนี้ค่อยมาคุยกันต่อนะคะ";
  }
  if (tier === "free") {
    return "อ๊ะ... วันนี้คุยกันครบโควตาของวันนี้แล้วนะคะ ไม่ใช่ว่าไม่อยากคุยต่อสักหน่อย แค่ต้องรอรีเซ็ตตอนเที่ยงคืนเวลาไทย (UTC+7) ...หรือถ้าอยากคุยกันต่อมากกว่านี้ จะลองขอ Selected Tier ดูก็ได้นะคะ";
  }
  return "อ๊ะ... ระบบจำกัดการใช้งานชั่วคราวค่ะ ลองใหม่อีกครั้งนะคะ";
}

export function buildClientMailtoUrl(params: {
  userEmail?: string;
  userId?: string;
  displayName?: string;
  reason?: string;
  requestId?: string;
}): string {
  const email = params.userEmail?.trim() || "user";
  const subject = `[Vivian] Selected Tier Request — ${email}`;
  const lines = [
    "Hello Vivian Labs,",
    "",
    "I would like to request Selected tier access on Vivian.",
    "",
    `Account Email: ${email}`,
    ...(params.userId ? [`User ID: ${params.userId}`] : []),
    ...(params.displayName?.trim() ? [`Display Name: ${params.displayName.trim()}`] : []),
    ...(params.requestId ? [`Request ID: ${params.requestId}`] : []),
    ...(params.reason?.trim() ? ["", "Reason:", params.reason.trim()] : []),
  ];
  return `mailto:${SELECTED_REQUEST_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(lines.join("\n"))}`;
}

function requestStatusLabel(status: AccountTierRequestRecord["status"]): string {
  if (status === "approved") return "อนุมัติแล้ว";
  if (status === "rejected") return "ยังไม่ผ่านการอนุมัติ";
  return "รอการอนุมัติ";
}

export function TierBadge({ tier }: { tier: TierKey }) {
  return (
    <span className={`tier-badge is-${tier}`}>
      {tierDisplayName(tier)}
    </span>
  );
}

export function TierMenuSummary({
  account,
  accountEmail,
  loading,
  profileDisplayName,
  onOpenRequest,
  onOpenProfile,
}: {
  account: AccountSummary | null;
  accountEmail: string;
  loading?: boolean;
  profileDisplayName?: string;
  onOpenRequest: () => void;
  onOpenProfile?: () => void;
}) {
  const tier = account?.tier ?? "free";
  const badgeLine = account
    ? formatTierChatBadge(tier, account.chatQuota)
    : loading
      ? "Checking plan…"
      : "Free · 5/5 chats today";
  const email = account?.user.email || accountEmail;
  const resolvedName = profileDisplayName?.trim() || account?.userProfile?.displayName?.trim() || "";

  return (
    <div className="tier-menu-card" aria-label="Account tier summary">
      <div className="tier-menu-top">
        <TierBadge tier={tier} />
        <strong className="tier-menu-quota">{badgeLine}</strong>
      </div>
      <div className="tier-menu-meta">
        <span>
          {tier === "sorachan"
            ? "ไม่จำกัดข้อความ · Cloud R2 + Admin"
            : formatBangkokResetLabel()}
        </span>
        {email && <small className="tier-menu-email">{email}</small>}
      </div>
      <div className="tier-menu-actions" style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
        {account && tier === "free" && (
          <button
            type="button"
            className="tier-menu-upgrade"
            onClick={onOpenRequest}
          >
            {account.selectedRequest?.status === "pending"
              ? "Selected Request Pending"
              : "Request Selected Tier"}
          </button>
        )}
        {onOpenProfile && (
          <button
            type="button"
            className="tier-menu-upgrade"
            onClick={onOpenProfile}
          >
            {resolvedName ? `ชื่อที่เรียก: ${resolvedName}` : "ตั้งค่าชื่อ & โปรไฟล์ของคุณ"}
          </button>
        )}
      </div>
    </div>
  );
}

export function TierSettingsCard({
  account,
  accountEmail,
  accountId,
  loading,
  onOpenRequest,
}: {
  account: AccountSummary | null;
  accountEmail: string;
  accountId: string;
  loading?: boolean;
  onOpenRequest: () => void;
}) {
  const tier = account?.tier ?? "free";
  const quotaText = account
    ? formatTierChatBadge(tier, account.chatQuota)
    : loading
      ? "กำลังโหลดข้อมูลแพ็กเกจ…"
      : "Free · 5/5 chats today";
  const mailtoHref =
    account?.mailtoUrl ||
    buildClientMailtoUrl({ userEmail: accountEmail, userId: accountId });
  const request = account?.selectedRequest;

  return (
    <div className="custom-instructions tier-settings-card">
      <div className="tier-settings-head">
        <div>
          <strong>Account Tier &amp; Daily Chats</strong>
          <p>{quotaText}</p>
        </div>
        <TierBadge tier={tier} />
      </div>
      <p>
        {tier === "sorachan"
          ? "Sorachan Tier · แชตไม่จำกัด พร้อม Cloud R2 ครบชุดและสิทธิ์ผู้ดูแลระบบ"
          : tier === "selected"
            ? `Selected Tier · คุยได้ 20 ข้อความ/วัน (${formatBangkokResetLabel()}) · พื้นที่ส่วนตัว Cloud R2 ${formatPersonalMb(account?.storage.usedBytes ?? 0)} / 512 MB`
            : `Free Tier · คุยได้ 5 ข้อความ/วัน (${formatBangkokResetLabel()}) · นำเข้าโมเดลแบบ local บนเครื่องได้ปกติ`}
      </p>
      {tier === "free" && request && (
        <div className={`tier-request-status is-${request.status}`} role="status">
          <strong>คำขอ Selected Tier: {requestStatusLabel(request.status)}</strong>
          <span>
            ส่งเมื่อ {new Date(request.createdAt).toLocaleString()}
          </span>
          {request.reviewNote && <small>หมายเหตุ: {request.reviewNote}</small>}
        </div>
      )}
      {tier === "free" && (
        <div className="tier-settings-actions">
          <button
            type="button"
            className="floating-option model-import-primary"
            onClick={onOpenRequest}
          >
            {request?.status === "pending" ? "ดูสถานะคำขอ / ส่งอีเมล" : "Request Selected Tier"}
          </button>
          <a
            href={mailtoHref}
            className="floating-option tier-mailto-link"
          >
            Email {SELECTED_REQUEST_EMAIL}
          </a>
        </div>
      )}
    </div>
  );
}

export function RequestSelectedModal(props: {
  open: boolean;
  account: AccountSummary | null;
  accountEmail: string;
  accountId: string;
  onClose: () => void;
  onSubmitted: (result: TierRequestSubmitResult) => void;
  onAccountRefresh: () => Promise<void>;
}) {
  if (!props.open) return null;
  return (
    <RequestSelectedModalBody
      account={props.account}
      accountEmail={props.accountEmail}
      accountId={props.accountId}
      onClose={props.onClose}
      onSubmitted={props.onSubmitted}
      onAccountRefresh={props.onAccountRefresh}
    />
  );
}

function RequestSelectedModalBody({
  account,
  accountEmail,
  accountId,
  onClose,
  onSubmitted,
  onAccountRefresh,
}: {
  account: AccountSummary | null;
  accountEmail: string;
  accountId: string;
  onClose: () => void;
  onSubmitted: (result: TierRequestSubmitResult) => void;
  onAccountRefresh: () => Promise<void>;
}) {
  const pendingReq = account?.selectedRequest?.status === "pending" ? account.selectedRequest : null;
  const [displayName, setDisplayName] = useState(pendingReq?.displayName || "");
  const [reason, setReason] = useState(pendingReq?.reason || "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitResult, setSubmitResult] = useState<TierRequestSubmitResult | null>(null);

  const existing = submitResult?.request ?? account?.selectedRequest ?? null;
  const isPending = existing?.status === "pending";
  const resolvedEmail = account?.user.email || accountEmail;
  const resolvedUserId = account?.user.id || accountId;
  const targetEmail = submitResult?.requestEmail || account?.requestEmail || SELECTED_REQUEST_EMAIL;
  const mailtoUrl =
    submitResult?.mailtoUrl ||
    (isPending && account?.mailtoUrl) ||
    buildClientMailtoUrl({
      userEmail: resolvedEmail,
      userId: resolvedUserId,
      displayName,
      reason,
      requestId: existing?.id,
    });

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await authFetch("/api/tier-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName, reason }),
      });
      const body = await response.json().catch(() => ({})) as Partial<TierRequestSubmitResult> & {
        error?: string;
        code?: string;
      };
      if (!response.ok) {
        if (body.code === "ALREADY_SELECTED") {
          await onAccountRefresh();
          onClose();
          return;
        }
        throw new Error(body.error || "ส่งคำขอไม่สำเร็จ กรุณาลองอีกครั้งหรือส่งอีเมลสำรองด้านล่างนะคะ");
      }
      if (!body.request) {
        throw new Error("ไม่พบข้อมูลคำขอที่ส่งกลับมาจากเซิร์ฟเวอร์");
      }
      const result: TierRequestSubmitResult = {
        request: body.request,
        alreadyPending: body.alreadyPending === true,
        emailSent: body.emailSent === true,
        mailtoUrl: body.mailtoUrl || mailtoUrl,
        requestEmail: body.requestEmail || SELECTED_REQUEST_EMAIL,
      };
      setSubmitResult(result);
      onSubmitted(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "ส่งคำขอไม่สำเร็จ");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="chat-backdrop" role="presentation" onClick={onClose}>
      <section
        className="info-sheet tier-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Request Selected Tier"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="memory-sheet-head">
          <div>
            <small>SELECTED TIER</small>
            <h1>ขออัปเกรดเป็น Selected</h1>
            <p>คุยได้ 20 ข้อความ/วัน (รีเซ็ต 00:00 UTC+7) + Cloud R2 ส่วนตัว 512 MB สำหรับโมเดลและฉาก</p>
          </div>
          <button type="button" onClick={onClose} aria-label="ปิด">
            ×
          </button>
        </div>

        {existing && (
          <div className={`tier-request-status is-${existing.status}`} role="status">
            <strong>สถานะล่าสุด: {requestStatusLabel(existing.status)}</strong>
            <span>ส่งเมื่อ {new Date(existing.createdAt).toLocaleString()}</span>
            {existing.reviewNote && <small>หมายเหตุจากผู้ดูแล: {existing.reviewNote}</small>}
          </div>
        )}

        {submitResult && (
          <div className="tier-submit-feedback" role="status">
            {submitResult.emailSent ? (
              <p>
                ส่งคำขอเรียบร้อยแล้ว และส่งอีเมลแจ้งเตือนอัตโนมัติไปยัง <strong>{targetEmail}</strong> แล้วค่ะ
              </p>
            ) : submitResult.alreadyPending ? (
              <p>
                มีคำขอที่กำลังรอตรวจสอบอยู่แล้วค่ะ หากต้องการย้ำเพิ่มเติมสามารถกดส่งอีเมลไปที่{" "}
                <strong>{targetEmail}</strong> ด้านล่างได้เลยนะคะ
              </p>
            ) : (
              <p>
                บันทึกคำขอในระบบเรียบร้อยแล้วค่ะ (ระบบส่งอีเมลอัตโนมัติยังไม่พร้อมใช้งาน — กรุณากดปุ่มส่งอีเมลไปที่{" "}
                <strong>{targetEmail}</strong> ด้านล่างเพื่อแจ้งทีมงานนะคะ)
              </p>
            )}
          </div>
        )}

        {!isPending && (
          <form className="tier-request-form" onSubmit={(event) => void handleSubmit(event)}>
            <label>
              <span>ชื่อที่อยากให้เรียก (ไม่บังคับ)</span>
              <input
                type="text"
                maxLength={120}
                value={displayName}
                placeholder="เช่น โซระจัง หรือชื่อเล่นของคุณ"
                disabled={submitting}
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </label>
            <label>
              <span>เหตุผลหรือการใช้งานที่ต้องการ (ไม่บังคับ)</span>
              <textarea
                maxLength={1000}
                value={reason}
                placeholder="บอกสั้นๆ ว่าอยากอัปเกรดมาใช้คุยหรือซิงก์โมเดลบน Cloud R2"
                disabled={submitting}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
            {error && <p className="model-notice" role="alert">{error}</p>}
            <div className="tier-modal-actions">
              <button type="button" className="floating-option" disabled={submitting} onClick={onClose}>
                ปิด
              </button>
              <button type="submit" className="floating-option model-import-primary" disabled={submitting}>
                {submitting ? "กำลังส่งคำขอ…" : "ส่งคำขอ Selected Tier"}
              </button>
            </div>
          </form>
        )}

        <div className="tier-mailto-box">
          <p className="floating-note">
            ช่องทางส่งอีเมลสำรองถึง <strong>{targetEmail}</strong> (เปิดแอปอีเมลพร้อมข้อความกรอกล่วงหน้า):
          </p>
          <a href={mailtoUrl} className="floating-option tier-mailto-link">
            ส่งอีเมลไปที่ {targetEmail} ↗
          </a>
          {isPending && (
            <button type="button" className="floating-option" onClick={onClose}>
              ปิดหน้าต่าง
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

export function LimitReachedModal({
  open,
  account,
  onClose,
  onOpenRequest,
}: {
  open: boolean;
  account: AccountSummary | null;
  onClose: () => void;
  onOpenRequest: () => void;
}) {
  if (!open) return null;
  const tier = account?.tier ?? "free";
  const limit = account?.chatQuota.limit ?? (tier === "selected" ? 20 : 5);
  const used = account?.chatQuota.used ?? limit;
  const mailtoUrl =
    account?.mailtoUrl ||
    buildClientMailtoUrl({
      userEmail: account?.user.email,
      userId: account?.user.id,
      requestId: account?.selectedRequest?.id,
    });

  return (
    <div className="chat-backdrop" role="presentation" onClick={onClose}>
      <section
        className="info-sheet tier-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Daily chat limit reached"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="memory-sheet-head">
          <div>
            <small>DAILY CHAT LIMIT</small>
            <h1>วันนี้คุยครบโควตาแล้วนะคะ</h1>
            <p>{vivianQuotaExceededReply(tier)}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="ปิด">
            ×
          </button>
        </div>

        <div className="info-list">
          <p>
            <strong>Tier</strong>
            {tierDisplayName(tier)} ({used}/{limit} chats used today)
          </p>
          <p>
            <strong>Reset</strong>
            {formatBangkokResetLabel()}
          </p>
          {tier === "free" && account?.selectedRequest && (
            <p>
              <strong>Request</strong>
              {requestStatusLabel(account.selectedRequest.status)}
            </p>
          )}
        </div>

        <div className="tier-modal-actions">
          <button type="button" className="floating-option" onClick={onClose}>
            เข้าใจแล้ว
          </button>
          {tier === "free" && (
            <button
              type="button"
              className="floating-option model-import-primary"
              onClick={() => {
                onClose();
                onOpenRequest();
              }}
            >
              Request Selected Tier
            </button>
          )}
        </div>
        {tier === "free" && (
          <a href={mailtoUrl} className="floating-option tier-mailto-link">
            หรือส่งอีเมลไปที่ {SELECTED_REQUEST_EMAIL} ↗
          </a>
        )}
      </section>
    </div>
  );
}

export function SorachanAdminPanel({
  onAccountChanged,
}: {
  onAccountChanged?: () => void;
}) {
  const [data, setData] = useState<AdminTierDataResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
  const [emailInput, setEmailInput] = useState("");
  const [targetTier, setTargetTier] = useState<"selected" | "free">("selected");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadAdminData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await authFetch("/api/admin/tier-requests", {
        cache: "no-store",
        signal: AbortSignal.timeout(12_000),
      });
      const body = await response.json().catch(() => ({})) as Partial<AdminTierDataResponse> & { error?: string };
      if (!response.ok) {
        throw new Error(body.error || "โหลดข้อมูล Admin ไม่สำเร็จ");
      }
      setData({
        requests: Array.isArray(body.requests) ? body.requests : [],
        accounts: Array.isArray(body.accounts) ? body.accounts : [],
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "โหลดข้อมูล Admin ไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => {
      void loadAdminData();
    }, 0);
    return () => window.clearTimeout(initial);
  }, [loadAdminData]);

  async function reviewRequest(requestId: string, action: "approve" | "reject") {
    setBusyId(requestId);
    setNotice(null);
    setError(null);
    try {
      const response = await authFetch("/api/admin/tier-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          requestId,
          reviewNote: reviewNotes[requestId]?.trim() || undefined,
        }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error || "อัปเดตคำขอไม่สำเร็จ");
      setNotice(action === "approve" ? "อนุมัติ Selected Tier แล้ว" : "ปฏิเสธคำขอแล้ว");
      await loadAdminData();
      onAccountChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "อัปเดตคำขอไม่สำเร็จ");
    } finally {
      setBusyId(null);
    }
  }

  async function setAccountTier(emailOrUserId: string, tier: "free" | "selected") {
    const trimmed = emailOrUserId.trim();
    if (!trimmed) return;
    setBusyId(`tier:${trimmed}`);
    setNotice(null);
    setError(null);
    try {
      const response = await authFetch("/api/admin/tier-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "set_tier",
          emailOrUserId: trimmed,
          tier,
        }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error || "เปลี่ยน Tier ไม่สำเร็จ");
      setNotice(`ตั้งค่า ${trimmed} เป็น ${tierDisplayName(tier)} แล้ว`);
      setEmailInput("");
      await loadAdminData();
      onAccountChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "เปลี่ยน Tier ไม่สำเร็จ");
    } finally {
      setBusyId(null);
    }
  }

  const pendingRequests = data?.requests.filter((item) => item.status === "pending") ?? [];
  const recentRequests = data?.requests.filter((item) => item.status !== "pending").slice(0, 10) ?? [];

  return (
    <div className="custom-instructions sorachan-admin-panel">
      <div className="tier-settings-head">
        <div>
          <strong>Sorachan Admin · Tier Management</strong>
          <p>อนุมัติคำขอ Selected Tier และจัดการแพ็กเกจผู้ใช้รายอีเมล</p>
        </div>
        <button
          type="button"
          className="floating-option sorachan-refresh-btn"
          disabled={loading}
          onClick={() => void loadAdminData()}
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {notice && <p className="floating-note" role="status">{notice}</p>}
      {error && <p className="model-notice" role="alert">{error}</p>}

      <div className="admin-section">
        <small className="admin-section-label">Pending Selected Requests ({pendingRequests.length})</small>
        {pendingRequests.length === 0 ? (
          <p className="floating-note">ไม่มีคำขอที่รออนุมัติในตอนนี้</p>
        ) : (
          <div className="admin-request-list">
            {pendingRequests.map((req) => (
              <article key={req.id} className="admin-request-card">
                <div className="admin-request-head">
                  <strong>{req.email}</strong>
                  <span className="tier-badge is-free">Pending</span>
                </div>
                {req.displayName && <small>Name: {req.displayName}</small>}
                {req.reason && <p>{req.reason}</p>}
                <input
                  type="text"
                  maxLength={500}
                  value={reviewNotes[req.id] ?? ""}
                  placeholder="หมายเหตุการพิจารณา (ไม่บังคับ)"
                  disabled={busyId === req.id}
                  onChange={(event) =>
                    setReviewNotes((prev) => ({ ...prev, [req.id]: event.target.value }))
                  }
                />
                <div className="admin-request-actions">
                  <button
                    type="button"
                    className="floating-option model-import-primary"
                    disabled={busyId === req.id}
                    onClick={() => void reviewRequest(req.id, "approve")}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className="floating-option model-remove"
                    disabled={busyId === req.id}
                    onClick={() => void reviewRequest(req.id, "reject")}
                  >
                    Reject
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      {recentRequests.length > 0 && (
        <details className="admin-recent-details">
          <summary>Recent Reviewed Requests ({recentRequests.length})</summary>
          <div className="admin-request-list">
            {recentRequests.map((req) => (
              <article key={req.id} className="admin-request-card is-reviewed">
                <div className="admin-request-head">
                  <strong>{req.email}</strong>
                  <span className={`tier-badge is-${req.status === "approved" ? "selected" : "free"}`}>
                    {req.status}
                  </span>
                </div>
                {req.reason && <p>{req.reason}</p>}
                {req.reviewNote && <small>Note: {req.reviewNote}</small>}
              </article>
            ))}
          </div>
        </details>
      )}

      <div className="admin-section">
        <small className="admin-section-label">Set User Tier by Email or User ID</small>
        <form
          className="admin-set-tier-form"
          onSubmit={(event) => {
            event.preventDefault();
            void setAccountTier(emailInput, targetTier);
          }}
        >
          <input
            type="text"
            value={emailInput}
            placeholder="user@example.com หรือ userId"
            disabled={busyId !== null}
            onChange={(event) => setEmailInput(event.target.value)}
          />
          <select
            aria-label="Target tier"
            value={targetTier}
            disabled={busyId !== null}
            onChange={(event) => setTargetTier(event.target.value as "free" | "selected")}
          >
            <option value="selected">Selected</option>
            <option value="free">Free</option>
          </select>
          <button
            type="submit"
            className="floating-option model-import-primary"
            disabled={busyId !== null || !emailInput.trim()}
          >
            Apply
          </button>
        </form>
      </div>

      {data && data.accounts.length > 0 && (
        <details className="admin-recent-details">
          <summary>User Accounts ({data.accounts.length})</summary>
          <div className="admin-account-list">
            {data.accounts.map((acc) => {
              const nextTier = acc.tier === "selected" ? "free" : "selected";
              return (
                <div key={acc.userId} className="admin-account-row">
                  <div className="admin-account-meta">
                    <strong>{acc.email}</strong>
                    <small>{acc.userId}</small>
                  </div>
                  <TierBadge tier={acc.tier} />
                  <button
                    type="button"
                    className="floating-option"
                    disabled={busyId !== null}
                    onClick={() => void setAccountTier(acc.email || acc.userId, nextTier)}
                  >
                    Set {tierDisplayName(nextTier)}
                  </button>
                </div>
              );
            })}
          </div>
        </details>
      )}
    </div>
  );
}
