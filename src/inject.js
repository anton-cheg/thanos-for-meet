// Runs in the page's MAIN world at document_start. Wraps getUserMedia so every
// camera track goes through our frame pipeline before the call sees it, and
// mic tracks can be listened to for finger snaps.
(() => {
  if (window.__thanosMeet) return;
  window.__thanosMeet = true;

  const NS = 'thanos-meet';
  const md = navigator.mediaDevices;
  if (!md || !md.getUserMedia || !window.MediaStreamTrackProcessor || !window.MediaStreamTrackGenerator) {
    console.warn('[thanos] insertable streams are not supported, extension disabled');
    return;
  }

  // Analysis resolution for the person mask / dissolve grid.
  const AW = 160;
  const MAX_PARTICLES = 22000;
  const DIFF_THRESHOLD = 70;
  const FADE_MS = 450;
  const VANISH_MS = 3200;
  const APPEAR_MS = 2600;
  // In normalized animation time: cells start dissolving in [0, SPREAD],
  // each particle lives for LIFE afterwards.
  const SPREAD = 0.62;
  const LIFE = 0.38;

  // Finger snap detector, all on ~5 ms blocks of the mic signal high-passed at 2 kHz.
  const SNAP_BLOCK_MS = 5;
  const SNAP_HP_HZ = 2000;
  const SNAP_HP_SHARE = 0.3; // share of the block's energy above SNAP_HP_HZ: speech is far lower
  const SNAP_MAX_MS = 100; // a snap must die out within this, hiss and speech don't
  const SNAP_DECAY = 0.06; // ...down to this share of its peak energy
  const SNAP_COOLDOWN_MS = 1000;
  const SNAP_WARMUP_MS = 500; // let the noise floor settle first

  const state = {
    room: null, // ImageBitmap of the empty room
    roomSmall: new Map(), // "w x h" -> ImageData of the room at analysis size
    thanos: true,
    gone: false,
    snap: false,
    snapSens: 3, // 1..5
  };
  let anim = null; // { id, kind: 'vanish' | 'appear', thanos, start, dur }
  let animSeq = 0;
  const pipes = new Set();
  const mics = new Set(); // the page's mic tracks
  const taps = new Map(); // mic track -> SnapTap, only while snap is on

  const post = (msg) => window.postMessage({ ns: NS, dir: 'out', ...msg }, '*');

  const status = () => ({
    type: 'status',
    camera: [...pipes].some((p) => p.src.readyState === 'live'),
    hasRoom: !!state.room,
    gone: state.gone,
    animating: !!anim,
    thanos: state.thanos,
    mic: [...mics].some((t) => t.readyState === 'live'),
    snap: state.snap,
  });
  const sendStatus = () => post(status());

  // ---------- helpers ----------

  const canvas2d = (w, h, opts) => {
    const c = new OffscreenCanvas(w, h);
    return [c, c.getContext('2d', opts)];
  };

  const hash = (x, y, seed) => {
    let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  };

  // Smooth value noise, two octaves, in [0, 1].
  const noise = (x, y, seed) => {
    let sum = 0;
    let amp = 0.65;
    let freq = 1;
    for (let o = 0; o < 2; o++) {
      const fx = x * freq;
      const fy = y * freq;
      const ix = Math.floor(fx);
      const iy = Math.floor(fy);
      const tx = fx - ix;
      const ty = fy - iy;
      const sx = tx * tx * (3 - 2 * tx);
      const sy = ty * ty * (3 - 2 * ty);
      const a = hash(ix, iy, seed + o);
      const b = hash(ix + 1, iy, seed + o);
      const c = hash(ix, iy + 1, seed + o);
      const d = hash(ix + 1, iy + 1, seed + o);
      sum += amp * (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy);
      amp *= 0.35 / 0.65;
      freq *= 2.7;
    }
    return sum;
  };

  const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

  const getRoomSmall = (aw, ah) => {
    const key = `${aw}x${ah}`;
    let data = state.roomSmall.get(key);
    if (!data && state.room) {
      const [, ctx] = canvas2d(aw, ah, { willReadFrequently: true });
      ctx.drawImage(state.room, 0, 0, aw, ah);
      data = ctx.getImageData(0, 0, aw, ah);
      state.roomSmall.set(key, data);
    }
    return data;
  };

  const setRoom = async (source) => {
    state.room = source ? await createImageBitmap(source) : null;
    state.roomSmall.clear();
    if (!state.room) {
      state.gone = false;
      anim = null;
    }
    sendStatus();
  };

  // ---------- per-track pipeline ----------

  class Pipe {
    constructor(src) {
      this.src = src;
      this.gen = new MediaStreamTrackGenerator({ kind: 'video' });
      this.reader = new MediaStreamTrackProcessor({ track: src }).readable.getReader();
      this.writer = this.gen.writable.getWriter();
      this.canvas = null;
      this.ctx = null;
      this.fx = null; // effect data built for a specific anim id
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
            console.error('[thanos] frame error', e);
          }
          if (out !== frame) frame.close();
          await this.writer.write(out);
        }
      } catch (e) {
        if (this.src.readyState === 'live') console.error('[thanos] pipeline stopped', e);
      } finally {
        pipes.delete(this);
        sendStatus();
      }
    }

    ensureCanvas(w, h) {
      if (!this.canvas || this.canvas.width !== w || this.canvas.height !== h) {
        [this.canvas, this.ctx] = canvas2d(w, h, { willReadFrequently: true });
        this.fx = null;
      }
    }

    output(frame) {
      return new VideoFrame(this.canvas, { timestamp: frame.timestamp, duration: frame.duration ?? undefined });
    }

    process(frame) {
      const w = frame.displayWidth;
      const h = frame.displayHeight;

      if (this.captureReq) this.feedCapture(frame, w, h);

      const now = performance.now();
      if (anim && now - anim.start >= anim.dur) {
        state.gone = anim.kind === 'vanish';
        anim = null;
        this.fx = null;
        sendStatus();
      }

      if (!anim && (!state.gone || !state.room)) return frame; // passthrough, zero cost

      this.ensureCanvas(w, h);
      const ctx = this.ctx;

      if (!anim) {
        ctx.drawImage(state.room, 0, 0, w, h);
        return this.output(frame);
      }

      const t = Math.min(1, (now - anim.start) / anim.dur);
      if (!anim.thanos) {
        // plain crossfade
        const a = easeInOut(anim.kind === 'vanish' ? t : 1 - t);
        ctx.globalAlpha = 1;
        ctx.drawImage(frame, 0, 0, w, h);
        ctx.globalAlpha = a;
        ctx.drawImage(state.room, 0, 0, w, h);
        ctx.globalAlpha = 1;
        return this.output(frame);
      }

      if (!this.fx || this.fx.id !== anim.id) this.fx = this.buildDust(frame, w, h);
      // Appear is the vanish played backwards: particles fly back in.
      this.renderDust(frame, w, h, anim.kind === 'vanish' ? t : 1 - t);
      return this.output(frame);
    }

    // ---- room capture: average a few frames to kill sensor noise ----

    feedCapture(frame, w, h) {
      const req = this.captureReq;
      if (!req.acc || req.w !== w || req.h !== h) {
        req.w = w;
        req.h = h;
        req.acc = new Float32Array(w * h * 4);
        req.got = 0;
        [req.c, req.ctx] = canvas2d(w, h, { willReadFrequently: true });
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

    // ---- Thanos dust ----

    buildDust(frame, w, h) {
      const aw = AW;
      const ah = Math.max(1, Math.round((AW * h) / w));
      const [, sctx] = canvas2d(aw, ah, { willReadFrequently: true });
      sctx.drawImage(frame, 0, 0, aw, ah);
      const live = sctx.getImageData(0, 0, aw, ah).data;
      const room = getRoomSmall(aw, ah).data;

      // Person mask = pixels that differ from the empty room.
      const raw = new Uint8Array(aw * ah);
      for (let i = 0, p = 0; i < raw.length; i++, p += 4) {
        const diff = Math.abs(live[p] - room[p]) + Math.abs(live[p + 1] - room[p + 1]) + Math.abs(live[p + 2] - room[p + 2]);
        raw[i] = diff > DIFF_THRESHOLD ? 1 : 0;
      }
      // Majority filter (drops speckles) + 1px dilation.
      const mask = new Uint8Array(aw * ah);
      for (let y = 0; y < ah; y++) {
        for (let x = 0; x < aw; x++) {
          let n = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx;
              const yy = y + dy;
              if (xx >= 0 && yy >= 0 && xx < aw && yy < ah) n += raw[yy * aw + xx];
            }
          }
          mask[y * aw + x] = n >= 3 ? 1 : 0;
        }
      }

      // When each cell turns to dust: left to right across the person, broken up by noise.
      let minX = aw;
      let maxX = 0;
      for (let i = 0; i < mask.length; i++) {
        if (!mask[i]) continue;
        const x = i % aw;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
      const span = Math.max(1, maxX - minX);
      const seed = (Math.random() * 1e6) | 0;
      const cellT = new Float32Array(aw * ah);
      for (let y = 0; y < ah; y++) {
        for (let x = 0; x < aw; x++) {
          const n = noise(x / 14, y / 14, seed);
          const xn = (x - minX) / span;
          cellT[y * aw + x] = SPREAD * Math.min(1, Math.max(0, 0.7 * xn + 0.6 * n - 0.3));
        }
      }

      // Particles: sample the full-res frame inside the mask.
      const [, fctx] = canvas2d(w, h, { willReadFrequently: true });
      fctx.drawImage(frame, 0, 0, w, h);
      const full = fctx.getImageData(0, 0, w, h).data;
      let maskCount = 0;
      for (let i = 0; i < mask.length; i++) maskCount += mask[i];
      const area = maskCount * (w / aw) * (h / ah);
      const step = Math.max(2, Math.ceil(Math.sqrt(area / MAX_PARTICLES)));
      const kx = aw / w;
      const ky = ah / h;
      const scale = w / 640;

      const P = [];
      const C = [];
      for (let y = 0; y < h; y += step) {
        const my = Math.min(ah - 1, (y * ky) | 0);
        for (let x = 0; x < w; x += step) {
          const mx = Math.min(aw - 1, (x * kx) | 0);
          const cell = my * aw + mx;
          if (!mask[cell]) continue;
          const r = Math.random();
          // x0, y0, vx, vy, ax, t0, phase, wobble
          P.push(
            x,
            y,
            (60 + r * 220) * scale,
            (-30 - Math.random() * 110) * scale,
            (40 + Math.random() * 120) * scale,
            cellT[cell] + Math.random() * 0.04,
            Math.random() * Math.PI * 2,
            (4 + Math.random() * 14) * scale
          );
          const p = (y * w + x) * 4;
          C.push(full[p] | (full[p + 1] << 8) | (full[p + 2] << 16));
        }
      }

      const [maskCanvas, maskCtx] = canvas2d(aw, ah);
      const [roomLayer, roomCtx] = canvas2d(w, h);
      const [dustLayer, dustCtx] = canvas2d(w, h);
      return {
        id: anim.id,
        aw,
        ah,
        cellT,
        mask,
        particles: new Float32Array(P),
        colors: new Uint32Array(C),
        size: Math.max(2, Math.round(step * 0.9)),
        dur: anim.dur / 1000,
        maskCanvas,
        maskCtx,
        maskImg: maskCtx.createImageData(aw, ah),
        roomLayer,
        roomCtx,
        dustLayer,
        dustCtx,
        dustImg: dustCtx.createImageData(w, h),
      };
    }

    renderDust(frame, w, h, t) {
      const fx = this.fx;
      const ctx = this.ctx;

      // 1. live camera
      ctx.drawImage(frame, 0, 0, w, h);

      // 2. empty room over the cells that already turned to dust (soft edges)
      const ma = fx.maskImg.data;
      for (let i = 0; i < fx.cellT.length; i++) {
        const a = (t - fx.cellT[i]) / 0.05;
        ma[i * 4 + 3] = a <= 0 ? 0 : a >= 1 ? 255 : a * 255;
      }
      fx.maskCtx.putImageData(fx.maskImg, 0, 0);
      const rc = fx.roomCtx;
      rc.globalCompositeOperation = 'copy';
      rc.drawImage(state.room, 0, 0, w, h);
      rc.globalCompositeOperation = 'destination-in';
      rc.imageSmoothingEnabled = true;
      rc.drawImage(fx.maskCanvas, 0, 0, w, h);
      ctx.drawImage(fx.roomLayer, 0, 0);

      // 3. flying dust
      const buf = new Uint32Array(fx.dustImg.data.buffer);
      buf.fill(0);
      const P = fx.particles;
      const C = fx.colors;
      const s = fx.size;
      for (let i = 0, j = 0; i < P.length; i += 8, j++) {
        const age = t - P[i + 5];
        if (age <= 0 || age >= LIFE) continue;
        const sec = age * fx.dur;
        const life = age / LIFE;
        const alpha = (1 - life) ** 1.4;
        const x = (P[i] + P[i + 2] * sec + 0.5 * P[i + 4] * sec * sec + Math.sin(P[i + 6] + sec * 4) * P[i + 7] * life) | 0;
        const y = (P[i + 1] + P[i + 3] * sec + Math.cos(P[i + 6] + sec * 3) * P[i + 7] * life) | 0;
        const sz = Math.max(1, Math.round(s * (1 - life * 0.6)));
        if (x < 0 || y < 0 || x + sz > w || y + sz > h) continue;
        // Dust darkens and desaturates as it flies off.
        const col = C[j];
        const k = 1 - 0.55 * life;
        const r = (col & 255) * k;
        const g = ((col >> 8) & 255) * k;
        const b = ((col >> 16) & 255) * k;
        const px = (r | (g << 8) | (b << 16) | ((alpha * 255) << 24)) >>> 0;
        for (let yy = 0; yy < sz; yy++) {
          const row = (y + yy) * w + x;
          for (let xx = 0; xx < sz; xx++) buf[row + xx] = px;
        }
      }
      fx.dustCtx.putImageData(fx.dustImg, 0, 0);
      ctx.drawImage(fx.dustLayer, 0, 0);
    }
  }

  // ---------- finger snap ----------

  // Sensitivity 1..5 -> how far above the noise floor (power ratio) and how loud
  // (high-passed peak) a click has to be.
  const snapLevels = () => ({
    ratio: 10 ** ((28 - 3 * state.snapSens) / 10),
    peak: 0.3 * 0.6 ** (state.snapSens - 1),
  });

  // Listens to a clone of a page mic track, so muting in the call (which
  // disables the page's track) doesn't stop the snaps from being heard.
  class SnapTap {
    constructor(src) {
      this.track = src.clone();
      this.track.enabled = true;
      this.reader = new MediaStreamTrackProcessor({ track: this.track }).readable.getReader();
      this.rate = 0;
      this.buf = new Float32Array(0);
      this.lastSnap = -Infinity;
      this.loop();
    }

    stop() {
      this.track.stop();
      this.reader.cancel().catch(() => {});
    }

    async loop() {
      try {
        for (;;) {
          const { value: data, done } = await this.reader.read();
          if (done) break;
          try {
            this.feed(data);
          } finally {
            data.close();
          }
        }
      } catch (e) {
        if (this.track.readyState === 'live') console.error('[thanos] mic tap stopped', e);
      }
    }

    reset(rate) {
      this.rate = rate;
      this.block = Math.round((rate * SNAP_BLOCK_MS) / 1000);
      const rc = 1 / (2 * Math.PI * SNAP_HP_HZ);
      this.a = rc / (rc + 1 / rate);
      this.x = 0;
      this.y = 0;
      this.k = 0;
      this.eHp = 0;
      this.eAll = 0;
      this.peak = 0;
      this.blocks = 0;
      this.floor = 0;
      this.prevE = 0;
      this.cand = null; // { maxHp, maxAll, blocks } while a click is ringing out
    }

    feed(data) {
      if (data.sampleRate !== this.rate) this.reset(data.sampleRate);
      const n = data.numberOfFrames;
      if (this.buf.length < n) this.buf = new Float32Array(n);
      const buf = this.buf;
      data.copyTo(buf, { planeIndex: 0, format: 'f32-planar' });
      for (let i = 0; i < n; i++) {
        const x = buf[i];
        const y = this.a * (this.y + x - this.x);
        this.x = x;
        this.y = y;
        this.eHp += y * y;
        this.eAll += x * x;
        const ay = Math.abs(y);
        if (ay > this.peak) this.peak = ay;
        if (++this.k === this.block) {
          this.onBlock(this.eHp / this.block, this.eAll / this.block, this.peak);
          this.k = 0;
          this.eHp = 0;
          this.eAll = 0;
          this.peak = 0;
        }
      }
    }

    onBlock(e, eAll, peak) {
      const blockMs = (this.block / this.rate) * 1000;
      if (++this.blocks * blockMs < SNAP_WARMUP_MS) {
        this.floor = this.floor ? Math.min(this.floor, e) : e;
        this.prevE = e;
        return;
      }
      const { ratio, peak: minPeak } = snapLevels();
      const loud = this.floor * ratio;
      const c = this.cand;
      if (c) {
        // Fire once the click has died out in the whole band: a "t" or "k"
        // in speech is followed by a loud vowel, a hiss just keeps going.
        if (e < c.maxHp * SNAP_DECAY && eAll < c.maxAll * SNAP_DECAY * 2) {
          this.cand = null;
          const now = performance.now();
          if (now - this.lastSnap > SNAP_COOLDOWN_MS) {
            this.lastSnap = now;
            onSnap();
          }
        } else if (++c.blocks * blockMs > SNAP_MAX_MS) {
          this.cand = null;
        } else {
          c.maxHp = Math.max(c.maxHp, e);
          c.maxAll = Math.max(c.maxAll, eAll);
        }
      } else if (e > loud && this.prevE < loud && peak > minPeak && e > eAll * SNAP_HP_SHARE) {
        this.cand = { maxHp: e, maxAll: eAll, blocks: 0 };
      }
      // Noise floor: falls fast, rises slowly (~3 s), frozen while a click rings out.
      if (!this.cand) this.floor = Math.max(1e-10, this.floor + (e - this.floor) * (e < this.floor ? 0.05 : 0.002));
      this.prevE = e;
    }
  }

  const syncTaps = () => {
    for (const t of mics) if (t.readyState !== 'live') mics.delete(t);
    for (const [t, tap] of taps) {
      if (state.snap && mics.has(t)) continue;
      tap.stop();
      taps.delete(t);
    }
    if (state.snap) {
      for (const t of mics) {
        if (taps.has(t)) continue;
        try {
          taps.set(t, new SnapTap(t));
        } catch (e) {
          console.error('[thanos] cannot listen to the mic', e);
        }
      }
    }
    sendStatus();
  };

  const addMic = (track) => {
    mics.add(track);
    // Our clone must not keep the mic open after the page is done with it.
    const stop = track.stop.bind(track);
    track.stop = () => {
      stop();
      syncTaps();
    };
    track.addEventListener('ended', syncTaps);
  };

  const onSnap = () => {
    if (anim || !livePipe()) return;
    toggle();
  };

  // ---------- getUserMedia hook ----------

  const realGetUserMedia = md.getUserMedia.bind(md);
  md.getUserMedia = async function getUserMedia(constraints) {
    const stream = await realGetUserMedia(constraints);
    if (stream.getAudioTracks().length) {
      stream.getAudioTracks().forEach(addMic);
      syncTaps();
    }
    if (!constraints || !constraints.video) return stream;
    const tracks = stream.getTracks().map((track) => {
      if (track.kind !== 'video') return track;
      try {
        return new Pipe(track).gen;
      } catch (e) {
        console.error('[thanos] cannot wrap track', e);
        return track;
      }
    });
    sendStatus();
    return new MediaStream(tracks);
  };

  // ---------- commands ----------

  const livePipe = () => [...pipes].find((p) => p.src.readyState === 'live');

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

  const go = (kind) => {
    if (!state.room) {
      post({ type: 'error', code: 'no-room' });
      return;
    }
    const wantGone = kind === 'vanish';
    const current = anim ? anim.kind === 'vanish' : state.gone;
    if (wantGone === current) return;
    // Reversing mid-animation is not supported: finish instantly, then start.
    state.gone = !wantGone;
    anim = {
      id: ++animSeq,
      kind,
      thanos: state.thanos,
      start: performance.now(),
      dur: state.thanos ? (wantGone ? VANISH_MS : APPEAR_MS) : FADE_MS,
    };
    sendStatus();
  };

  const toggle = () => go((anim ? anim.kind === 'vanish' : state.gone) ? 'appear' : 'vanish');

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
            .catch((err) => console.error('[thanos] bad room image', err));
        } else setRoom(null);
        break;
      case 'setThanos':
        state.thanos = !!m.value;
        sendStatus();
        break;
      case 'capture':
        capture();
        break;
      case 'vanish':
      case 'appear':
        go(m.type);
        break;
      case 'toggle':
        toggle();
        break;
      case 'setSnap':
        state.snap = !!m.enabled;
        state.snapSens = Math.min(5, Math.max(1, Number(m.sens) || 3));
        syncTaps();
        break;
      case 'status':
        sendStatus();
        break;
    }
  });
})();
