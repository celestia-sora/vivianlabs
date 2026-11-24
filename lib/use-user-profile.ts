"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { authFetch } from "@/lib/auth/fetch";
import {
  defaultUserProfile,
  isRelationshipPreset,
  type RelationshipPreset,
  type UserProfile,
} from "@/lib/user-profile";

const ACTIVE_USER_KEY = "vivian-user-profile-user";
const cacheKey = (userId: string) => `vivian-user-profile:${userId}`;

function activeUser(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(ACTIVE_USER_KEY) ?? "";
  } catch {
    return "";
  }
}

function readCache(userId: string): UserProfile | null {
  if (typeof window === "undefined" || !userId) return null;
  try {
    const raw = window.localStorage.getItem(cacheKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<UserProfile>;
    if (!parsed || typeof parsed !== "object") return null;
    return {
      userId,
      displayName: typeof parsed.displayName === "string" ? parsed.displayName : "",
      relationship: isRelationshipPreset(parsed.relationship) ? parsed.relationship : "close_friend",
      pronouns: typeof parsed.pronouns === "string" ? parsed.pronouns : "",
      styleNotes: typeof parsed.styleNotes === "string" ? parsed.styleNotes : "",
      onboarded: Boolean(parsed.onboarded),
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
    };
  } catch {
    return null;
  }
}

function writeCache(userId: string, profile: UserProfile): void {
  if (typeof window === "undefined" || !userId) return;
  try {
    window.localStorage.setItem(ACTIVE_USER_KEY, userId);
    window.localStorage.setItem(cacheKey(userId), JSON.stringify(profile));
  } catch {
    /* storage may be unavailable */
  }
}

export function useUserProfile(accountIdHint?: string) {
  const initialUserId = accountIdHint || activeUser();
  const [profile, setProfile] = useState<UserProfile>(() => {
    return readCache(initialUserId) ?? defaultUserProfile(initialUserId, false);
  });
  const [isSorachan, setIsSorachan] = useState(false);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const dismissedForUserRef = useRef<string>("");
  const aliveRef = useRef(false);

  const applyRemoteProfile = useCallback(
    (
      userId: string,
      sorachan: boolean,
      rawProfile?: (Omit<Partial<UserProfile>, "relationship"> & { relationship?: string }) | null,
    ) => {
      if (!userId || !rawProfile) return;
      const localCached = readCache(userId);
      const remoteProfile: UserProfile = {
        userId,
        displayName:
          typeof rawProfile.displayName === "string"
            ? rawProfile.displayName
            : sorachan
              ? "โซระจัง"
              : "",
        relationship: isRelationshipPreset(rawProfile.relationship)
          ? rawProfile.relationship
          : "close_friend",
        pronouns: typeof rawProfile.pronouns === "string" ? rawProfile.pronouns : "",
        styleNotes: typeof rawProfile.styleNotes === "string" ? rawProfile.styleNotes : "",
        onboarded: Boolean(rawProfile.onboarded) || sorachan,
        updatedAt: typeof rawProfile.updatedAt === "string" ? rawProfile.updatedAt : null,
      };

      const effectiveProfile =
        !remoteProfile.onboarded && localCached?.onboarded ? localCached : remoteProfile;

      setIsSorachan(sorachan);
      setProfile(effectiveProfile);
      writeCache(userId, effectiveProfile);
      setReady(true);

      if (
        !sorachan &&
        (!effectiveProfile.onboarded || !effectiveProfile.displayName.trim()) &&
        dismissedForUserRef.current !== userId
      ) {
        setOnboardingOpen(true);
      }
    },
    [],
  );

  const syncFromAccount = useCallback(
    (
      accountData:
        | {
            user?: { id?: string };
            isSorachan?: boolean;
            tier?: string;
            userProfile?: (Omit<Partial<UserProfile>, "relationship"> & { relationship?: string }) | null;
          }
        | null
        | undefined,
    ) => {
      const userId = accountData?.user?.id;
      if (!userId) return;
      const sorachan = accountData.isSorachan === true || accountData.tier === "sorachan";
      if (accountData.userProfile) {
        applyRemoteProfile(userId, sorachan, accountData.userProfile);
      } else {
        applyRemoteProfile(userId, sorachan, defaultUserProfile(userId, sorachan));
      }
    },
    [applyRemoteProfile],
  );

  const refresh = useCallback(async () => {
    // Wait for `#token=...` in URL hash to be consumed into localStorage first.
    if (typeof window !== "undefined") {
      try {
        const match = window.location.hash.match(/#token=([^&]+)/);
        if (match?.[1]) {
          window.localStorage.setItem("vivian_auth_token", decodeURIComponent(match[1]));
          window.history.replaceState(null, "", window.location.pathname);
        }
        if (!window.localStorage.getItem("vivian_auth_token")) {
          return;
        }
      } catch {
        // Proceed if storage access fails
      }
    }

    try {
      const response = await authFetch("/api/user-profile", {
        cache: "no-store",
        signal: AbortSignal.timeout(9000),
      });
      if (!response.ok) throw new Error("Failed to load user profile");
      const data = (await response.json()) as {
        userId?: unknown;
        isSorachan?: unknown;
        profile?: Partial<UserProfile>;
      };
      if (typeof data.userId !== "string" || !data.userId || !data.profile) {
        throw new Error("Invalid user profile response");
      }
      if (!aliveRef.current) return;

      applyRemoteProfile(data.userId, data.isSorachan === true, data.profile);
    } catch {
      if (aliveRef.current) {
        setReady(true);
      }
    }
  }, [applyRemoteProfile]);

  useEffect(() => {
    aliveRef.current = true;
    const timer = window.setTimeout(() => {
      void refresh();
    }, 0);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      aliveRef.current = false;
      window.clearTimeout(timer);
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh, accountIdHint]);

  const saveProfile = useCallback(
    async (next: {
      displayName: string;
      relationship: RelationshipPreset;
      pronouns: string;
      styleNotes: string;
      onboarded?: boolean;
    }): Promise<boolean> => {
      setSaving(true);
      setNotice("กำลังบันทึกโปรไฟล์…");
      try {
        const response = await authFetch("/api/user-profile", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            displayName: next.displayName,
            relationship: next.relationship,
            pronouns: next.pronouns,
            styleNotes: next.styleNotes,
            onboarded: next.onboarded ?? true,
          }),
          signal: AbortSignal.timeout(9000),
        });
        if (!response.ok) {
          const err = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(err.error || "บันทึกโปรไฟล์ไม่สำเร็จ");
        }
        const data = (await response.json()) as {
          userId?: string;
          isSorachan?: boolean;
          profile?: UserProfile;
        };
        if (data.profile && typeof data.userId === "string") {
          setProfile(data.profile);
          writeCache(data.userId, data.profile);
          dismissedForUserRef.current = data.userId;
        }
        setNotice("บันทึกข้อมูลส่วนตัวแล้ว");
        setOnboardingOpen(false);
        return true;
      } catch (err) {
        // Fallback to local cache so the user is never stuck if offline/migration pending
        const fallbackUserId = profile.userId || activeUser() || "local";
        const localSaved: UserProfile = {
          userId: fallbackUserId,
          displayName: next.displayName.trim().slice(0, 60),
          relationship: next.relationship,
          pronouns: next.pronouns.trim().slice(0, 80),
          styleNotes: next.styleNotes.trim().slice(0, 500),
          onboarded: next.onboarded ?? true,
          updatedAt: new Date().toISOString(),
        };
        setProfile(localSaved);
        writeCache(fallbackUserId, localSaved);
        dismissedForUserRef.current = fallbackUserId;
        setNotice(err instanceof Error ? err.message : "บันทึกไว้บนเครื่องนี้แล้ว");
        setOnboardingOpen(false);
        return false;
      } finally {
        if (aliveRef.current) setSaving(false);
      }
    },
    [profile.userId],
  );

  const dismissOnboarding = useCallback(() => {
    if (profile.userId) {
      dismissedForUserRef.current = profile.userId;
    }
    setOnboardingOpen(false);
  }, [profile.userId]);

  return {
    userProfile: profile,
    isSorachanProfile: isSorachan,
    userProfileReady: ready,
    savingUserProfile: saving,
    userProfileNotice: notice,
    onboardingOpen,
    setOnboardingOpen,
    saveUserProfile: saveProfile,
    dismissOnboarding,
    refreshUserProfile: refresh,
    syncUserProfileFromAccount: syncFromAccount,
  };
}
