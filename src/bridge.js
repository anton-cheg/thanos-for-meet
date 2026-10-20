// Isolated-world content script: relays between the extension (popup,
// background, storage) and inject.js living in the page's MAIN world, and
// embeds the face-tracking iframe when the mascot is on.
(() => {
  const NS = 'clawd-meet';
  const CAPTURE_DELAY = 3;

  let status = { type: 'status', camera: false, hasRoom: false, mascot: false, detector: 'off', face: false };
  let countingDown = false;
  let mascot = false;

  const toPage = (msg, transfer) => window.postMessage({ ns: NS, dir: 'in', ...msg }, '*', transfer);
  const publicStatus = () => ({ ...status, countingDown });
  const pushStatus = () => chrome.runtime.sendMessage({ event: 'status', status: publicStatus() }).catch(() => {});

  // ---------- face detector iframe ----------

  let detector = null;
  function ensureDetector() {
    if (detector) return;
    detector = document.createElement('iframe');
    detector.src = chrome.runtime.getURL('detector/detector.html');
    detector.allow = '';
    detector.setAttribute('aria-hidden', 'true');
    detector.style.cssText =
      'position:fixed;left:-20px;top:-20px;width:2px;height:2px;border:0;opacity:0;pointer-events:none;';
    detector.addEventListener('load', () => {
      const { port1, port2 } = new MessageChannel();
      detector.contentWindow.postMessage({ type: 'clawd-port' }, new URL(detector.src).origin, [port1]);
      toPage({ type: 'detectorPort' }, [port2]);
    });
    (document.body || document.documentElement).appendChild(detector);
  }

  const setMascot = (value) => {
    mascot = !!value;
    if (mascot) ensureDetector();
    toPage({ type: 'setMascot', value: mascot });
  };

  // ---------- storage sync ----------

  chrome.storage.local.get({ room: null, mascot: true }, ({ room, mascot: on }) => {
    if (room) toPage({ type: 'setRoom', dataUrl: room });
    setMascot(on);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.mascot) setMascot(changes.mascot.newValue);
    // Rooms captured in this tab are already loaded; only sync removals.
    if (changes.room && !changes.room.newValue) toPage({ type: 'setRoom', dataUrl: null });
  });

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const m = e.data;
    if (!m || m.ns !== NS || m.dir !== 'out') return;
    if (m.type === 'status') {
      status = m;
      pushStatus();
    } else if (m.type === 'roomCaptured') {
      chrome.storage.local.set({ room: m.dataUrl });
      toast('Комната сохранена — теперь Clawd заменяет тебя целиком');
    } else if (m.type === 'error') {
      toast(m.code === 'no-camera' ? 'Камера не включена' : 'Ошибка');
    }
  });

  const capture = async (delay = CAPTURE_DELAY) => {
    if (countingDown) return;
    if (!status.camera) {
      toast('Камера не включена');
      return;
    }
    countingDown = true;
    pushStatus();
    for (let i = delay; i > 0; i--) {
      toast(`Выйди из кадра… ${i}`, 1100);
      await new Promise((r) => setTimeout(r, 1000));
    }
    countingDown = false;
    toPage({ type: 'capture' });
  };

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    switch (msg.cmd) {
      case 'getStatus':
        reply(publicStatus());
        return;
      case 'capture':
        capture(msg.delay);
        break;
      case 'toggle':
        chrome.storage.local.set({ mascot: !mascot });
        toast(mascot ? 'Clawd ушёл, ты снова в кадре' : 'Теперь вместо тебя Clawd');
        break;
      default:
        return;
    }
    reply({ ok: true });
  });

  // ---------- tiny toast in the Meet page ----------

  let toastHost = null;
  let toastTimer = 0;
  function toast(text, ms = 2200) {
    if (!toastHost) {
      toastHost = document.createElement('div');
      toastHost.id = 'clawd-meet-toast';
      const root = toastHost.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>
        div { position: fixed; top: 18px; left: 50%; transform: translate(-50%, -8px); z-index: 2147483647;
          background: rgba(24, 26, 32, .92); color: #f1f3f4; font: 500 14px/1.3 system-ui, sans-serif;
          padding: 10px 16px; border-radius: 12px; box-shadow: 0 6px 24px rgba(0,0,0,.35);
          opacity: 0; transition: opacity .18s, transform .18s; pointer-events: none; }
        div.on { opacity: 1; transform: translate(-50%, 0); }
      </style><div></div>`;
      (document.body || document.documentElement).appendChild(toastHost);
    }
    const el = toastHost.shadowRoot.querySelector('div');
    el.textContent = text;
    el.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('on'), ms);
  }
})();
