import { cloudApi } from "@/lib/cloud-api";
import { SELECTED_USER_STORAGE_LIMIT_BYTES } from "@/lib/cloud-storage";
import { personalStorageUsage } from "@/lib/cloud-store";
import { getStorageStatus } from "@/lib/storage-status-store";

export const runtime = "nodejs";

export async function GET(request: Request) {
  return cloudApi(request, async (db, userId, tier) => {
    if (tier === "free") {
      return Response.json({
        cloudAllowed: false,
        tier: "free",
        r2: null,
        supabase: null,
        checkedAt: new Date().toISOString(),
      });
    }
    if (tier === "selected") {
      const personal = await personalStorageUsage(db, userId, "selected");
      return Response.json({
        cloudAllowed: true,
        tier: "selected",
        usedBytes: personal.used,
        personalLimitBytes: SELECTED_USER_STORAGE_LIMIT_BYTES,
        personalUsage: personal,
        r2: {
          usedBytes: personal.used,
          limitBytes: SELECTED_USER_STORAGE_LIMIT_BYTES,
          connected: true,
          categories: null,
          quotaUsage: null,
        },
        supabase: null,
        checkedAt: new Date().toISOString(),
      });
    }
    const status = await getStorageStatus(db);
    return Response.json({
      ...status,
      cloudAllowed: true,
      tier: "sorachan",
    });
  });
}
