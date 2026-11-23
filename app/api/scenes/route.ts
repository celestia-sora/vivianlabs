import { sceneApi } from "@/lib/scene-api";
import { getSceneLibrary, saveScene, SceneTierError } from "@/lib/scene-store";
import { normalizeSceneImage, readSceneInput } from "@/lib/scene-images";

export const runtime = "nodejs";

export async function GET(request: Request) {
  return sceneApi(request, async (db, userId, tier) => {
    const library = await getSceneLibrary(db, userId, { tier });
    return Response.json({ ...library, tier, cloudAllowed: tier !== "free" });
  });
}

export async function POST(request: Request) {
  return sceneApi(request, async (db, userId, tier) => {
    if (tier === "free") {
      throw new SceneTierError("Private cloud scenes require the Selected tier or higher.");
    }
    const input = await readSceneInput(request);
    const image = input.bytes && input.mime ? await normalizeSceneImage(input.bytes, input.mime) : {};
    return Response.json({ scene: await saveScene(db, userId, { ...input, ...image }, undefined, { tier }) }, { status: 201 });
  });
}
