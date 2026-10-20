const $ = (id) => document.getElementById(id);
const pill = $('pill');
const preview = $('preview');
const roomText = $('roomText');
const captureBtn = $('capture');
const mascotBox = $('mascot');

let tabId = null;
let status = null;
let hasRoom = false;

const send = (cmd) => chrome.tabs.sendMessage(tabId, { cmd }).catch(() => null);

function render() {
  const onMeet = tabId !== null && status;
  captureBtn.disabled = !onMeet || !status.camera || status.countingDown;
  captureBtn.textContent = status?.countingDown ? 'Выйди из кадра…' : hasRoom ? 'Переснять' : 'Снять комнату';

  pill.className = 'pill';
  if (!onMeet) pill.textContent = 'открой Google Meet';
  else if (!status.camera) pill.textContent = 'камера не включена';
  else if (!status.mascot) {
    pill.textContent = 'камера как есть';
    pill.classList.add('ok');
  } else if (status.detector !== 'ready') pill.textContent = 'загружаю трекинг…';
  else if (!status.face) pill.textContent = 'лицо не найдено';
  else {
    pill.textContent = 'Clawd в кадре';
    pill.classList.add('clawd');
  }

  roomText.textContent = hasRoom
    ? 'Сохранена. Тело стирается целиком — в кадре только Clawd.'
    : 'Необязательно: сними комнату без себя, чтобы стереть и тело, а не только перекрыть голову.';
}

function showRoom(dataUrl) {
  hasRoom = !!dataUrl;
  preview.style.backgroundImage = dataUrl ? `url("${dataUrl}")` : '';
  preview.classList.toggle('has', hasRoom);
  render();
}

async function init() {
  const { room, mascot } = await chrome.storage.local.get({ room: null, mascot: true });
  mascotBox.checked = mascot;
  showRoom(room);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url?.startsWith('https://meet.google.com/')) {
    tabId = tab.id;
    status = await send('getStatus');
  }
  render();
}

captureBtn.addEventListener('click', () => send('capture'));
mascotBox.addEventListener('change', () => chrome.storage.local.set({ mascot: mascotBox.checked }));

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.event === 'status' && sender.tab?.id === tabId) {
    status = msg.status;
    render();
  }
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.room) showRoom(changes.room.newValue);
  if (changes.mascot) mascotBox.checked = changes.mascot.newValue;
});

init();
