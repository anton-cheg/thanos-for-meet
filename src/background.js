const COMMANDS = { 'toggle-vanish': 'toggle', 'capture-room': 'capture' };

chrome.commands.onCommand.addListener(async (command, tab) => {
  const cmd = COMMANDS[command];
  if (!cmd) return;
  const target = tab?.url?.startsWith('https://meet.google.com/')
    ? tab
    : (await chrome.tabs.query({ url: 'https://meet.google.com/*', active: true }))[0];
  if (target) chrome.tabs.sendMessage(target.id, { cmd }).catch(() => {});
});
