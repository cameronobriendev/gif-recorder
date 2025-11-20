// Content script injected into target tab to track cursor position

// Replace system cursor with faint version for navigation
const cursorUrl = chrome.runtime.getURL('icons/cursor-faint.png');
const style = document.createElement('style');
style.id = 'gif-recorder-cursor-hide';
style.textContent = `* { cursor: url('${cursorUrl}') 0 0, auto !important; }`;
document.head.appendChild(style);

// Track mouse position
let lastX = 0, lastY = 0;

document.addEventListener('mousemove', (e) => {
  lastX = e.clientX;
  lastY = e.clientY;
  chrome.runtime.sendMessage({
    action: 'cursorMove',
    x: e.clientX,
    y: e.clientY
  });
}, { passive: true });

// Track click state
document.addEventListener('mousedown', () => {
  chrome.runtime.sendMessage({
    action: 'cursorDown',
    x: lastX,
    y: lastY
  });
}, { passive: true });

document.addEventListener('mouseup', () => {
  chrome.runtime.sendMessage({
    action: 'cursorUp',
    x: lastX,
    y: lastY
  });
}, { passive: true });

// Notify that tracking is active
chrome.runtime.sendMessage({ action: 'cursorTrackingActive' });
