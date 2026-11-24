"use client";

import { useCallback, useEffect, useState } from "react";
import { authFetch } from "@/lib/auth/fetch";

export type TierKey = "free" | "selected" | "sorachan";

export const SELECTED_REQUEST_EMAIL = "viviannextlabs@gmail.com";
export const SELECTED_STORAGE_LIMIT_BYTES = 512 * 1024 * 1024;
export const CLOUD_TIER_REQUIRED_MESSAGE =
  "ฟีเจอร์ Cloud R2 ต้องอัปเป็น Selected ขึ้นไปก่อนน้า (แต่เอาโมเดลลงเครื่องเล่นได้ปกติเลย)";

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
  if (tier === "sorachan") return "Sorachan · คุยได้ไม่อั้น";
  const fallbackLimit = tier === "selected" ? 20 : 5;
  const limit = chatQuota?.limit ?? fallbackLimit;
  const remaining = chatQuota
    ? Math.max(0, chatQuota.remaining ?? Math.max(0, limit - chatQuota.used))
    : limit;
  return `${tierDisplayName(tier)} · เหลือ ${remaining}/${limit} ข้อความวันนี้`;
}

export function formatPersonalMb(bytes: number): string {
  const safeBytes = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  return `${(safeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatBangkokResetLabel(): string {
  return "รีเซ็ตใหม่ทุกเที่ยงคืนเวลาไทย (00:00)";
}

export function vivianQuotaExceededReply(tier: TierKey): string {
  if (tier === "selected") {
    return "อ๊ะ... วันนี้เราเมาท์กันครบโควตาแล้วอะ ไม่ได้ไล่นะ! แค่ระบบพักเบรก รอรีเซ็ตตอนเที่ยงคืนเวลาไทย พรุ่งนี้ค่อยมาเมาท์กันต่อน้า";
  }
  if (tier === "free") {
    return "งื้อ... วันนี้คุยครบโควตาแล้วอะ ไม่ใช่ว่าไม่อยากคุยต่อสักหน่อยนะ แค่ต้องรอรีเซ็ตตอนเที่ยงคืนเวลาไทย... หรือถ้าอยากเม้าท์ต่อยาว ๆ จะลองกดขอ Selected ดูก็ได้นะ!";
  }
  return "อุ๊ย... ตอนนี้ระบบพักแป๊บนึงนะ เดี๋ยวลองทักมาใหม่อีกที!";
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
  if (status === "approved") return "อนุมัติแล้ว เย้!";
  if (status === "rejected") return "รอบนี้ยังไม่ผ่านน้า";
  return "กำลังรอแอดมินเช็กอยู่";
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
      ? "กำลังเช็กแพ็กเกจแป๊บ…"
      : "Free · เหลือ 5/5 ข้อความวันนี้";
  const email = account?.user.email || accountEmail;
  const resolvedName = profileDisplayName?.trim() || account?.userProfile?.displayName?.trim() || "";

  return (
    <div className="tier-menu-card" aria-label="สรุปแพ็กเกจบัญชี">
      <div className="tier-menu-top">
        <TierBadge tier={tier} />
        <strong className="tier-menu-quota">{badgeLine}</strong>
      </div>
      <div className="tier-menu-meta">
        <span>
          {tier === "sorachan"
            ? "คุยไม่อั้น · ใช้ Cloud R2 + แอดมินได้ครบ"
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
              ? "รอเช็กคำขอ Selected อยู่"
              : "ขออัปเป็น Selected"}
          </button>
        )}
        {onOpenProfile && (
          <button
            type="button"
            className="tier-menu-upgrade"
            onClick={onOpenProfile}
          >
            {resolvedName ? `เรียกเธอว่า: ${resolvedName}` : "ตั้งค่าชื่อ & สไตล์คุย"}
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
      ? "แป๊บนะ กำลังเช็กสิทธิ์ให้…"
      : "Free · เหลือ 5/5 ข้อความวันนี้";
  const mailtoHref =
    account?.mailtoUrl ||
    buildClientMailtoUrl({ userEmail: accountEmail, userId: accountId });
  const request = account?.selectedRequest;

  return (
    <div className="custom-instructions tier-settings-card">
      <div className="tier-settings-head">
        <div>
          <strong>แพ็กเกจกับโควตาคุยวันนี้</strong>
          <p>{quotaText}</p>
        </div>
        <TierBadge tier={tier} />
      </div>
      <p>
        {tier === "sorachan"
          ? "Sorachan · คุยไม่อั้น แถม Cloud R2 เต็มระบบ + สิทธิ์แอดมินฉ่ำ ๆ"
          : tier === "selected"
            ? `Selected · คุยได้ 20 ข้อความ/วัน (${formatBangkokResetLabel()}) · พื้นที่ Cloud R2 ส่วนตัว ${formatPersonalMb(account?.storage.usedBytes ?? 0)} / 512 MB`
            : `Free · คุยได้ 5 ข้อความ/วัน (${formatBangkokResetLabel()}) · เอาโมเดลเข้าเครื่องเล่นได้ปกติเลย`}
      </p>
      {tier === "free" && request && (
        <div className={`tier-request-status is-${request.status}`} role="status">
          <strong>สถานะขอ Selected: {requestStatusLabel(request.status)}</strong>
          <span>
            กดส่งเมื่อ {new Date(request.createdAt).toLocaleString()}
          </span>
          {request.reviewNote && <small>โน้ตจากแอดมิน: {request.reviewNote}</small>}
        </div>
      )}
      {tier === "free" && (
        <div className="tier-settings-actions">
          <button
            type="button"
            className="floating-option model-import-primary"
            onClick={onOpenRequest}
          >
            {request?.status === "pending" ? "เช็กสถานะคำขอ / ทักเมล" : "ขออัปเป็น Selected"}
          </button>
          <a
            href={mailtoHref}
            className="floating-option tier-mailto-link"
          >
            ทักเมลหา {SELECTED_REQUEST_EMAIL}
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
        throw new Error(body.error || "ส่งคำขอไม่ติดแฮะ ลองใหม่อีกที หรือกดส่งเมลข้างล่างแทนก็ได้นะ");
      }
      if (!body.request) {
        throw new Error("ไม่ได้รับข้อมูลคำขอตอบกลับ ลองใหม่อีกรอบน้า");
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
      setError(err instanceof Error ? err.message : "ส่งคำขอไม่สำเร็จแฮะ");
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
        aria-label="ขออัปเป็น Selected"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="memory-sheet-head">
          <div>
            <small>SELECTED TIER</small>
            <h1>ขออัปเป็น Selected กันเถอะ</h1>
            <p>คุยฉ่ำขึ้นเป็น 20 ข้อความ/วัน (รีเซ็ตเที่ยงคืนเวลาไทย) + พื้นที่ Cloud R2 ส่วนตัว 512 MB เก็บโมเดลกับฉากไว้ได้ทุกเครื่อง</p>
          </div>
          <button type="button" onClick={onClose} aria-label="ปิด">
            ×
          </button>
        </div>

        {existing && (
          <div className={`tier-request-status is-${existing.status}`} role="status">
            <strong>สถานะล่าสุด: {requestStatusLabel(existing.status)}</strong>
            <span>กดส่งเมื่อ {new Date(existing.createdAt).toLocaleString()}</span>
            {existing.reviewNote && <small>โน้ตจากแอดมิน: {existing.reviewNote}</small>}
          </div>
        )}

        {submitResult && (
          <div className="tier-submit-feedback" role="status">
            {submitResult.emailSent ? (
              <p>
                ส่งคำขอให้เรียบร้อยแล้วนะ! มีเมลเด้งไปหา <strong>{targetEmail}</strong> อัตโนมัติแล้ว รอเลย
              </p>
            ) : submitResult.alreadyPending ? (
              <p>
                มีคำขอที่รอตรวจอยู่แล้วน้า ถ้าอยากทักย้ำให้ไวขึ้น กดส่งเมลไปที่{" "}
                <strong>{targetEmail}</strong> ข้างล่างได้เลย
              </p>
            ) : (
              <p>
                จดคำขอลงระบบไว้ให้แล้ว! แต่ระบบส่งเมลออโต้ยังไม่พร้อม — กดส่งเมลไปที่{" "}
                <strong>{targetEmail}</strong> ข้างล่างบอกทีมงานหน่อยน้า
              </p>
            )}
          </div>
        )}

        {!isPending && (
          <form className="tier-request-form" onSubmit={(event) => void handleSubmit(event)}>
            <label>
              <span>ชื่อที่อยากให้เรียก (ข้ามได้น้า)</span>
              <input
                type="text"
                maxLength={120}
                value={displayName}
                placeholder="เช่น ต้าวส้ม หรือชื่อเล่นที่อยากให้เรียก"
                disabled={submitting}
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </label>
            <label>
              <span>อยากอัปเกรดไปใช้ทำอะไรบ้าง (ข้ามได้น้า)</span>
              <textarea
                maxLength={1000}
                value={reason}
                placeholder="เล่าสั้น ๆ เช่น อยากเม้าท์กับวิเวียนนานขึ้น หรืออยากเซฟโมเดลไว้บน Cloud R2"
                disabled={submitting}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
            {error && <p className="model-notice" role="alert">{error}</p>}
            <div className="tier-modal-actions">
              <button type="button" className="floating-option" disabled={submitting} onClick={onClose}>
                ปิดเลย
              </button>
              <button type="submit" className="floating-option model-import-primary" disabled={submitting}>
                {submitting ? "แป๊บนึง กำลังส่ง…" : "ส่งคำขอ Selected"}
              </button>
            </div>
          </form>
        )}

        <div className="tier-mailto-box">
          <p className="floating-note">
            หรือทักเมลสำรองไปที่ <strong>{targetEmail}</strong> (กดแล้วเปิดแอปเมลพร้อมข้อความให้เลย):
          </p>
          <a href={mailtoUrl} className="floating-option tier-mailto-link">
            ส่งเมลไปที่ {targetEmail} ↗
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
        aria-label="วันนี้เม้าท์ครบโควตาแล้วน้า"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="memory-sheet-head">
          <div>
            <small>DAILY CHAT LIMIT</small>
            <h1>วันนี้เม้าท์ครบโควตาแล้วน้า</h1>
            <p>{vivianQuotaExceededReply(tier)}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="ปิด">
            ×
          </button>
        </div>

        <div className="info-list">
          <p>
            <strong>แพ็กเกจ</strong>
            {tierDisplayName(tier)} (ใช้ไปแล้ว {used}/{limit} ข้อความวันนี้)
          </p>
          <p>
            <strong>รีเซ็ต</strong>
            {formatBangkokResetLabel()}
          </p>
          {tier === "free" && account?.selectedRequest && (
            <p>
              <strong>คำขอ</strong>
              {requestStatusLabel(account.selectedRequest.status)}
            </p>
          )}
        </div>

        <div className="tier-modal-actions">
          <button type="button" className="floating-option" onClick={onClose}>
            โอเค เข้าใจแล้ว
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
              ขออัปเป็น Selected
            </button>
          )}
        </div>
        {tier === "free" && (
          <a href={mailtoUrl} className="floating-option tier-mailto-link">
            หรือส่งเมลไปที่ {SELECTED_REQUEST_EMAIL} ↗
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
        throw new Error(body.error || "โหลดหน้าแอดมินไม่ติดแฮะ");
      }
      setData({
        requests: Array.isArray(body.requests) ? body.requests : [],
        accounts: Array.isArray(body.accounts) ? body.accounts : [],
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "โหลดหน้าแอดมินไม่ติดแฮะ");
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
      if (!response.ok) throw new Error(body.error || "อัปเดตคำขอไม่ติดแฮะ");
      setNotice(action === "approve" ? "อนุมัติ Selected ให้เรียบร้อย!" : "ปฏิเสธคำขอไปแล้วน้า");
      await loadAdminData();
      onAccountChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "อัปเดตคำขอไม่ติดแฮะ");
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
      if (!response.ok) throw new Error(body.error || "เปลี่ยนแพ็กเกจไม่ติดแฮะ");
      setNotice(`ปรับให้ ${trimmed} เป็น ${tierDisplayName(tier)} เรียบร้อย!`);
      setEmailInput("");
      await loadAdminData();
      onAccountChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "เปลี่ยนแพ็กเกจไม่ติดแฮะ");
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
          <strong>Sorachan Admin · จัดการแพ็กเกจ</strong>
          <p>กดอนุมัติคำขอ Selected แล้วก็สลับแพ็กเกจรายเมลตรงนี้ได้เลย</p>
        </div>
        <button
          type="button"
          className="floating-option sorachan-refresh-btn"
          disabled={loading}
          onClick={() => void loadAdminData()}
        >
          {loading ? "กำลังโหลด…" : "รีเฟรช"}
        </button>
      </div>

      {notice && <p className="floating-note" role="status">{notice}</p>}
      {error && <p className="model-notice" role="alert">{error}</p>}

      <div className="admin-section">
        <small className="admin-section-label">คำขอที่รออนุมัติ ({pendingRequests.length})</small>
        {pendingRequests.length === 0 ? (
          <p className="floating-note">ยังไม่มีคิวรออนุมัติเลย ชิลล์ ๆ</p>
        ) : (
          <div className="admin-request-list">
            {pendingRequests.map((req) => (
              <article key={req.id} className="admin-request-card">
                <div className="admin-request-head">
                  <strong>{req.email}</strong>
                  <span className="tier-badge is-free">รอตรวจ</span>
                </div>
                {req.displayName && <small>ชื่อที่ให้เรียก: {req.displayName}</small>}
                {req.reason && <p>{req.reason}</p>}
                <input
                  type="text"
                  maxLength={500}
                  value={reviewNotes[req.id] ?? ""}
                  placeholder="โน้ตเพิ่มเติม (ไม่ใส่ก็ได้)"
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
                    อนุมัติเลย
                  </button>
                  <button
                    type="button"
                    className="floating-option model-remove"
                    disabled={busyId === req.id}
                    onClick={() => void reviewRequest(req.id, "reject")}
                  >
                    ปฏิเสธ
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      {recentRequests.length > 0 && (
        <details className="admin-recent-details">
          <summary>ประวัติคำขอที่ตรวจไปแล้ว ({recentRequests.length})</summary>
          <div className="admin-request-list">
            {recentRequests.map((req) => (
              <article key={req.id} className="admin-request-card is-reviewed">
                <div className="admin-request-head">
                  <strong>{req.email}</strong>
                  <span className={`tier-badge is-${req.status === "approved" ? "selected" : "free"}`}>
                    {requestStatusLabel(req.status)}
                  </span>
                </div>
                {req.reason && <p>{req.reason}</p>}
                {req.reviewNote && <small>โน้ต: {req.reviewNote}</small>}
              </article>
            ))}
          </div>
        </details>
      )}

      <div className="admin-section">
        <small className="admin-section-label">ตั้งแพ็กเกจให้ผู้ใช้ (ใส่อีเมลหรือไอดี)</small>
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
            placeholder="user@example.com หรือไอดีผู้ใช้"
            disabled={busyId !== null}
            onChange={(event) => setEmailInput(event.target.value)}
          />
          <select
            aria-label="แพ็กเกจที่ต้องการตั้ง"
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
            อัปเดตเลย
          </button>
        </form>
      </div>

      {data && data.accounts.length > 0 && (
        <details className="admin-recent-details">
          <summary>บัญชีทั้งหมด ({data.accounts.length})</summary>
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
                    เปลี่ยนเป็น {tierDisplayName(nextTier)}
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
