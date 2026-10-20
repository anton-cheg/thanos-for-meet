// Runs in the page's MAIN world at document_start. Wraps getUserMedia so every
// camera track goes through our frame pipeline before Meet sees it: your face
// is tracked and you are replaced by Clawd, the Claude Code mascot.
(() => {
  if (window.__clawdMeet) return;
  window.__clawdMeet = true;

  const NS = 'clawd-meet';
  const md = navigator.mediaDevices;
  if (!md || !md.getUserMedia || !window.MediaStreamTrackProcessor || !window.MediaStreamTrackGenerator) {
    console.warn('[clawd] insertable streams are not supported, extension disabled');
    return;
  }

  const DETECT_WIDTH = 256;
  const DETECT_EVERY_MS = 50;
  const FACE_HOLD_MS = 1500; // keep the mascot where the face was last seen
  const FOLLOW = 0.35; // per-frame smoothing toward the latest detection
  const CLAWD_COLOR = '#d77757';
  const INK = '#1b1310';
  const MOUTH_COLOR = '#3a1a14';

  const state = {
    room: null, // ImageBitmap of the empty room
    mascot: false,
  };
  const pipes = new Set();

  const post = (msg) => window.postMessage({ ns: NS, dir: 'out', ...msg }, '*');

  // ---------- face tracking (detector lives in an extension iframe) ----------

  const tracker = {
    port: null,
    ready: false,
    busy: false,
    lastReq: 0,
    target: null, // latest detection, normalized coords
    seenAt: 0,
    cur: null, // smoothed pose actually drawn
  };

  const setDetectorPort = (port) => {
    tracker.port?.close();
    tracker.port = port;
    tracker.ready = false;
    tracker.busy = false;
    port.onmessage = ({ data }) => {
      if (data.type === 'ready') {
        tracker.ready = true;
        sendStatus();
      } else if (data.type === 'face') {
        tracker.busy = false;
        const hadFace = !!tracker.target;
        if (data.face) {
          tracker.target = data.face;
          tracker.seenAt = performance.now();
        } else if (performance.now() - tracker.seenAt > FACE_HOLD_MS) {
          tracker.target = null;
        }
        if (hadFace !== !!tracker.target) sendStatus();
      }
    };
  };

  const requestDetection = (frame, w, h) => {
    const now = performance.now();
    if (!tracker.ready || tracker.busy || now - tracker.lastReq < DETECT_EVERY_MS) return;
    tracker.busy = true;
    tracker.lastReq = now;
    const copy = frame.clone();
    createImageBitmap(copy, { resizeWidth: DETECT_WIDTH, resizeHeight: Math.round((DETECT_WIDTH * h) / w) })
      .then((bitmap) => tracker.port.postMessage({ bitmap, w, h }, [bitmap]))
      .catch(() => (tracker.busy = false))
      .finally(() => copy.close());
  };

  // ---------- microphone level, so the mouth moves when you talk ----------

  const voice = { analyser: null, buf: null, level: 0 };

  const tapAudio = (track) => {
    try {
      const ctx = (voice.ctx ??= new AudioContext());
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      ctx.createMediaStreamSource(new MediaStream([track])).connect(analyser);
      voice.analyser = analyser;
      voice.buf = new Float32Array(analyser.fftSize);
      if (ctx.state === 'suspended') {
        const resume = () => ctx.resume();
        window.addEventListener('pointerdown', resume, { once: true, capture: true });
        window.addEventListener('keydown', resume, { once: true, capture: true });
      }
    } catch (e) {
      console.warn('[clawd] cannot tap microphone', e);
    }
  };

  const voiceLevel = () => {
    if (!voice.analyser) return 0;
    voice.analyser.getFloatTimeDomainData(voice.buf);
    let sum = 0;
    for (const v of voice.buf) sum += v * v;
    const rms = Math.sqrt(sum / voice.buf.length);
    return Math.min(1, Math.max(0, (rms - 0.012) * 12));
  };

  // ---------- Clawd ----------

  // Pixel grid derived from the Claude Code logo (▐▛███▜▌ / ▝▜█████▛▘ / ▘▘ ▝▝)
  // at 2x, with a taller body so it covers a torso. 36 cells wide.
  const GRID_W = 36;
  const BODY_ROWS = [];
  for (let y = 0; y < 4; y++) BODY_ROWS.push([y, 6, 30]); // head
  for (let y = 4; y < 6; y++) BODY_ROWS.push([y, 2, 34]); // arms
  for (let y = 6; y < 14; y++) BODY_ROWS.push([y, 6, 30]); // belly
  const LEGS = [8, 12, 22, 26].map((x) => [14, x, x + 2, 2]);
  const EYES = [10, 24];
  const EYE_ROW = 2.5; // center row of Clawd's eyes
  // Clawd's eyes sit near the top of its head, so lift it above the real eyes
  // far enough to also cover the forehead and hair.
  const EYE_LIFT = 3.5;
  const BODY_CELLS = 24; // head width in cells, matched to shoulder width
  const SHOULDERS_PER_FACE = 3.1;

  function drawClawd(ctx, cx, cy, cell, roll, mouth, blinkL, blinkR) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(roll);
    ctx.scale(cell, cell);
    ctx.translate(-GRID_W / 2, -EYE_ROW - EYE_LIFT);

    ctx.fillStyle = CLAWD_COLOR;
    ctx.beginPath();
    for (const [y, x0, x1] of BODY_ROWS) ctx.rect(x0, y, x1 - x0, 1.02);
    for (const [y, x0, x1, hgt] of LEGS) ctx.rect(x0, y, x1 - x0, hgt);
    ctx.fill();

    // Eyes: tall slits that close when you blink. The image is not mirrored,
    // so the left eye on screen is the subject's right one.
    ctx.fillStyle = INK;
    [blinkR, blinkL].forEach((blink, i) => {
      const hgt = Math.max(0.35, 3 * (1 - Math.min(1, blink * 1.3)));
      ctx.fillRect(EYES[i], EYE_ROW - hgt / 2, 2, hgt);
    });

    if (mouth > 0.06) {
      const hgt = 0.5 + mouth * 3.5;
      const wid = 4 + mouth * 2;
      ctx.fillStyle = MOUTH_COLOR;
      ctx.fillRect(GRID_W / 2 - wid / 2, 5, wid, hgt);
    }
    ctx.restore();
  }

  // ---------- per-track pipeline ----------

  class Pipe {
    constructor(src) {
      this.src = src;
      this.gen = new MediaStreamTrackGenerator({ kind: 'video' });
      this.reader = new MediaStreamTrackProcessor({ track: src }).readable.getReader();
      this.writer = this.gen.writable.getWriter();
      this.canvas = null;
      this.ctx = null;
      this.mouth = 0;
      this.captureReq = null;
      this.patchTrack();
      pipes.add(this);
      this.loop();
    }

    // Make the generated track look and behave like the real camera track.
    patchTrack() {
      const { gen, src } = this;
      const genStop = gen.stop.bind(gen);
      gen.stop = () => {
        genStop();
        src.stop();
      };
      for (const m of ['getSettings', 'getCapabilities', 'getConstraints', 'applyConstraints']) {
        if (src[m]) gen[m] = src[m].bind(src);
      }
      Object.defineProperty(gen, 'label', { get: () => src.label });
      src.addEventListener('ended', () => genStop());
    }

    async loop() {
      try {
        for (;;) {
          const { value: frame, done } = await this.reader.read();
          if (done) break;
          let out = frame;
          try {
            out = this.process(frame);
          } catch (e) {
            console.error('[clawd] frame error', e);
          }
          if (out !== frame) frame.close();
          await this.writer.write(out);
        }
      } catch (e) {
        if (this.src.readyState === 'live') console.error('[clawd] pipeline stopped', e);
      } finally {
        pipes.delete(this);
        sendStatus();
      }
    }

    process(frame) {
      const w = frame.displayWidth;
      const h = frame.displayHeight;
      if (this.captureReq) this.feedCapture(frame, w, h);
      if (!state.mascot) return frame; // passthrough, zero cost

      requestDetection(frame, w, h);

      if (!this.canvas || this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas = new OffscreenCanvas(w, h);
        this.ctx = this.canvas.getContext('2d');
      }
      const ctx = this.ctx;
      // With a snapshot of the empty room the real body disappears completely.
      ctx.drawImage(state.room ?? frame, 0, 0, w, h);

      const t = tracker.target;
      if (t) {
        const faceW = (t.x1 - t.x0) * w;
        const target = { x: t.eyeX * w, y: t.eyeY * h, size: faceW, roll: t.roll };
        const c = (tracker.cur ??= target);
        c.x += (target.x - c.x) * FOLLOW;
        c.y += (target.y - c.y) * FOLLOW;
        c.size += (target.size - c.size) * FOLLOW;
        c.roll += (target.roll - c.roll) * FOLLOW;

        // Fast attack, slower release, so speech reads as chatter, not flicker.
        const want = Math.min(1, Math.max(t.jaw * 1.8, voiceLevel()));
        this.mouth += (want - this.mouth) * (want > this.mouth ? 0.6 : 0.25);

        const cell = (c.size * SHOULDERS_PER_FACE) / BODY_CELLS;
        drawClawd(ctx, c.x, c.y, cell, c.roll, this.mouth, t.blinkL, t.blinkR);
      } else {
        tracker.cur = null;
      }
      return new VideoFrame(this.canvas, { timestamp: frame.timestamp, duration: frame.duration ?? undefined });
    }

    // ---- room capture: average a few frames to kill sensor noise ----

    feedCapture(frame, w, h) {
      const req = this.captureReq;
      if (!req.acc || req.w !== w || req.h !== h) {
        req.w = w;
        req.h = h;
        req.acc = new Float32Array(w * h * 4);
        req.got = 0;
        req.c = new OffscreenCanvas(w, h);
        req.ctx = req.c.getContext('2d', { willReadFrequently: true });
      }
      req.ctx.drawImage(frame, 0, 0, w, h);
      const d = req.ctx.getImageData(0, 0, w, h).data;
      const acc = req.acc;
      for (let i = 0; i < d.length; i++) acc[i] += d[i];
      if (++req.got < req.frames) return;

      const img = req.ctx.createImageData(w, h);
      for (let i = 0; i < acc.length; i++) img.data[i] = acc[i] / req.got;
      req.ctx.putImageData(img, 0, 0);
      this.captureReq = null;
      req.resolve(req.c);
    }
  }

  // ---------- getUserMedia hook ----------

  const realGetUserMedia = md.getUserMedia.bind(md);
  md.getUserMedia = async function getUserMedia(constraints) {
    const stream = await realGetUserMedia(constraints);
    if (constraints?.audio) stream.getAudioTracks().forEach(tapAudio);
    if (!constraints?.video) return stream;
    const tracks = stream.getTracks().map((track) => {
      if (track.kind !== 'video') return track;
      try {
        return new Pipe(track).gen;
      } catch (e) {
        console.error('[clawd] cannot wrap track', e);
        return track;
      }
    });
    sendStatus();
    return new MediaStream(tracks);
  };

  // ---------- status & commands ----------

  const livePipe = () => [...pipes].find((p) => p.src.readyState === 'live');

  function sendStatus() {
    post({
      type: 'status',
      camera: !!livePipe(),
      hasRoom: !!state.room,
      mascot: state.mascot,
      detector: !tracker.port ? 'off' : tracker.ready ? 'ready' : 'loading',
      face: !!tracker.target,
      mouth: livePipe()?.mouth ?? 0,
    });
  }

  const setRoom = async (source) => {
    state.room = source ? await createImageBitmap(source) : null;
    sendStatus();
  };

  const capture = async () => {
    const pipe = livePipe();
    if (!pipe) {
      post({ type: 'error', code: 'no-camera' });
      return;
    }
    const canvas = await new Promise((resolve) => {
      pipe.captureReq = { frames: 8, resolve };
    });
    await setRoom(canvas);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
    const dataUrl = await new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.readAsDataURL(blob);
    });
    post({ type: 'roomCaptured', dataUrl });
  };

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const m = e.data;
    if (!m || m.ns !== NS || m.dir !== 'in') return;
    switch (m.type) {
      case 'setRoom':
        if (m.dataUrl) {
          fetch(m.dataUrl)
            .then((r) => r.blob())
            .then(setRoom)
            .catch((err) => console.error('[clawd] bad room image', err));
        } else setRoom(null);
        break;
      case 'setMascot':
        state.mascot = !!m.value;
        sendStatus();
        break;
      case 'detectorPort':
        if (e.ports[0]) setDetectorPort(e.ports[0]);
        break;
      case 'capture':
        capture();
        break;
      case 'status':
        sendStatus();
        break;
    }
  });
})();
