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
      setError("อย่าเพิ่งเทสิ บอกชื่อเล่นให้วิเวียนเรียกสักนิดนึงน้า");
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
            <h1>ทักทายกันก่อนสักนิดป่ะ~</h1>
            <p>
              อ๊ะ... เพิ่งเคยเจอกันป่ะเนี่ย บอกชื่อกับฟีลที่ชอบไว้หน่อยดิ ไม่ได้อยากสนิทเป็นพิเศษหรอกนะ... แค่ไม่อยากเรียกผิดแล้วมันช็อตฟีลเฉย ๆ แหละ!
            </p>
          </div>
          <button type="button" onClick={onSkip} aria-label="ปิด">
            ×
          </button>
        </div>

        <form className="tier-request-form onboarding-form" onSubmit={(event) => void handleSubmit(event)}>
          <label>
            <span>อยากให้ Vivian เรียกเธอว่าอะไรดี *</span>
            <input
              type="text"
              maxLength={MAX_PROFILE_DISPLAY_NAME_LENGTH}
              value={displayName}
              placeholder="เช่น พี่ภัทร, ต้าวมิน, หรือชื่อเล่นเก๋ ๆ ของเธอ"
              disabled={saving}
              autoFocus
              onChange={(event) => {
                setDisplayName(event.target.value);
                if (error) setError(null);
              }}
            />
          </label>

          <div className="onboarding-preset-group">
            <span className="onboarding-field-label">อยากเริ่มคุยกันฟีลไหนดีกับ Vivian</span>
            <div className="onboarding-preset-grid" role="radiogroup" aria-label="อยากเริ่มคุยกันฟีลไหนดีกับ Vivian">
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
            <span>คำเรียกแทนตัว / หางเสียงที่ชอบ (ข้ามได้น้า)</span>
            <input
              type="text"
              maxLength={MAX_PROFILE_PRONOUNS_LENGTH}
              value={pronouns}
              placeholder="เช่น เรียกตัวเองว่า เรา/เค้า ให้วิเวียนลงท้าย นะ/งับ หรือ ค่ะ"
              disabled={saving}
              onChange={(event) => setPronouns(event.target.value)}
            />
          </label>

          <label>
            <span>แนวที่ชอบคุย / สไตล์ที่อยากให้วิเวียนพูดด้วย (ข้ามได้น้า)</span>
            <textarea
              maxLength={MAX_PROFILE_STYLE_NOTES_LENGTH}
              value={styleNotes}
              placeholder="เช่น อินเกม อนิเมะ เขียนโค้ด ชอบให้วิเวียนกวน ๆ เล่นมีม หรืออ้อนหน่อย ๆ..."
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
              ไว้ทีหลังละกัน
            </button>
            <button
              type="submit"
              className="floating-option model-import-primary"
              disabled={saving}
            >
              {saving ? "แป๊บนึง กำลังเซฟ…" : "เซฟแล้วไปคุยกับ Vivian เลย!"}
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
          <strong>โปรไฟล์คู่คุยของเธอ</strong>
          <p>
            ให้เรียก: <strong>{profile.displayName || "ยังไม่ได้ตั้งชื่อเลย"}</strong> · ฟีล: {presetLabel}
          </p>
        </div>
      </div>
      {(profile.pronouns || profile.styleNotes) && (
        <p>
          {profile.pronouns ? `คำเรียก: ${profile.pronouns}` : ""}
          {profile.pronouns && profile.styleNotes ? " · " : ""}
          {profile.styleNotes ? `สไตล์ที่ชอบ: ${profile.styleNotes}` : ""}
        </p>
      )}
      <div className="custom-instructions-actions">
        <button
          type="button"
          className="floating-option model-import-primary"
          disabled={saving}
          onClick={onOpenModal}
        >
          แก้ชื่อกับสไตล์ที่ชอบ
        </button>
        {notice && <span role="status">{notice}</span>}
      </div>
    </div>
  );
}
