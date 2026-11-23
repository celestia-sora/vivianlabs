import { cloudApi } from "@/lib/cloud-api";
import { saveCloudModelExpressions } from "@/lib/cloud-store";
import { storageJson } from "@/lib/cloud-storage";

export const runtime = "nodejs";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return cloudApi(request, async (db, userId, tier) => {
    const { id } = await params;
    const input = tier === "free" ? {} : await storageJson(request);
    return Response.json(await saveCloudModelExpressions(db, userId, id, input, { tier }));
  });
}
