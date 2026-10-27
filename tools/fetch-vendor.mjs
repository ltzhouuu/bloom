/**
 * Vendors the runtime dependencies so the experience also works offline.
 * Run from the project root: `node tools/fetch-vendor.mjs`
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const THREE_VERSION = '0.169.0';
const HANDS_VERSION = '0.4.1675469240';

const files = [
  // Three.js core + the few post-processing addons used by the bloom pass.
  [`https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}/build/three.module.js`, 'vendor/three/three.module.js'],
  [`https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}/examples/jsm/postprocessing/EffectComposer.js`, 'vendor/three/addons/postprocessing/EffectComposer.js'],
  [`https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}/examples/jsm/postprocessing/Pass.js`, 'vendor/three/addons/postprocessing/Pass.js'],
  [`https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}/examples/jsm/postprocessing/RenderPass.js`, 'vendor/three/addons/postprocessing/RenderPass.js'],
  [`https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}/examples/jsm/postprocessing/ShaderPass.js`, 'vendor/three/addons/postprocessing/ShaderPass.js'],
  [`https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}/examples/jsm/postprocessing/MaskPass.js`, 'vendor/three/addons/postprocessing/MaskPass.js'],
  [`https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}/examples/jsm/postprocessing/UnrealBloomPass.js`, 'vendor/three/addons/postprocessing/UnrealBloomPass.js'],
  [`https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}/examples/jsm/postprocessing/OutputPass.js`, 'vendor/three/addons/postprocessing/OutputPass.js'],
  [`https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}/examples/jsm/shaders/CopyShader.js`, 'vendor/three/addons/shaders/CopyShader.js'],
  [`https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}/examples/jsm/shaders/LuminosityHighPassShader.js`, 'vendor/three/addons/shaders/LuminosityHighPassShader.js'],
  [`https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}/examples/jsm/shaders/OutputShader.js`, 'vendor/three/addons/shaders/OutputShader.js'],

  // MediaPipe Hands (legacy solution API, exposes the 21 landmarks directly).
  [`https://cdn.jsdelivr.net/npm/@mediapipe/hands@${HANDS_VERSION}/hands.js`, 'vendor/mediapipe/hands.js'],
  [`https://cdn.jsdelivr.net/npm/@mediapipe/hands@${HANDS_VERSION}/hands.binarypb`, 'vendor/mediapipe/hands.binarypb'],
  [`https://cdn.jsdelivr.net/npm/@mediapipe/hands@${HANDS_VERSION}/hands_solution_packed_assets.data`, 'vendor/mediapipe/hands_solution_packed_assets.data'],
  [`https://cdn.jsdelivr.net/npm/@mediapipe/hands@${HANDS_VERSION}/hands_solution_packed_assets_loader.js`, 'vendor/mediapipe/hands_solution_packed_assets_loader.js'],
  [`https://cdn.jsdelivr.net/npm/@mediapipe/hands@${HANDS_VERSION}/hands_solution_simd_wasm_bin.js`, 'vendor/mediapipe/hands_solution_simd_wasm_bin.js'],
  [`https://cdn.jsdelivr.net/npm/@mediapipe/hands@${HANDS_VERSION}/hands_solution_simd_wasm_bin.wasm`, 'vendor/mediapipe/hands_solution_simd_wasm_bin.wasm'],
  [`https://cdn.jsdelivr.net/npm/@mediapipe/hands@${HANDS_VERSION}/hands_solution_wasm_bin.js`, 'vendor/mediapipe/hands_solution_wasm_bin.js'],
  [`https://cdn.jsdelivr.net/npm/@mediapipe/hands@${HANDS_VERSION}/hands_solution_wasm_bin.wasm`, 'vendor/mediapipe/hands_solution_wasm_bin.wasm'],
  [`https://cdn.jsdelivr.net/npm/@mediapipe/hands@${HANDS_VERSION}/hand_landmark_full.tflite`, 'vendor/mediapipe/hand_landmark_full.tflite'],
  [`https://cdn.jsdelivr.net/npm/@mediapipe/hands@${HANDS_VERSION}/hand_landmark_lite.tflite`, 'vendor/mediapipe/hand_landmark_lite.tflite'],
];

async function fetchWithRetry(url, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(90_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 600 * attempt));
      }
    }
  }
  throw lastError;
}

for (const [url, relativePath] of files) {
  const target = join(ROOT, relativePath);
  const bytes = await fetchWithRetry(url);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
  console.log(`${(bytes.length / 1024).toFixed(0).padStart(6)} KB  ${relativePath}`);
}

console.log('Vendor files are ready.');
