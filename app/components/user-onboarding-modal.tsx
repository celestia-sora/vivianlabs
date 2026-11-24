"use client";

import { useEffect, useState } from "react";
import {
  MAX_PROFILE_DISPLAY_NAME_LENGTH,
  MAX_PROFILE_PRONOUNS_LENGTH,
  MAX_PROFILE_STYLE_NOTES_LENGTH,
  RELATIONSHIP_PRESETS,
  type RelationshipPreset,
  type UserProfile,
} from "@/lib/user-profile";

export function UserOnboardingModal({
  open,
  profile,
  saving,
  onSave,
  onSkip,
}: {
  open: boolean;
  profile: UserProfile;
  saving?: boolean;
  onSave: (next: {
    displayName: string;
    relationship: RelationshipPreset;
    pronouns: string;
    styleNotes: string;
    onboarded: boolean;
  }) => Promise<boolean>;
  onSkip: () => void;
}) {
  const [displayName, setDisplayName] = useState(profile.displayName);
  const [relationship, setRelationship] = useState<RelationshipPreset>(profile.relationship);
  const [pronouns, setPronouns] = useState(profile.pronouns);
  const [styleNotes, setStyleNotes] = useState(profile.styleNotes);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDisplayName(profile.displayName);
    setRelationship(profile.relationship);
    setPronouns(profile.pronouns);
    setStyleNotes(profile.styleNotes);
    setError(null);
  }, [open, profile.displayName, profile.relationship, profile.pronouns, profile.styleNotes]);

  if (!open) return null;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    const trimmedName = displayName.trim();
    if (!trimmedName) {
      setError("บอกชื่อหรือชื่อเล่นที่อยากให้วิเวียนเรียกสักนิดนึงนะคะ");
      return;
    }
    setError(null);
    await onSave({
      displayName: trimmedName,
      relationship,
      pronouns: pronouns.trim(),
      styleNotes: styleNotes.trim(),
      onboarded: true,
    });
  }

  return (
    <div className="chat-backdrop" role="presentation" onClick={onSkip}>
      <section
        className="info-sheet tier-modal onboarding-card-modal"
        role="dialog"
        aria-modal="true"
        aria-label="ทำความรู้จักกับวิเวียน"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="memory-sheet-head">
          <div>
            <small>WELCOME TO VIVIAN</small>
            <h1>มาทำความรู้จักกันก่อนนะคะ</h1>
            <p>
              อ๊ะ... เพิ่งเคยเจอกันใช่ไหมคะ บอกชื่อกับสไตล์ที่คุณชอบไว้หน่อยสิ ไม่ได้อยากรู้เป็นพิเศษสักหน่อย... แค่จะได้เรียกถูกเฉย ๆ ค่ะ!
            </p>
          </div>
          <button type="button" onClick={onSkip} aria-label="ปิด">
            ×
          </button>
        </div>

        <form className="tier-request-form onboarding-form" onSubmit={(event) => void handleSubmit(event)}>
          <label>
            <span>ชื่อหรือชื่อเล่นที่อยากให้ Vivian เรียก *</span>
            <input
              type="text"
              maxLength={MAX_PROFILE_DISPLAY_NAME_LENGTH}
              value={displayName}
              placeholder="เช่น พี่ภัทร, คุณมิน, หรือชื่อเล่นของคุณ"
              disabled={saving}
              autoFocus
              onChange={(event) => {
                setDisplayName(event.target.value);
                if (error) setError(null);
              }}
            />
          </label>

          <div className="onboarding-preset-group">
            <span className="onboarding-field-label">ความสัมพันธ์เบื้องต้นกับ Vivian</span>
            <div className="onboarding-preset-grid" role="radiogroup" aria-label="ความสัมพันธ์เบื้องต้นกับ Vivian">
              {RELATIONSHIP_PRESETS.map((preset) => {
                const selected = relationship === preset.key;
                return (
                  <button
                    key={preset.key}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    disabled={saving}
                    className={`onboarding-preset-btn ${selected ? "is-selected" : ""}`}
                    onClick={() => setRelationship(preset.key)}
                  >
                    <strong>{preset.label}</strong>
                    <small>{preset.description}</small>
                  </button>
                );
              })}
            </div>
          </div>

          <label>
            <span>สรรพนามหรือคำเรียกที่ใช้คุยกัน (ไม่บังคับ)</span>
            <input
              type="text"
              maxLength={MAX_PROFILE_PRONOUNS_LENGTH}
              value={pronouns}
              placeholder="เช่น เรียกแทนตัวเองว่า เรา/พี่, ให้วิเวียนลงท้ายว่า ค่ะ/นะคะ"
              disabled={saving}
              onChange={(event) => setPronouns(event.target.value)}
            />
          </label>

          <label>
            <span>สไตล์การพูด / เรื่องที่สนใจ (ไม่บังคับ)</span>
            <textarea
              maxLength={MAX_PROFILE_STYLE_NOTES_LENGTH}
              value={styleNotes}
              placeholder="เช่น ชอบคุยเรื่องเกม อนิเมะ เขียนโค้ด อยากให้วิเวียนขี้แกล้งหรืออ้อนนิด ๆ..."
              disabled={saving}
              onChange={(event) => setStyleNotes(event.target.value)}
            />
          </label>

          {error && (
            <p className="model-notice" role="alert">
              {error}
            </p>
          )}

          <div className="tier-modal-actions">
            <button
              type="button"
              className="floating-option"
              disabled={saving}
              onClick={onSkip}
            >
              ไว้ตั้งค่าทีหลัง
            </button>
            <button
              type="submit"
              className="floating-option model-import-primary"
              disabled={saving}
            >
              {saving ? "กำลังบันทึก…" : "บันทึกและเริ่มคุยกับ Vivian"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

export function UserProfileSettingsCard({
  profile,
  saving,
  notice,
  onOpenModal,
}: {
  profile: UserProfile;
  saving?: boolean;
  notice?: string;
  onOpenModal: () => void;
}) {
  const presetLabel =
    RELATIONSHIP_PRESETS.find((item) => item.key === profile.relationship)?.label ??
    RELATIONSHIP_PRESETS[0].label;

  return (
    <div className="custom-instructions user-profile-card">
      <div className="tier-settings-head">
        <div>
          <strong>Your Companion Profile (ข้อมูลส่วนตัวของคุณ)</strong>
          <p>
            ชื่อที่ให้เรียก: <strong>{profile.displayName || "ยังไม่ได้ตั้งชื่อ"}</strong> · ความสัมพันธ์: {presetLabel}
          </p>
        </div>
      </div>
      {(profile.pronouns || profile.styleNotes) && (
        <p>
          {profile.pronouns ? `สรรพนาม: ${profile.pronouns}` : ""}
          {profile.pronouns && profile.styleNotes ? " · " : ""}
          {profile.styleNotes ? `สไตล์/ความสนใจ: ${profile.styleNotes}` : ""}
        </p>
      )}
      <div className="custom-instructions-actions">
        <button
          type="button"
          className="floating-option model-import-primary"
          disabled={saving}
          onClick={onOpenModal}
        >
          ตั้งค่าชื่อและโปรไฟล์ของคุณ
        </button>
        {notice && <span role="status">{notice}</span>}
      </div>
    </div>
  );
}
