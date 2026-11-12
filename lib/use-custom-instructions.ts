"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { authFetch } from "@/lib/auth/fetch";
import { MAX_CUSTOM_INSTRUCTIONS_LENGTH } from "@/lib/custom-instructions";

const ACTIVE_USER_KEY = "vivian-custom-instructions-user";
const cacheKey = (userId: string) => `vivian-custom-instructions:${userId}`;
const syncedKey = (userId: string) => `vivian-custom-instructions-synced:${userId}`;

function activeUser(): string {
  if (typeof window === "undefined") return "";
  try { return window.localStorage.getItem(ACTIVE_USER_KEY) ?? ""; } catch { return ""; }
}
function readCache(userId: string): string {
  if (typeof window === "undefined" || !userId) return "";
  try { return window.localStorage.getItem(cacheKey(userId)) ?? ""; } catch { return ""; }
}
function writeCache(userId: string, value: string): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(cacheKey(userId), value); } catch { /* storage may be unavailable */ }
}
function hasSynced(userId: string): boolean {
  if (typeof window === "undefined") return false;
  try { return window.localStorage.getItem(syncedKey(userId)) === "1"; } catch { return false; }
}
function markSynced(userId: string): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(syncedKey(userId), "1"); } catch { /* storage may be unavailable */ }
}

function bounded(value: string): string {
  return value.slice(0, MAX_CUSTOM_INSTRUCTIONS_LENGTH);
}

async function writeRemote(value: string): Promise<{ userId: string; instructions: string } | null> {
  try {
    const response = await authFetch("/api/custom-instructions", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customInstructions: value }),
      signal: AbortSignal.timeout(9000),
      keepalive: true,
    });
    if (!response.ok) return null;
    const data = await response.json() as { userId?: unknown; customInstructions?: unknown };
    if (typeof data.userId !== "string" || !data.userId) return null;
    return { userId: data.userId, instructions: typeof data.customInstructions === "string" ? bounded(data.customInstructions) : value };
  } catch {
    return null;
  }
}

export interface CustomInstructionVersion { id: number; created_at: string; instructions: string }

export function useCustomInstructions() {
  const [value, setValue] = useState(() => readCache(activeUser()));
  const [savedValue, setSavedValue] = useState(() => readCache(activeUser()));
  const [saving, setSaving] = useState(false);
  const [synced, setSynced] = useState(() => hasSynced(activeUser()));
  const [notice, setNotice] = useState("");
  const [versions, setVersions] = useState<CustomInstructionVersion[]>([]);
  const alive = useRef(false);
  const savingRef = useRef(false);
  const revision = useRef(0);
  const userIdRef = useRef(activeUser());
  const valueRef = useRef(value);
  const savedRef = useRef(savedValue);
  useEffect(() => {
    valueRef.current = value;
    savedRef.current = savedValue;
  }, [value, savedValue]);

  const refresh = useCallback(async () => {
    if (savingRef.current) return;
    const version = revision.current;
    try {
      const response = await authFetch("/api/custom-instructions", { cache: "no-store", signal: AbortSignal.timeout(9000) });
      if (!response.ok) throw new Error();
      const data = await response.json() as { userId?: unknown; customInstructions?: unknown; versions?: unknown };
      if (typeof data.customInstructions !== "string" || typeof data.userId !== "string" || !data.userId) throw new Error();
      if (data.userId !== userIdRef.current) {
        userIdRef.current = data.userId;
        const accountCache = readCache(data.userId);
        valueRef.current = accountCache;
        savedRef.current = accountCache;
        setValue(accountCache);
        setSavedValue(accountCache);
        try { window.localStorage.setItem(ACTIVE_USER_KEY, data.userId); } catch { /* storage may be unavailable */ }
      }
      if (alive.current && version === revision.current && Array.isArray(data.versions)) {
        setVersions(data.versions.filter((v): v is CustomInstructionVersion => !!v && typeof v === "object" && typeof (v as CustomInstructionVersion).instructions === "string").map(v => ({ id: (v as CustomInstructionVersion).id, created_at: (v as CustomInstructionVersion).created_at, instructions: bounded((v as CustomInstructionVersion).instructions) })));
      }
      if (!alive.current || version !== revision.current) return;

      const remote = bounded(data.customInstructions);
      const local = bounded(readCache(data.userId));
      const hasDraft = valueRef.current !== savedRef.current;
      // A device that existed before cloud sync keeps its instructions: the
      // first successful sync uploads them instead of silently erasing them.
      if (!hasSynced(data.userId) && !hasDraft && local.trim() && local !== remote) {
        const saved = await writeRemote(local);
        if (saved === null) throw new Error();
        if (!alive.current || version !== revision.current) return;
        markSynced(data.userId);
        writeCache(data.userId, saved.instructions);
        setSavedValue(saved.instructions);
        setSynced(true);
        setValue(saved.instructions);
        setNotice("ซิงก์คำแนะนำจากเครื่องนี้แล้ว");
        return;
      }

      // A draft has not been saved yet, so it must not mark the pre-sync local
      // value as already uploaded.
      if (!hasDraft) markSynced(data.userId);
      setSavedValue(remote);
      setSynced(true);
      if (!hasDraft) {
        setValue(remote);
        writeCache(data.userId, remote);
      }
      setNotice("");
    } catch {
      if (alive.current && version === revision.current) {
        setNotice("ซิงก์คำแนะนำกับคลาวด์ไม่ได้ · ใช้ค่าบนเครื่องนี้");
      }
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    window.addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);
    const timer = window.setInterval(visible, 15000);
    return () => {
      alive.current = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", visible);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh]);

  const updateCustomInstructions = useCallback((next: string) => {
    revision.current += 1;
    setValue(bounded(next));
    setNotice("");
  }, []);

  const saveCustomInstructions = useCallback(async () => {
    if (savingRef.current) return;
    const target = bounded(valueRef.current);
    const version = ++revision.current;
    savingRef.current = true;
    setSaving(true);
    setNotice("กำลังบันทึก…");
    try {
      const saved = await writeRemote(target);
      if (saved === null) throw new Error();
      if (!alive.current || version !== revision.current) return;
      userIdRef.current = saved.userId;
      try { window.localStorage.setItem(ACTIVE_USER_KEY, saved.userId); } catch { /* storage may be unavailable */ }
      markSynced(saved.userId);
      writeCache(saved.userId, saved.instructions);
      setSavedValue(saved.instructions);
      setValue(saved.instructions);
      setSynced(true);
      setNotice("บันทึกแล้ว");
    } catch {
      if (alive.current && version === revision.current) setNotice("บันทึกไม่สำเร็จ · ลองอีกครั้ง");
    } finally {
      savingRef.current = false;
      if (alive.current) setSaving(false);
    }
  }, []);

  const resetCustomInstructions = useCallback(() => {
    revision.current += 1;
    setValue("");
    setSavedValue("");
    setSynced(true);
    setNotice("");
  }, []);

  // D7: clearing custom instructions is a separate explicit action,
  // distinct from Reset Vivian (which now keeps them).
  const clearCustomInstructions = useCallback(async () => {
    if (savingRef.current) return;
    revision.current += 1;
    setValue("");
    setSavedValue("");
    setNotice("กำลังล้าง…");
    const saved = await writeRemote("");
    if (saved === null) { setNotice("ล้างไม่สำเร็จ · ลองอีกครั้ง"); return; }
    userIdRef.current = saved.userId;
    try { window.localStorage.setItem(ACTIVE_USER_KEY, saved.userId); } catch { /* storage may be unavailable */ }
    markSynced(saved.userId);
    writeCache(saved.userId, saved.instructions);
    setSavedValue(saved.instructions);
    setValue(saved.instructions);
    setSynced(true);
    setNotice("ล้างคำแนะนำแล้ว");
  }, []);

  // Restore a previous version into the draft; user reviews then Saves,
  // which appends it as a new version row (bad edit recoverable).
  const restoreCustomInstructions = useCallback((instructions: string) => {
    revision.current += 1;
    setValue(bounded(instructions));
    setNotice("โหลดเวอร์ชันก่อนหน้าแล้ว · กด Save เพื่อใช้");
  }, []);

  return {
    customInstructions: value,
    savedCustomInstructions: savedValue,
    updateCustomInstructions,
    saveCustomInstructions,
    resetCustomInstructions,
    refreshCustomInstructions: refresh,
    savingCustomInstructions: saving,
    customInstructionsDirty: value !== savedValue,
    customInstructionsSynced: synced,
    customInstructionsNotice: notice,
    customInstructionVersions: versions,
    clearCustomInstructions,
    restoreCustomInstructions,
  };
}
