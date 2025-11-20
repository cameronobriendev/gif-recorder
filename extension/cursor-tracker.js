// Content script injected into target tab to track cursor position

// Hide system cursor
const style = document.createElement('style');
style.id = 'gif-recorder-cursor-hide';
style.textContent = '* { cursor: none !important; }';
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
