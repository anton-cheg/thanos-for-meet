const $ = (id) => document.getElementById(id);
const pill = $('pill');
const preview = $('preview');
const roomText = $('roomText');
const captureBtn = $('capture');
const toggleBtn = $('toggle');
const thanosBox = $('thanos');

let tabId = null;
let status = null;
let hasRoom = false;

const send = (cmd) => chrome.tabs.sendMessage(tabId, { cmd }).catch(() => null);

function render() {
  const onMeet = tabId !== null && status;
  captureBtn.disabled = !onMeet || !status.camera || status.countingDown;
  toggleBtn.disabled = !onMeet || !status.camera || !hasRoom;
  toggleBtn.textContent = status?.gone ? 'Вернуться' : 'Исчезнуть';
  toggleBtn.classList.toggle('back', !!status?.gone);
  captureBtn.textContent = status?.countingDown ? 'Выйди из кадра…' : hasRoom ? 'Переснять' : 'Снять комнату';

  pill.className = 'pill';
  if (!onMeet) pill.textContent = 'открой Google Meet';
  else if (!status.camera) pill.textContent = 'камера выключена';
  else if (status.gone) {
    pill.textContent = 'тебя нет';
    pill.classList.add('gone');
  } else {
    pill.textContent = 'камера активна';
    pill.classList.add('ok');
  }

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
  const { room, thanos } = await chrome.storage.local.get({ room: null, thanos: true });
  thanosBox.checked = thanos;
  showRoom(room);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url?.startsWith('https://meet.google.com/')) {
    tabId = tab.id;
    status = await send('getStatus');
  }
  render();
}

captureBtn.addEventListener('click', () => send('capture'));
toggleBtn.addEventListener('click', () => send('toggle'));
thanosBox.addEventListener('change', () => chrome.storage.local.set({ thanos: thanosBox.checked }));

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
