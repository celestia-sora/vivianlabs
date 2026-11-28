/**
 * Dynamic preloader for the 3D VRM & FBX runtime (Three.js + GLTFLoader +
 * FBXLoader + @pixiv/three-vrm). Call as soon as the companion mounts so
 * module downloads overlap IndexedDB catalog and cloud loading.
 */

export interface ThreeAvatarModules {
  THREE: typeof import("three");
  GLTFLoader: (typeof import("three/examples/jsm/loaders/GLTFLoader.js"))["GLTFLoader"];
  FBXLoader: (typeof import("three/examples/jsm/loaders/FBXLoader.js"))["FBXLoader"];
  RoomEnvironment: (typeof import("three/examples/jsm/environments/RoomEnvironment.js"))["RoomEnvironment"];
  VRM: typeof import("@pixiv/three-vrm");
  VRMAnimation: typeof import("@pixiv/three-vrm-animation");
}

let modulesPromise: Promise<ThreeAvatarModules> | null = null;

export function preloadThreeModules(): Promise<ThreeAvatarModules> {
  if (!modulesPromise) {
    modulesPromise = Promise.all([
      import("three"),
      import("three/examples/jsm/loaders/GLTFLoader.js"),
      import("./fast-fbx-loader.js"),
      import("three/examples/jsm/environments/RoomEnvironment.js"),
      import("@pixiv/three-vrm"),
      import("@pixiv/three-vrm-animation"),
    ]).then(([THREE, gltfMod, fbxMod, envMod, VRM, VRMAnimation]) => ({
      THREE,
      GLTFLoader: gltfMod.GLTFLoader,
      FBXLoader: fbxMod.FBXLoader,
      RoomEnvironment: envMod.RoomEnvironment,
      VRM,
      VRMAnimation,
    }));
    modulesPromise.catch(() => {
      modulesPromise = null;
    });
  }
  return modulesPromise;
}

/** Reset cached module promise (used in tests). */
export function resetThreeModulesCache(): void {
  modulesPromise = null;
}
