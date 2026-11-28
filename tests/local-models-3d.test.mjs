import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { test } from "node:test";
import { zipSync } from "fflate";
import {
  inspectPackage,
  importModelFiles,
  createModelResources,
  saveModelPackage,
  loadModelCatalog,
  loadModelPackage,
  loadModelPackages,
  removeModelPackage,
  hydrateModelPackage,
  modelCatalogEntry,
  normalizePath,
} from "../lib/local-models-3d.ts";

/** Build a valid minimal GLB 2.0 VRM binary buffer with optional JSON extensions and thumbnail bytes. */
function makeVrmBytes(gltfJson, binBytes = new Uint8Array(0)) {
  const enc = new TextEncoder();
  const rawJson = enc.encode(JSON.stringify(gltfJson));
  const jsonPad = (4 - (rawJson.byteLength % 4)) % 4;
  const jsonChunkLen = rawJson.byteLength + jsonPad;

  const binPad = (4 - (binBytes.byteLength % 4)) % 4;
  const binChunkLen = binBytes.byteLength > 0 ? binBytes.byteLength + binPad : 0;

  const totalLen = 12 + 8 + jsonChunkLen + (binChunkLen ? 8 + binChunkLen : 0);
  const out = new Uint8Array(totalLen);
  const view = new DataView(out.buffer);

  view.setUint32(0, 0x46546c67, true); // "glTF"
  view.setUint32(4, 2, true);
  view.setUint32(8, totalLen, true);

  view.setUint32(12, jsonChunkLen, true);
  view.setUint32(16, 0x4e4f534a, true); // "JSON"
  out.set(rawJson, 20);
  for (let i = 0; i < jsonPad; i++) out[20 + rawJson.byteLength + i] = 0x20;

  if (binChunkLen) {
    const binOffset = 20 + jsonChunkLen;
    view.setUint32(binOffset, binChunkLen, true);
    view.setUint32(binOffset + 4, 0x004e4942, true); // "BIN\0"
    out.set(binBytes, binOffset + 8);
  }
  return out;
}

function makeFbxBytes(label = "sample") {
  const enc = new TextEncoder();
  return enc.encode(`Kaydara FBX Binary  \0\x1a\x00${label}`);
}

test("inspectPackage parses VRM 1.0 metadata, filters system visemes/blinks, and extracts embedded thumbnail", async () => {
  const thumb = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
  const vrm = makeVrmBytes({
    asset: { version: "2.0" },
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: thumb.byteLength }],
    images: [{ bufferView: 0, mimeType: "image/png" }],
    extensions: {
      VRMC_vrm: {
        specVersion: "1.0",
        meta: { name: "Vivian 3D", thumbnailImage: 0 },
        expressions: {
          preset: { happy: {}, angry: {}, sad: {}, aa: {}, blink: {}, lookUp: {} },
          custom: { blush: {}, wink: {} },
        },
      },
    },
  }, thumb);

  const pack = await inspectPackage([{ path: "vivian.vrm", blob: new Blob([vrm]) }], "pack-vrm-1");
  assert.equal(pack.models.length, 1);
  assert.equal(pack.models[0].name, "Vivian 3D");
  assert.equal(pack.models[0].format, "vrm");
  assert.deepEqual(pack.models[0].expressions, ["happy", "angry", "sad", "blush", "wink"]);
  assert.ok(pack.models[0].previewPath, "embedded VRM thumbnail should produce a synthetic preview asset");
  assert.ok(pack.assets.some((a) => a.path === pack.models[0].previewPath));
});

test("inspectPackage attaches companion FBX and VRMA motions to a VRM avatar and excludes UV textures from preview", async () => {
  const vrm = makeVrmBytes({
    asset: { version: "2.0" },
    extensions: { VRMC_vrm: { specVersion: "1.0", meta: { name: "Vivian" }, expressions: { preset: { happy: {} } } } },
  });
  const vrma = makeVrmBytes({
    asset: { version: "2.0" },
    extensions: { VRMC_vrm_animation: { specVersion: "1.0" } },
  });
  const pack = await inspectPackage([
    { path: "avatar/vivian.vrm", blob: new Blob([vrm]) },
    { path: "avatar/textures/Hair_Tex.png", blob: new Blob([new Uint8Array([1, 2, 3])]) },
    { path: "avatar/motions/Wave.fbx", blob: new Blob([makeFbxBytes("wave")]) },
    { path: "avatar/motions/Idle.fbx", blob: new Blob([makeFbxBytes("idle")]) },
    { path: "avatar/vrma/Dance.vrma", blob: new Blob([vrma]) },
  ], "pack-vrm-motions");

  assert.equal(pack.models.length, 1);
  assert.equal(pack.models[0].format, "vrm");
  assert.equal(pack.models[0].previewPath, undefined, "UV textures must never be chosen as preview card");
  assert.equal(pack.models[0].motions.length, 3);
  assert.deepEqual(pack.models[0].motions.map((m) => m.name), ["Wave", "Idle", "Dance"]);
});

test("importModelFiles automatically unwraps Sketchfab-style nested ZIPs and ignores .blend/.pmx source files", async () => {
  const innerZip = zipSync({
    "Character.fbx": makeFbxBytes("char"),
    "Character.blend": new Uint8Array([0x42, 0x4c, 0x45, 0x4e, 0x44, 0x45, 0x52]),
    "textures/Face_Tex.png": new Uint8Array([1, 2, 3, 4]),
  });
  const outerZip = zipSync({
    "source/Character_Bundle.zip": innerZip,
    "textures/Hair_Tex.png": new Uint8Array([5, 6, 7, 8]),
  });
  const file = new File([outerZip], "sketchfab-dl.zip", { type: "application/zip" });
  const pack = await importModelFiles([file]);

  assert.equal(pack.models.length, 1);
  assert.equal(pack.models[0].format, "fbx");
  assert.equal(pack.models[0].name, "Character");
  assert.equal(pack.models[0].previewPath, undefined);
  assert.ok(!pack.assets.some((a) => a.path.endsWith(".blend")), "non-runtime .blend files should be excluded");
  assert.ok(pack.assets.some((a) => a.path.endsWith("Face_Tex.png")));
  assert.ok(pack.assets.some((a) => a.path.endsWith("Hair_Tex.png")));
});

test("createModelResources resolves relative, Windows-absolute, and basename FBX texture paths locally and revokes URLs on dispose", async () => {
  const pack = await inspectPackage([
    { path: "source/Hero.fbx", blob: new Blob([makeFbxBytes("hero")]) },
    { path: "textures/Face_Tex.png", blob: new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }) },
  ], "pack-fbx-res");

  const resources = await createModelResources(pack, pack.models[0]);
  try {
    assert.ok(resources.entryUrl.startsWith("blob:"));
    const winResolved = resources.resolveAssetUrl("C:\\Users\\artist\\Desktop\\Face_Tex.png");
    assert.ok(winResolved && winResolved.startsWith("blob:"), "Windows texture path should resolve by basename inside package");
    const blobBaseResolved = resources.resolveAssetUrl("blob:http://127.0.0.1:3102/Face_Tex.png");
    assert.equal(blobBaseResolved, winResolved, "blob:-prefixed relative FBX texture URLs must resolve to the package asset Blob URL");
    const extBlocked = resources.resolveAssetUrl("https://evil.example.com/unlisted.png");
    assert.equal(extBlocked, null, "external URLs not matching package assets must be blocked");
  } finally {
    resources.dispose();
  }
});

test("IndexedDB v2 catalog/packages save, hydrate, and remove work cleanly and reject saving catalog-only entries", async () => {
  const fbxPack = await inspectPackage([{ path: "vivian.fbx", blob: new Blob([makeFbxBytes("idb")]) }], "idb-test-pack");
  await saveModelPackage(fbxPack);

  const catalog = await loadModelCatalog();
  const entry = catalog.find((item) => item.id === "idb-test-pack");
  assert.ok(entry);
  assert.equal(entry.assets.length, 0, "catalog entry must omit heavy blobs");

  await assert.rejects(saveModelPackage(modelCatalogEntry(fbxPack)), /without its original model files/);

  const hydrated = await hydrateModelPackage(entry);
  assert.ok(hydrated);
  assert.equal(hydrated.assets.length, 1);

  const loaded = await loadModelPackage("idb-test-pack");
  assert.ok(loaded);
  assert.equal(loaded.models[0].format, "fbx");

  const all = await loadModelPackages();
  assert.ok(all.some((item) => item.id === "idb-test-pack"));

  await removeModelPackage("idb-test-pack");
  assert.equal(await loadModelPackage("idb-test-pack"), undefined);
});

test("inspectPackage deduplicates duplicate Sketchfab texture paths keeping the larger file, and findTextureForMaterial binds unmapped Blender materials", async () => {
  const pack = await inspectPackage([
    { path: "source/SummerWhiteDress_GYRemix_FL.fbx", blob: new Blob([makeFbxBytes("elaina")]) },
    { path: "textures/SummerWhiteDress_GYRemix_09_SP_WhiteDress_.png", blob: new Blob([new Uint8Array(12)], { type: "image/png" }) },
    { path: "textures/SummerWhiteDress_GYRemix_09_SP_WhiteDress_.png", blob: new Blob([new Uint8Array(48)], { type: "image/png" }) },
    { path: "textures/SummerWhiteDress_GYRemix_09_SP_Body_BaseCo.png", blob: new Blob([new Uint8Array(24)], { type: "image/png" }) },
    { path: "textures/SummerWhiteDress_GYRemix_09_SP_Body_Normal.png", blob: new Blob([new Uint8Array(24)], { type: "image/png" }) },
    { path: "textures/SummerWhiteDress_GYRemix_09_SP_Eye_BaseCol.png", blob: new Blob([new Uint8Array(20)], { type: "image/png" }) },
    { path: "textures/SummerWhiteDress_GYRemix_09_SP_Eyebrow_Bas.png", blob: new Blob([new Uint8Array(20)], { type: "image/png" }) },
    { path: "textures/SummerWhiteDress_GYRemix_09_SP_Overcoat_F_.png", blob: new Blob([new Uint8Array(20)], { type: "image/png" }) },
    { path: "textures/SummerWhiteDress_GYRemix_09_SP_Overcoat_B_.png", blob: new Blob([new Uint8Array(20)], { type: "image/png" }) },
  ], "pack-elaina-unit");

  const dressAsset = pack.assets.find((a) => a.path.endsWith("WhiteDress_.png"));
  assert.ok(dressAsset);
  assert.equal(dressAsset.blob.size, 48, "duplicate truncated texture entry should retain the larger file");

  const resources = await createModelResources(pack, pack.models[0]);
  try {
    // Prefix resolution for Sketchfab-truncated texture names
    const truncatedResolved = resources.resolveAssetUrl("SummerWhiteDress_GYRemix_09_SP_Body_BaseColor.png");
    assert.ok(truncatedResolved && truncatedResolved.startsWith("blob:"));

    // Material-name binding distinguishes Eye vs Eyebrow, Overcoat_F vs Overcoat_B, and prefers BaseColor over Normal
    const bodyUrl = resources.findTextureForMaterial("Body");
    const eyeUrl = resources.findTextureForMaterial("Eye");
    const eyebrowUrl = resources.findTextureForMaterial("Eyebrow");
    const overF = resources.findTextureForMaterial("Overcoat_F");
    const overB = resources.findTextureForMaterial("Overcoat_B");
    const dressF = resources.findTextureForMaterial("WhiteDress_F");
    const dressB = resources.findTextureForMaterial("WhiteDress_B");

    assert.equal(bodyUrl, truncatedResolved, "Body should bind to BaseCo rather than Normal");
    assert.ok(eyeUrl && eyebrowUrl && eyeUrl !== eyebrowUrl, "Eye and Eyebrow must bind to separate textures");
    assert.ok(overF && overB && overF !== overB, "Overcoat_F and Overcoat_B must bind to their respective front/back textures");
    assert.ok(dressF && dressF === dressB, "WhiteDress_F and WhiteDress_B should fall back to shared truncated WhiteDress_ texture");
    assert.equal(resources.findTextureForMaterial("__DEFAULT"), null);
  } finally {
    resources.dispose();
  }
});

test("normalizePath blocks traversal and absolute schemes", () => {
  assert.equal(normalizePath("a/b/../c.vrm"), "a/c.vrm");
  assert.throws(() => normalizePath("../escape.vrm"));
  assert.throws(() => normalizePath("https://example.com/a.vrm"));
  assert.throws(() => normalizePath("/etc/passwd"));
});
