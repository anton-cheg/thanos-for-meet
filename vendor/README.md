Third-party files shipped with the extension (MV3 forbids loading remote code):

- `vision_bundle.mjs`, `wasm/vision_wasm_internal.{js,wasm}` — [@mediapipe/tasks-vision](https://www.npmjs.com/package/@mediapipe/tasks-vision) 1.0.1, Apache-2.0.
- `face_landmarker.task` — MediaPipe Face Landmarker model (float16 v1), Apache-2.0,
  from `storage.googleapis.com/mediapipe-models`.

Regenerate with `npm install && npm run vendor`.
