// Face tracking, isolated in an extension-origin iframe embedded into Meet:
// the page's CSP/Trusted Types never touch MediaPipe. inject.js talks to us
// over a MessagePort and sends downscaled ImageBitmaps.
import { FaceLandmarker, FilesetResolver } from '../vendor/vision_bundle.mjs';

// Eye corners; 33/133 is the eye on the image's left side, 362/263 on its right.
const LEFT_EYE = [33, 133];
const RIGHT_EYE = [362, 263];

const create = async (delegate) => {
  const fileset = await FilesetResolver.forVisionTasks(new URL('../vendor/wasm', location.href).href);
  return FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: new URL('../vendor/face_landmarker.task', location.href).href, delegate },
    runningMode: 'VIDEO',
    numFaces: 1,
    outputFaceBlendshapes: true,
  });
};

const landmarkerReady = create('GPU').catch((e) => {
  console.warn('[clawd] GPU delegate failed, falling back to CPU', e);
  return create('CPU');
});

let lastTs = 0;

function summarize(res, w, h) {
  const lm = res.faceLandmarks?.[0];
  if (!lm) return null;
  let x0 = 1;
  let y0 = 1;
  let x1 = 0;
  let y1 = 0;
  for (const p of lm) {
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.y > y1) y1 = p.y;
  }
  const mid = (ids) => ({
    x: (lm[ids[0]].x + lm[ids[1]].x) / 2,
    y: (lm[ids[0]].y + lm[ids[1]].y) / 2,
  });
  const l = mid(LEFT_EYE);
  const r = mid(RIGHT_EYE);
  const shapes = {};
  for (const c of res.faceBlendshapes?.[0]?.categories ?? []) shapes[c.categoryName] = c.score;
  return {
    x0,
    y0,
    x1,
    y1,
    eyeX: (l.x + r.x) / 2,
    eyeY: (l.y + r.y) / 2,
    // angle of the eye line in image space, 0 = level
    roll: Math.atan2((r.y - l.y) * h, (r.x - l.x) * w),
    jaw: shapes.jawOpen ?? 0,
    blinkL: shapes.eyeBlinkLeft ?? 0,
    blinkR: shapes.eyeBlinkRight ?? 0,
  };
}

window.addEventListener('message', async (e) => {
  if (e.origin !== 'https://meet.google.com' || e.data?.type !== 'clawd-port' || !e.ports[0]) return;
  const port = e.ports[0];
  const landmarker = await landmarkerReady;
  port.onmessage = ({ data }) => {
    const { bitmap, w, h } = data;
    let face = null;
    try {
      lastTs = Math.max(lastTs + 1, performance.now());
      face = summarize(landmarker.detectForVideo(bitmap, lastTs), w, h);
    } catch (err) {
      console.error('[clawd] detect failed', err);
    } finally {
      bitmap.close();
    }
    port.postMessage({ type: 'face', face });
  };
  port.postMessage({ type: 'ready' });
});
