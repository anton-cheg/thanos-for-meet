const $ = (id) => document.getElementById(id);
const pill = $('pill');
const preview = $('preview');
const roomText = $('roomText');
const captureBtn = $('capture');
const toggleBtn = $('toggle');
const thanosBox = $('thanos');
const snapBox = $('snap');
const snapSens = $('snapSens');
const sensRow = $('sensRow');
const snapText = $('snapText');

const SITES = ['https://meet.google.com/', 'https://discord.com/'];

let tabId = null;
let status = null;
let hasRoom = false;

const send = (cmd) => chrome.tabs.sendMessage(tabId, { cmd }).catch(() => null);

function render() {
  const onSite = tabId !== null && status;
  captureBtn.disabled = !onSite || !status.camera || status.countingDown;
  toggleBtn.disabled = !onSite || !status.camera || !hasRoom;
  toggleBtn.textContent = status?.gone ? 'Вернуться' : 'Исчезнуть';
  toggleBtn.classList.toggle('back', !!status?.gone);
  captureBtn.textContent = status?.countingDown ? 'Выйди из кадра…' : hasRoom ? 'Переснять' : 'Снять комнату';

  pill.className = 'pill';
  if (!onSite) pill.textContent = 'открой Google Meet или Discord';
  else if (!status.camera) pill.textContent = 'камера выключена';
  else if (status.gone) {
    pill.textContent = 'тебя нет';
    pill.classList.add('gone');
  } else {
    pill.textContent = 'камера активна';
    pill.classList.add('ok');
  }

  sensRow.hidden = !snapBox.checked;
  snapText.textContent =
    snapBox.checked && onSite && !status.mic
      ? 'Включи микрофон в звонке — щелчок слышно только через него'
      : 'Щёлкни — исчезнешь, щёлкни ещё раз — вернёшься';

  roomText.textContent = hasRoom
    ? 'Комната сохранена. Можно исчезать.'
    : 'Выйди из кадра и сними пустую комнату — она заменит тебя в камере.';
}

function showRoom(dataUrl) {
  hasRoom = !!dataUrl;
  preview.style.backgroundImage = dataUrl ? `url("${dataUrl}")` : '';
  preview.classList.toggle('has', hasRoom);
  render();
}

async function init() {
  const { room, thanos, snap, snapSens: sens } = await chrome.storage.local.get({
    room: null,
    thanos: true,
    snap: false,
    snapSens: 3,
  });
  thanosBox.checked = thanos;
  snapBox.checked = snap;
  snapSens.value = sens;
  showRoom(room);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (SITES.some((s) => tab?.url?.startsWith(s))) {
    tabId = tab.id;
    status = await send('getStatus');
  }
  render();
}

captureBtn.addEventListener('click', () => send('capture'));
toggleBtn.addEventListener('click', () => send('toggle'));
thanosBox.addEventListener('change', () => chrome.storage.local.set({ thanos: thanosBox.checked }));
snapBox.addEventListener('change', () => {
  chrome.storage.local.set({ snap: snapBox.checked });
  render();
});
snapSens.addEventListener('change', () => chrome.storage.local.set({ snapSens: Number(snapSens.value) }));

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.event === 'status' && sender.tab?.id === tabId) {
    status = msg.status;
    render();
  }
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.room) showRoom(changes.room.newValue);
});

init();
