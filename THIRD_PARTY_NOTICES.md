# Third-party notices

This project vendors the following third-party runtime files in `vendor/` so the
experience can run locally without a CDN.

## Three.js r169

- Project: https://threejs.org/
- Source: https://github.com/mrdoob/three.js
- License: MIT
- Vendored files: `vendor/three/three.module.js` and the post-processing addons
  (`EffectComposer`, `RenderPass`, `ShaderPass`, `MaskPass`, `UnrealBloomPass`,
  `OutputPass`, and their shader dependencies).

## MediaPipe Hands (legacy solution)

- Project: https://developers.google.com/mediapipe/solutions/vision/hand_landmarker
- Source: https://github.com/google-ai-edge/mediapipe
- npm package: `@mediapipe/hands@0.4.1675469240`
- License: Apache License 2.0
- Vendored files: `hands.js`, `hands.binarypb`, the packed assets loader/data,
  SIMD and non-SIMD WASM binaries, and the full/lite hand landmark models.

## MediaPipe gesture landmark fixtures

The small `.pbtxt` files under `tools/fixtures/` are test fixtures from
`google-ai-edge/mediapipe` (`mediapipe/tasks/testdata/vision`) and are used only
by the local gesture-classifier verification script. They are distributed under
the same Apache License 2.0.

## A note about the license texts

The full license texts are available at:

- MIT: https://github.com/mrdoob/three.js/blob/dev/LICENSE
- Apache 2.0: https://www.apache.org/licenses/LICENSE-2.0

No third-party code is modified except for being copied into `vendor/` for
offline use. This project itself is a private, non-published experiment unless
its author chooses otherwise.
