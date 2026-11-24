"use client";
/* Private authenticated image routes intentionally use native img, avoiding an
 * unauthenticated optimizer fetch or leaking storage references. */
/* eslint-disable @next/next/no-img-element */
import { useEffect, useRef, useState } from "react";
import AnimatedFileUpload from "@/components/ui/smoothui/animated-file-upload";
import { authFetch } from "@/lib/auth/fetch";
import { SCENE_MAX_BYTES, SCENE_MAX_COUNT, SCENE_MIME_TYPES, validateSceneLabel, type VivianScene } from "@/lib/scenes";
import { SceneRequestError, sceneRequest, type SceneLibrary } from "@/lib/use-scene-library";
import { CLOUD_TIER_REQUIRED_MESSAGE } from "@/app/components/tier-panel";

export function SceneManager({
  library,
  cloudAllowed = true,
  onRequestSelected,
}: {
  library: SceneLibrary;
  cloudAllowed?: boolean;
  onRequestSelected?: () => void;
}) {
  const [editor, setEditor] = useState<{ scene?: VivianScene; replace: boolean } | null>(null);
  const [label, setLabel] = useState("");
  const [mode, setMode] = useState<"upload" | "url">("upload");
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tierRequiredError, setTierRequiredError] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const labelInput = useRef<HTMLInputElement>(null);
  const previewRequest = useRef<AbortController | null>(null);
  useEffect(() => () => { previewRequest.current?.abort(); }, []);
  useEffect(() => () => { if (preview?.startsWith("blob:")) URL.revokeObjectURL(preview); }, [preview]);
  function closeMenu(event: React.MouseEvent<HTMLButtonElement>) {
    const menu = event.currentTarget.closest("details");
    if (menu) menu.open = false;
  }
  function open(scene?: VivianScene, replace = true) {
    previewRequest.current?.abort();
    setEditor({ scene, replace }); setLabel(scene?.label ?? ""); setMode("upload"); setFile(null); setUrl(""); setPreview(scene?.imageUrl ?? null); setError(null); setTierRequiredError(false); setSuccess(null);
    window.setTimeout(() => labelInput.current?.focus(), 0);
  }
  function chooseFile(image?: File) {
    setError(null); setTierRequiredError(false); setPreview(null); setFile(null);
    if (!image) return;
    if (!SCENE_MIME_TYPES.includes(image.type) || image.size > SCENE_MAX_BYTES || !image.size) { setError("ขอรูป JPG, PNG, WebP หรือ AVIF ที่ขนาดไม่เกิน 8 MB น้า"); return; }
    setFile(image); setPreview(URL.createObjectURL(image));
  }
  async function previewUrl() {
    setWorking(true); setError(null); setTierRequiredError(false); setPreview(null);
    const controller = new AbortController(); previewRequest.current = controller;
    try {
      validateSceneLabel(label);
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("ใส่ลิงก์รูปที่ขึ้นต้นด้วย http:// หรือ https:// นะ");
      const response = await authFetch("/api/scenes/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label, url }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]) });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string; code?: string };
        if (payload.code === "TIER_REQUIRED") {
          setTierRequiredError(true);
          throw new Error(CLOUD_TIER_REQUIRED_MESSAGE);
        }
        throw new Error(payload.error ?? "ดึงรูปจากลิงก์ไม่สำเร็จแฮะ");
      }
      const blob = await response.blob();
      if (!controller.signal.aborted) setPreview(URL.createObjectURL(blob));
    } catch (error) { if (!controller.signal.aborted) setError((error as Error).message === "Invalid URL" ? "ลิงก์รูปนี้ดูแปลก ๆ นะ วางใหม่อีกรอบสิ" : (error as Error).message); }
    finally { setWorking(false); }
  }
  async function save(event: React.FormEvent) {
    event.preventDefault(); setWorking(true); setError(null); setTierRequiredError(false);
    try {
      const validatedLabel = validateSceneLabel(label);
      let options: RequestInit;
      if (editor?.replace && mode === "upload") {
        if (!file) throw new Error("เลือกรูปก่อนน้า ยังไม่มีรูปเลย");
        const body = new FormData(); body.set("label", validatedLabel); body.set("image", file);
        options = { body };
      } else options = { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: validatedLabel, ...(editor?.replace ? { url } : {}) }) };
      const { scene } = await sceneRequest<{ scene: VivianScene }>(editor?.scene ? `/api/scenes/${editor.scene.id}` : "/api/scenes", { ...options, method: editor?.scene ? "PATCH" : "POST" });
      library.invalidateRequests();
      await library.refresh();
      setEditor(null); setSuccess(`เซฟฉาก "${scene.label}" เรียบร้อย จึ้งเลย!`);
    } catch (error) {
      if (error instanceof SceneRequestError && error.code === "TIER_REQUIRED") {
        setTierRequiredError(true);
        setError(CLOUD_TIER_REQUIRED_MESSAGE);
      } else {
        setError((error as Error).message);
      }
    }
    finally { setWorking(false); }
  }
  async function remove(scene: VivianScene) {
    setWorking(true); setError(null);
    try {
      await sceneRequest(`/api/scenes/${scene.id}`, { method: "DELETE" });
      library.invalidateRequests();
      await library.refresh(); setDeleting(null); setSuccess("ลบฉากนี้ทิ้งให้แล้วน้า");
    } catch (error) { setError((error as Error).message); }
    finally { setWorking(false); }
  }

  if (!cloudAllowed) {
    return <div className="scene-manager">
      <div className="tier-gate-notice" role="note">
        <strong>ฉากส่วนตัวบน Cloud · ต้องเป็น Selected ขึ้นไปน้า</strong>
        <p>{CLOUD_TIER_REQUIRED_MESSAGE}</p>
        <small>แต่ฉากสำเร็จรูปข้างล่าง (Christmas Day / Night) ยังกดเปลี่ยนเล่นได้ชิลล์ ๆ เหมือนเดิมเลย!</small>
        {onRequestSelected && (
          <button type="button" className="floating-option model-import-primary" onClick={onRequestSelected}>
            ขออัปเป็น Selected
          </button>
        )}
      </div>
    </div>;
  }

  return <div className="scene-manager">
    {library.notice && <div role="alert" className="model-notice">{library.notice}{!library.ready && <button type="button" className="floating-option" onClick={() => void library.refresh().catch((error: Error) => library.setNotice(error.message))}>โหลดฉากใหม่อีกที</button>}</div>}
    {success && <p role="status" className="floating-note">{success}</p>}
    {!editor && library.scenes.length < SCENE_MAX_COUNT && <AnimatedFileUpload
      accept={SCENE_MIME_TYPES.join(",")}
      className="vivian-upload scene-upload"
      disabled={!library.ready || working}
      maxSize={SCENE_MAX_BYTES}
      multiple={false}
      onFilesSelected={(files) => {
        const image = files[0];
        if (!image) return;
        open();
        chooseFile(image);
      }}
    />}
    {editor && <form className="scene-editor" aria-label={editor.scene ? "แก้ฉาก" : "เพิ่มฉากใหม่"} onSubmit={(event) => void save(event)}>
      <h3>{editor.scene ? editor.replace ? "เปลี่ยนรูปฉากใหม่" : "แก้ชื่อฉาก" : "เพิ่มฉากใหม่"}</h3>
      <label>ตั้งชื่อฉาก<input ref={labelInput} value={label} maxLength={100} required placeholder="เช่น ห้องนอนตอนกลางคืน คาเฟ่ชิลล์ ๆ" onChange={(event) => setLabel(event.target.value)} disabled={working}/></label>
      <small>{[...label.trim().normalize("NFC")].length}/50 ตัวอักษร</small>
      {editor.replace && <>
        <p className="floating-note">เอารูปมาจากไหนดี</p>
        <div className="floating-tabs">{(["upload", "url"] as const).map((value) => <button type="button" key={value} aria-pressed={mode === value} className={mode === value ? "is-selected" : ""} disabled={working} onClick={() => { setMode(value); setFile(null); setPreview(null); setError(null); setTierRequiredError(false); }}>{value === "upload" ? "อัปโหลดรูปจากเครื่อง" : "วางลิงก์รูป"}</button>)}</div>
        {mode === "upload" ? <AnimatedFileUpload
          accept={SCENE_MIME_TYPES.join(",")}
          className="vivian-upload"
          disabled={working}
          maxSize={SCENE_MAX_BYTES}
          multiple={false}
          onFilesSelected={(files) => chooseFile(files[0])}
        /> : <><label>ลิงก์รูปภาพ<input type="url" required value={url} placeholder="https://example.com/wallpaper.jpg" disabled={working} onChange={(event) => { setUrl(event.target.value); setPreview(null); }}/></label><button type="button" className="floating-option" disabled={working || !url} onClick={() => void previewUrl()}>ลองดูภาพตัวอย่าง</button></>}
      </>}
      {preview && <div className="scene-preview"><p className="floating-note">ตัวอย่างฉาก</p><img src={preview} alt="ตัวอย่างฉาก" onError={() => { setPreview(null); setError("พรีวิวรูปนี้ไม่ได้แฮะ ลองเปลี่ยนเป็นรูปอื่นดูนะ"); }}/></div>}
      {error && <div className="model-notice" role="alert"><p style={{ margin: 0 }}>{error}</p>{tierRequiredError && onRequestSelected && <button type="button" className="floating-option model-import-primary" onClick={onRequestSelected}>ขออัปเป็น Selected</button>}</div>}
      <div className="scene-editor-actions"><button type="button" className="floating-option" disabled={working} onClick={() => { setEditor(null); setPreview(null); setError(null); setTierRequiredError(false); }}>ยกเลิก</button><button type="submit" className="floating-option model-import-primary" disabled={working}>{working ? "แป๊บ กำลังเซฟ…" : "เซฟฉากเลย"}</button></div>
    </form>}
    {!editor && error && <p className="model-notice" role="alert">{error}</p>}
    {!library.ready && !library.notice && <p className="floating-note" role="status">กำลังโหลดฉากสวย ๆ แป๊บ…</p>}
    {!editor && library.ready && !library.scenes.length && <p className="floating-empty">ยังไม่มีฉากของตัวเองเลย โยนรูปเข้ามาแล้วตั้งชื่อเก๋ ๆ มาเริ่มคอลเลกชันกัน!</p>}
    <div className="custom-scene-grid">{library.scenes.map((scene) => <article key={scene.id} className={library.preferences.activeSceneId === scene.id ? "is-selected" : ""}>
      <button type="button" className="custom-scene-select" disabled={working} aria-pressed={library.preferences.activeSceneId === scene.id} onClick={() => void library.selectScene(scene.id)}>
        <img className="custom-scene-image" src={scene.thumbnailUrl} alt="" loading="lazy"/><strong>{scene.label}</strong><small>{library.preferences.activeSceneId === scene.id ? "ใช้อยู่ตอนนี้" : "กดใช้ฉากนี้"}</small>
      </button>
      <details className="scene-card-menu"><summary aria-label={`เมนูจัดการ ${scene.label}`}>…</summary><div><button type="button" disabled={working} onClick={(event) => { closeMenu(event); open(scene, false); }}>แก้ชื่อฉาก</button><button type="button" disabled={working} onClick={(event) => { closeMenu(event); open(scene); }}>เปลี่ยนรูปใหม่</button><button type="button" disabled={working} onClick={(event) => { closeMenu(event); setDeleting(scene.id); }}>ลบฉากนี้</button></div></details>
      {deleting === scene.id && <div className="scene-delete-confirm" role="group" aria-label={`ลบฉาก ${scene.label} ไหม?`}><p>ลบฉากนี้จริงดิ?</p><button type="button" className="floating-option" disabled={working} onClick={() => void remove(scene)}>ลบเลย</button><button type="button" className="floating-option" disabled={working} onClick={() => setDeleting(null)}>ไม่ลบละ</button></div>}
    </article>)}</div>
  </div>;
}
