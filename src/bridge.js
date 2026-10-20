// Isolated-world content script: relays between the extension (popup,
// background, storage) and inject.js living in the page's MAIN world.
(() => {
  const NS = 'thanos-meet';
  const CAPTURE_DELAY = 3;

  let status = { type: 'status', camera: false, hasRoom: false, gone: false, animating: false, thanos: true };
  let countingDown = false;

  const toPage = (msg) => window.postMessage({ ns: NS, dir: 'in', ...msg }, '*');

  chrome.storage.local.get({ room: null, thanos: true }, ({ room, thanos }) => {
    toPage({ type: 'setThanos', value: thanos });
    if (room) toPage({ type: 'setRoom', dataUrl: room });
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.thanos) toPage({ type: 'setThanos', value: changes.thanos.newValue });
    // Rooms captured in this tab are already loaded; only sync removals.
    if (changes.room && !changes.room.newValue) toPage({ type: 'setRoom', dataUrl: null });
  });

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const m = e.data;
    if (!m || m.ns !== NS || m.dir !== 'out') return;
    if (m.type === 'status') {
      status = m;
      chrome.runtime.sendMessage({ event: 'status', status: publicStatus() }).catch(() => {});
    } else if (m.type === 'roomCaptured') {
      chrome.storage.local.set({ room: m.dataUrl });
      toast('Комната сохранена. Можно исчезать');
    } else if (m.type === 'error') {
      toast(
        m.code === 'no-camera'
          ? 'Камера не включена'
          : m.code === 'no-room'
            ? 'Сначала сними пустую комнату'
            : 'Ошибка'
      );
    }
  });

  const publicStatus = () => ({ ...status, countingDown });

  const capture = async (delay = CAPTURE_DELAY) => {
    if (countingDown) return;
    if (!status.camera) {
      toast('Камера не включена');
      return;
    }
    countingDown = true;
    chrome.runtime.sendMessage({ event: 'status', status: publicStatus() }).catch(() => {});
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
      case 'vanish':
      case 'appear':
        toPage({ type: msg.cmd });
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
      toastHost.id = 'thanos-meet-toast';
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
