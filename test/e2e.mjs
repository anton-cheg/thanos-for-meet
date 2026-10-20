// End-to-end test: loads the unpacked extension into Chromium, feeds a fake
// camera, serves a stub page on meet.google.com so the real content scripts
// run, and checks what the page receives from getUserMedia.
//
//   FACE_VIDEO=clip.mp4 npm test   # a short clip of a talking face (needed for tracking checks)
//   DEMO=1 ...                     # also write test/out/demo.gif and popup.png
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'test', 'out');
mkdirSync(out, { recursive: true });
const DEMO = !!process.env.DEMO;
const FACE_VIDEO = process.env.FACE_VIDEO;

let y4m;
if (FACE_VIDEO) {
  y4m = join(out, 'face-camera.y4m');
  execFileSync(
    join(root, 'test', 'make_face_camera.sh'),
    [FACE_VIDEO, y4m, process.env.FACE_START ?? '0', process.env.FACE_DURATION ?? '0.75'],
    { stdio: 'inherit' }
  );
} else {
  y4m = join(out, 'fake-camera.y4m');
  if (!existsSync(y4m)) execFileSync('python3', [join(root, 'test', 'make_fake_camera.py'), y4m], { stdio: 'inherit' });
  console.log('FACE_VIDEO not set: face tracking checks are skipped');
}

const PAGE = `<!doctype html><html><body style="margin:0;background:#000">
<video id="v" autoplay muted playsinline style="width:640px;height:480px;display:block"></video>
<script>
  const v = document.getElementById('v');
  let c, ctx;
  window.start = async () => {
    window.stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    v.srcObject = new MediaStream(stream.getVideoTracks());
    await new Promise((r) => (v.onplaying = r));
    c = new OffscreenCanvas(v.videoWidth, v.videoHeight);
    ctx = c.getContext('2d', { willReadFrequently: true });
    return { label: stream.getVideoTracks()[0].label, w: v.videoWidth, h: v.videoHeight };
  };
  const grab = () => { ctx.drawImage(v, 0, 0); return ctx.getImageData(0, 0, c.width, c.height); };
  // Share of Clawd-orange pixels and their bounding box.
  window.clawd = () => {
    const { data, width, height } = grab();
    let n = 0, x0 = width, y0 = height, x1 = 0, y1 = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      if (Math.abs(data[p] - 215) < 18 && Math.abs(data[p + 1] - 119) < 18 && Math.abs(data[p + 2] - 87) < 18) {
        n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    return { share: n / (width * height), box: [x0, y0, x1, y1] };
  };
  let prev = null;
  // Mean per-pixel change inside a box since the previous call.
  window.motion = (x0, y0, x1, y1) => {
    const { data, width } = grab(); let sum = 0, n = 0;
    if (prev) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const p = (y * width + x) * 4; sum += Math.abs(data[p] - prev[p]) + Math.abs(data[p + 1] - prev[p + 1]); n++;
    }
    prev = data;
    return n ? sum / n : 0;
  };
  window.clawdStatus = () => new Promise((res) => {
    const h = (e) => { if (e.data?.ns === 'clawd-meet' && e.data.dir === 'out' && e.data.type === 'status') { removeEventListener('message', h); res(e.data); } };
    addEventListener('message', h);
    postMessage({ ns: 'clawd-meet', dir: 'in', type: 'status' }, '*');
  });
</script></body></html>`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const step = async (name, fn) => {
  const t = Date.now();
  await fn();
  passed++;
  console.log(`  ✓ ${name} (${Date.now() - t} ms)`);
};

const userDataDir = join(out, 'profile');
rmSync(userDataDir, { recursive: true, force: true });
const context = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chromium',
  headless: !process.env.HEADED,
  viewport: { width: 640, height: 480 },
  args: [
    `--disable-extensions-except=${root}`,
    `--load-extension=${root}`,
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-video-capture=${y4m}`,
    '--autoplay-policy=no-user-gesture-required',
  ],
});

try {
  await context.route('https://meet.google.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: PAGE })
  );
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const extId = sw.url().split('/')[2];

  const page = await context.newPage();
  page.on('console', (m) => ['error', 'warning'].includes(m.type()) && console.log(`    [page ${m.type()}]`, m.text()));
  page.on('pageerror', (e) => console.log('    [pageerror]', e.message));
  await page.goto('https://meet.google.com/abc-defg-hij');

  const toTab = (msg) =>
    sw.evaluate(async (m) => {
      const [t] = await chrome.tabs.query({ url: 'https://meet.google.com/*' });
      return chrome.tabs.sendMessage(t.id, m);
    }, msg);
  const storage = (set) =>
    sw.evaluate((s) => (s ? chrome.storage.local.set(s) : chrome.storage.local.get(null)), set ?? null);
  const status = () => page.evaluate(() => window.clawdStatus());
  const clawd = () => page.evaluate(() => window.clawd());
  const waitFor = async (what, fn, timeout = 30000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await fn()) return;
      await sleep(100);
    }
    throw new Error(`timeout waiting for ${what}`);
  };

  console.log('Clawd for Meet e2e');
  let size;

  await step('getUserMedia is wrapped, camera label preserved', async () => {
    size = await page.evaluate(() => window.start());
    assert.ok(size.label.length > 0, 'label should come from the real camera');
    await waitFor('status.camera', async () => (await status()).camera);
  });

  await step('mascot is on by default and the face tracker loads in its iframe', async () => {
    assert.equal((await status()).mascot, true);
    await waitFor('detector ready', async () => (await status()).detector === 'ready', 60000);
  });

  if (FACE_VIDEO) {
    await step('face is found and Clawd covers it', async () => {
      await waitFor('face', async () => (await status()).face, 15000);
      await sleep(500);
      const { share, box } = await clawd();
      assert.ok(share > 0.08, `Clawd should take a big part of the frame, got ${(share * 100).toFixed(1)}%`);
      const cx = (box[0] + box[2]) / 2;
      assert.ok(Math.abs(cx - size.w / 2) < size.w * 0.15, `Clawd should be centered on the face, box=${box}`);
    });

    await step('mouth moves while talking', async () => {
      let lo = 1;
      let hi = 0;
      for (let i = 0; i < 40; i++) {
        const { mouth } = await status();
        lo = Math.min(lo, mouth);
        hi = Math.max(hi, mouth);
        await sleep(75);
      }
      assert.ok(hi > 0.25 && hi - lo > 0.15, `mouth should open and close, range ${lo.toFixed(2)}..${hi.toFixed(2)}`);
    });
  }

  const frames = [];
  if (DEMO) {
    for (let i = 0; i < 40; i++) {
      frames.push(await page.screenshot({ type: 'png' }));
      await sleep(70);
    }
  }

  await step('mascot off: camera passes through untouched', async () => {
    await storage({ mascot: false });
    await waitFor('mascot off', async () => !(await status()).mascot, 3000);
    await sleep(300);
    const { share } = await clawd();
    assert.ok(share < 0.01, `no Clawd expected, got ${(share * 100).toFixed(1)}%`);
  });

  await step('capture room → saved, background becomes the still snapshot', async () => {
    await toTab({ cmd: 'capture', delay: 0 });
    await waitFor('room in storage', async () => !!(await storage()).room, 5000);
    assert.match((await storage()).room, /^data:image\/jpeg;base64,/);
    assert.equal((await status()).hasRoom, true);
    await storage({ mascot: true });
    await waitFor('mascot on', async () => (await status()).mascot, 3000);
    await sleep(500);
    // Bottom-left corner is outside Clawd: the image there must stop changing.
    const corner = [0, size.h - 60, 120, size.h];
    await page.evaluate((b) => window.motion(...b), corner);
    await sleep(400);
    const m = await page.evaluate((b) => window.motion(...b), corner);
    assert.ok(m < 1, `background should be still, motion=${m.toFixed(2)}`);
  });

  if (DEMO) {
    const dir = join(out, 'frames');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir);
    frames.forEach((f, i) => writeFileSync(join(dir, `${String(i).padStart(3, '0')}.png`), f));
    execFileSync('ffmpeg', [
      '-v', 'error', '-y', '-framerate', '12', '-i', join(dir, '%03d.png'),
      '-vf', 'scale=480:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer',
      join(out, 'demo.gif'),
    ]);

    // Popup, pretending the Meet tab is the active one.
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 340, height: 300 });
    await popup.addInitScript(() => {
      const q = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = () => q({ url: 'https://meet.google.com/*' });
    });
    await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
    await popup.waitForFunction(() => document.getElementById('pill').textContent !== '…');
    await popup.screenshot({ path: join(out, 'popup.png'), fullPage: true });
    await popup.close();
  }

  await step('stopping the wrapped track stops the camera', async () => {
    await page.evaluate(() => window.stream.getVideoTracks()[0].stop());
    await waitFor('camera off', async () => !(await status()).camera, 5000);
  });

  console.log(`\n${passed} passed`);
} finally {
  await context.close();
}
