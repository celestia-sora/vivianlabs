import { sceneApi } from "@/lib/scene-api";
import { getSceneImage, getSceneImagePublic, sceneClient, SceneTierError } from "@/lib/scene-store";
import { SceneError } from "@/lib/scenes";

export const runtime = "nodejs";

// Scene images can be fetched by `<img>` / CSS `backgroundImage` using the
// unguessable UUID when no Authorization header is attached. When an
// Authorization header is present, enforce per-user tier & ownership checks.
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const thumbnail = new URL(request.url).searchParams.get("thumbnail") === "1";
  if (request.headers.has("authorization")) {
    return sceneApi(request, async (db, userId, tier) => {
      const image = await getSceneImage(db, userId, (await context.params).id, thumbnail, { tier });
      return new Response(image, {
        headers: {
          "Content-Type": image.type,
          "Cache-Control": "private, max-age=0, must-revalidate",
          "X-Content-Type-Options": "nosniff",
          "Content-Disposition": "inline",
          Vary: "Authorization",
        },
      });
    });
  }
  try {
    const image = await getSceneImagePublic(sceneClient(), (await context.params).id, thumbnail);
    return new Response(image, {
      headers: {
        "Content-Type": image.type,
        "Cache-Control": "public, max-age=3600, must-revalidate",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": "inline",
        Vary: "Accept",
      },
    });
  } catch (error) {
    if (error instanceof SceneTierError) {
      return Response.json(
        { error: error.message, status: error.status, code: error.code, requiredTier: error.requiredTier },
        { status: error.status, headers: { "Cache-Control": "private, no-store" } },
      );
    }
    const status = error instanceof SceneError ? error.status : 503;
    return Response.json(
      { error: error instanceof SceneError ? error.message : "Scene image unavailable.", status },
      { status, headers: { "Cache-Control": "private, no-store" } },
    );
  }
}
