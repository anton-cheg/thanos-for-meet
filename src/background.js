const COMMANDS = { 'toggle-vanish': 'toggle', 'capture-room': 'capture' };
const SITES = ['https://meet.google.com/*', 'https://discord.com/*'];
const onSite = (url) => SITES.some((s) => url?.startsWith(s.slice(0, -1)));

chrome.commands.onCommand.addListener(async (command, tab) => {
  const cmd = COMMANDS[command];
  if (!cmd) return;
  const target = onSite(tab?.url) ? tab : (await chrome.tabs.query({ url: SITES, active: true }))[0];
  if (target) chrome.tabs.sendMessage(target.id, { cmd }).catch(() => {});
});
