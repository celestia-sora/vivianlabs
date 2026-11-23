import { cloudApi } from "@/lib/cloud-api";
import { beginCloudModel, cloudModels } from "@/lib/cloud-store";
import { storageJson } from "@/lib/cloud-storage";

export const runtime = "nodejs";

export async function GET(request: Request) {
  return cloudApi(request, async (db, userId, tier) => {
    const library = await cloudModels(db, userId, { tier });
    if (tier === "free") {
      return Response.json({
        userId: library.userId,
        tier: "free",
        cloudAllowed: false,
        sharedAllowed: false,
        models: [],
        usage: null,
        preference: null,
      });
    }
    if (tier === "selected") {
      return Response.json({
        userId: library.userId,
        tier: "selected",
        cloudAllowed: true,
        sharedAllowed: false,
        models: library.models,
        usage: null,
        personalUsage: library.personalUsage,
        preference: library.preference,
      });
    }
    return Response.json({
      userId: library.userId,
      tier: "sorachan",
      cloudAllowed: true,
      sharedAllowed: true,
      models: library.models,
      usage: library.usage,
      personalUsage: library.personalUsage,
      preference: library.preference,
    });
  });
}

export async function POST(request: Request) {
  return cloudApi(request, async (db, userId, tier) => {
    const input = tier === "free" ? {} : await storageJson(request);
    const result = await beginCloudModel(db, userId, input, { tier });
    return Response.json(
      {
        ...result,
        usage: tier === "sorachan" ? result.usage : null,
      },
      { status: 201 },
    );
  });
}
