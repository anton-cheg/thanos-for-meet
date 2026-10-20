// End-to-end test: loads the unpacked extension into Chromium, feeds a fake
// camera (empty room -> person), serves a stub page on meet.google.com so the
// real content scripts run, and checks what the page receives from getUserMedia.
//
//   npm test            # run checks
//   DEMO=1 npm test     # also write test/out/demo.gif and popup.png
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'test', 'out');
mkdirSync(out, { recursive: true });
const y4m = join(out, 'fake-camera.y4m');
if (!existsSync(y4m)) execFileSync('python3', [join(root, 'test', 'make_fake_camera.py'), y4m], { stdio: 'inherit' });
const DEMO = !!process.env.DEMO;

const PAGE = `<!doctype html><html><body style="margin:0;background:#000">
<video id="v" autoplay muted playsinline style="width:960px;height:540px;display:block"></video>
<script>
  const v = document.getElementById('v');
  const c = new OffscreenCanvas(480, 270);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  let room = null;
  window.start = async () => {
    window.stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    v.srcObject = stream;
    await new Promise((r) => (v.onplaying = r));
    return stream.getVideoTracks()[0].label;
  };
  const grab = () => { ctx.drawImage(v, 0, 0, 480, 270); return ctx.getImageData(0, 0, 480, 270).data; };
  window.sample = (x, y) => {
    const d = grab(); const s = [0, 0, 0];
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const p = ((y + dy) * 480 + x + dx) * 4; s[0] += d[p]; s[1] += d[p + 1]; s[2] += d[p + 2];
    }
    return s.map((n) => Math.round(n / 25));
  };
  window.setRoom = async (url) => {
    const img = await createImageBitmap(await (await fetch(url)).blob());
    const rc = new OffscreenCanvas(480, 270).getContext('2d');
    rc.drawImage(img, 0, 0, 480, 270); room = rc.getImageData(0, 0, 480, 270).data;
  };
  // Share of pixels in a box that differ from the captured room.
  window.diff = (x0, y0, x1, y1) => {
    const d = grab(); let n = 0, all = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const p = (y * 480 + x) * 4; all++;
      if (Math.abs(d[p] - room[p]) + Math.abs(d[p + 1] - room[p + 1]) + Math.abs(d[p + 2] - room[p + 2]) > 60) n++;
    }
    return n / all;
  };
</script></body></html>`;

const TORSO = [220, 235];
const FACE = [220, 110];
const TORSO_COLOR = [28, 30, 36];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
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
  viewport: { width: 960, height: 540 },
  args: [
    `--disable-extensions-except=${root}`,
    `--load-extension=${root}`,
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-video-capture=${y4m}`,
  ],
});

try {
  await context.route('https://meet.google.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: PAGE })
  );
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const extId = sw.url().split('/')[2];

  const page = await context.newPage();
  page.on('console', (m) => m.type() === 'error' && console.log('    [page]', m.text()));
  page.on('pageerror', (e) => console.log('    [pageerror]', e.message));
  await page.goto('https://meet.google.com/abc-defg-hij');

  const toTab = (msg) =>
    sw.evaluate(async (m) => {
      const [t] = await chrome.tabs.query({ url: 'https://meet.google.com/*' });
      return chrome.tabs.sendMessage(t.id, m);
    }, msg);
  const storage = (set) =>
    sw.evaluate((s) => (s ? chrome.storage.local.set(s) : chrome.storage.local.get(null)), set ?? null);
  const sample = (pt) => page.evaluate(([x, y]) => window.sample(x, y), pt);
  const isPerson = async () => dist(await sample(TORSO), TORSO_COLOR) < 45;
  const waitFor = async (what, fn, timeout = 25000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await fn()) return;
      await sleep(60);
    }
    throw new Error(`timeout waiting for ${what}`);
  };

  console.log('Thanos for Meet e2e');

  await step('getUserMedia is wrapped, camera label preserved', async () => {
    const label = await page.evaluate(() => window.start());
    assert.ok(label.length > 0, 'label should come from the real camera');
    await waitFor('status.camera', async () => (await toTab({ cmd: 'getStatus' })).camera);
  });

  await step('passthrough before capture: page sees the real camera', async () => {
    await waitFor('person in frame', isPerson);
    const st = await toTab({ cmd: 'getStatus' });
    assert.equal(st.hasRoom, false);
    assert.equal(st.gone, false);
  });

  await step('toggle without a room is rejected', async () => {
    await toTab({ cmd: 'toggle' });
    await sleep(300);
    assert.equal((await toTab({ cmd: 'getStatus' })).gone, false);
    assert.ok(await isPerson());
  });

  await step('capture empty room → saved to storage', async () => {
    await waitFor('empty room phase', async () => !(await isPerson()), 25000);
    await toTab({ cmd: 'capture', delay: 0 });
    await waitFor('room in storage', async () => !!(await storage()).room, 5000);
    const { room } = await storage();
    assert.match(room, /^data:image\/jpeg;base64,/);
    assert.equal((await toTab({ cmd: 'getStatus' })).hasRoom, true);
    await page.evaluate((u) => window.setRoom(u), room);
  });

  await step('plain vanish: person replaced by the room', async () => {
    await storage({ thanos: false });
    await waitFor('person back in frame', isPerson);
    await sleep(400);
    await toTab({ cmd: 'toggle' });
    await sleep(800);
    assert.equal((await toTab({ cmd: 'getStatus' })).gone, true);
    const d = await page.evaluate(() => window.diff(120, 50, 330, 270));
    assert.ok(d < 0.03, `person area should look like the room, diff=${d.toFixed(3)}`);
  });

  await step('plain appear: person is back', async () => {
    await toTab({ cmd: 'toggle' });
    await sleep(800);
    assert.equal((await toTab({ cmd: 'getStatus' })).gone, false);
    assert.ok(await isPerson());
  });

  const frames = [];
  const shoot = async (n, every) => {
    for (let i = 0; i < n; i++) {
      const t = Date.now();
      frames.push(await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 960, height: 540 } }));
      await sleep(Math.max(0, every - (Date.now() - t)));
    }
  };

  await step('Thanos vanish: dissolves gradually, dust flies, then empty', async () => {
    await storage({ thanos: true });
    await sleep(200);
    const before = await page.evaluate(() => window.diff(120, 50, 330, 270));
    assert.ok(before > 0.4, `person should be visible, diff=${before.toFixed(3)}`);
    await toTab({ cmd: 'toggle' });
    if (DEMO) await shoot(13, 100);
    else await sleep(1300);
    const mid = await page.evaluate(() => window.diff(120, 50, 330, 270));
    const dust = await page.evaluate(() => window.diff(340, 0, 480, 200));
    assert.ok(mid < before * 0.95 && mid > before * 0.05, `mid dissolve should be partial: ${mid.toFixed(3)} of ${before.toFixed(3)}`);
    assert.ok(dust > 0.002, `dust should fly to the right, diff=${dust.toFixed(4)}`);
    if (DEMO) await shoot(22, 100);
    else await sleep(2400);
    const st = await toTab({ cmd: 'getStatus' });
    assert.equal(st.gone, true);
    assert.equal(st.animating, false);
    const after = await page.evaluate(() => window.diff(0, 0, 480, 270));
    assert.ok(after < 0.03, `frame should be the empty room, diff=${after.toFixed(3)}`);
  });

  await step('Thanos appear: dust gathers back into the person', async () => {
    if (DEMO) await shoot(6, 100);
    await toTab({ cmd: 'toggle' });
    // The first ~40% of the appear is dust flying in, the body forms after that.
    if (DEMO) await shoot(16, 100);
    else await sleep(1600);
    const mid = await page.evaluate(() => window.diff(120, 50, 330, 270));
    assert.ok(mid > 0.02 && mid < 0.6, `mid appear should be partial, diff=${mid.toFixed(3)}`);
    if (DEMO) await shoot(14, 100);
    else await sleep(1400);
    assert.equal((await toTab({ cmd: 'getStatus' })).gone, false);
    assert.ok(await isPerson(), 'person should be back');
  });

  if (DEMO) {
    const dir = join(out, 'frames');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir);
    const { writeFileSync } = await import('node:fs');
    frames.forEach((f, i) => writeFileSync(join(dir, `${String(i).padStart(3, '0')}.png`), f));
    execFileSync('ffmpeg', [
      '-v', 'error', '-y', '-framerate', '10', '-i', join(dir, '%03d.png'),
      '-vf', 'scale=640:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer',
      join(out, 'demo.gif'),
    ]);

    // Popup, pretending the Meet tab is the active one.
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 340, height: 330 });
    await popup.addInitScript(() => {
      const q = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = () => q({ url: 'https://meet.google.com/*' });
    });
    await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
    await popup.waitForFunction(() => document.getElementById('pill').textContent === 'камера активна');
    await popup.screenshot({ path: join(out, 'popup.png'), fullPage: true });
    await popup.close();
  }

  await step('stopping the wrapped track stops the camera', async () => {
    await page.evaluate(() => window.stream.getVideoTracks()[0].stop());
    await waitFor('camera off', async () => !(await toTab({ cmd: 'getStatus' })).camera, 5000);
  });

  console.log(`\n${passed} passed`);
} finally {
  await context.close();
}
