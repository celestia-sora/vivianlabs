import { sceneApi } from "@/lib/scene-api";
import { deleteScene, getScene, saveScene, SceneTierError } from "@/lib/scene-store";
import { normalizeSceneImage, readSceneInput } from "@/lib/scene-images";
export const runtime = "nodejs";
interface Context { params: Promise<{ id: string }> }
export async function PATCH(request: Request, context: Context) {
  return sceneApi(request, async (db, userId, tier) => {
    if (tier === "free") {
      throw new SceneTierError("Private cloud scenes require the Selected tier or higher.");
    }
    const { id } = await context.params;
    await getScene(db, userId, id);
    const input = await readSceneInput(request);
    const image = input.bytes && input.mime ? await normalizeSceneImage(input.bytes, input.mime) : {};
    return Response.json({ scene: await saveScene(db, userId, { ...input, ...image }, id, { tier }) });
  });
}
export async function DELETE(request: Request, context: Context) {
  return sceneApi(request, async (db, userId) => {
    await deleteScene(db, userId, (await context.params).id);
    return Response.json({ deleted: true });
  });
}
