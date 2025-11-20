// Import config
importScripts('config.js');

// State
let recording = false;
let spinInterval = null;
let settingsTabId = null;
let recordingTabId = null;

// Icon setters
function setDefaultIcon() {
  chrome.action.setIcon({
    path: {
      16: 'icons/light/icon16.png',
      48: 'icons/light/icon48.png',
      128: 'icons/light/icon128.png'
    }
  });
}

function setReadyIcon() {
  chrome.action.setIcon({
    path: {
      16: 'icons/ready/icon16.png',
      48: 'icons/ready/icon48.png',
      128: 'icons/ready/icon128.png'
    }
  });
}

function startRecordingAnimation() {
  const rotations = [0, 90, 180, 270];
  const opacities = [20, 30, 40, 50, 60, 70, 80, 90, 100, 90, 80, 70, 60, 50, 40, 30];
  let rotationIndex = 0;
  let opacityIndex = 0;

  spinInterval = setInterval(() => {
    const deg = rotations[rotationIndex];
    const op = opacities[opacityIndex];

    chrome.action.setIcon({
      path: {
        16: `icons/rec16_${deg}_${op}.png`,
        48: `icons/rec48_${deg}_${op}.png`,
        128: `icons/rec128_${deg}_${op}.png`
      }
    });

    rotationIndex = (rotationIndex + 1) % rotations.length;
    opacityIndex = (opacityIndex + 1) % opacities.length;
  }, 50);
}

function stopRecordingAnimation() {
  if (spinInterval) {
    clearInterval(spinInterval);
    spinInterval = null;
  }
}

// Check if a tab is recordable
function isRecordable(tab) {
  if (!tab || !tab.url) return false;
  return !tab.url.startsWith('chrome://') &&
         !tab.url.startsWith('chrome-extension://') &&
         !tab.url.startsWith('about:') &&
         tab.url !== '';
}

// Update icon based on current state
async function updateIcon() {
  if (recording) return; // Don't change during recording

  // Check if settings tab exists
  if (!settingsTabId) {
    setDefaultIcon();
    return;
  }

  try {
    await chrome.tabs.get(settingsTabId);
  } catch (e) {
    settingsTabId = null;
    setDefaultIcon();
    return;
  }

  // Get active tab
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });

  if (activeTab && isRecordable(activeTab) && activeTab.id !== settingsTabId) {
    setReadyIcon();
  } else {
    setDefaultIcon();
  }
}

// Initialize icon
setDefaultIcon();

// Track tab changes to update icon
chrome.tabs.onActivated.addListener(async () => {
  await updateIcon();
});

chrome.windows.onFocusChanged.addListener(async () => {
  await updateIcon();
});

// Handle icon click
chrome.action.onClicked.addListener(async () => {
  // If recording, stop and switch to settings
  if (recording) {
    recording = false;
    stopRecordingAnimation();

    // Remove cursor tracker from target tab
    if (recordingTabId) {
      try {
        await chrome.scripting.removeCSS({
          target: { tabId: recordingTabId },
          css: `* { cursor: url('${chrome.runtime.getURL('icons/cursor-faint.png')}') 0 0, auto !important; }`
        });
      } catch (e) {
        // Tab may be closed
      }
    }

    // Tell settings tab to stop recording
    if (settingsTabId) {
      try {
        await chrome.tabs.sendMessage(settingsTabId, { action: 'stopRecording' });
        chrome.tabs.update(settingsTabId, { active: true });
        const tab = await chrome.tabs.get(settingsTabId);
        chrome.windows.update(tab.windowId, { focused: true });
      } catch (e) {
        console.error('Error stopping recording:', e);
      }
    }

    await updateIcon();
    return;
  }

  // Check if settings tab exists
  let settingsExists = false;
  if (settingsTabId) {
    try {
      await chrome.tabs.get(settingsTabId);
      settingsExists = true;
    } catch (e) {
      settingsTabId = null;
    }
  }

  // If no settings tab, open it
  if (!settingsExists) {
    const tab = await chrome.tabs.create({ url: 'recorder.html' });
    settingsTabId = tab.id;
    return;
  }

  // Get active tab
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });

  // If on recordable tab, start recording
  if (activeTab && isRecordable(activeTab) && activeTab.id !== settingsTabId) {
    try {
      // Get stream ID for the active tab
      const streamId = await chrome.tabCapture.getMediaStreamId({
        targetTabId: activeTab.id
      });

      recordingTabId = activeTab.id;
      recording = true;
      startRecordingAnimation();

      // Get site name from URL
      let siteName = 'recording';
      try {
        const url = new URL(activeTab.url);
        siteName = url.hostname.replace(/^www\./, '').replace(/\./g, '-');
      } catch (e) {
        siteName = 'recording';
      }

      // Inject cursor tracker into target tab
      await chrome.scripting.insertCSS({
        target: { tabId: activeTab.id },
        css: `* { cursor: url('${chrome.runtime.getURL('icons/cursor-faint.png')}') 0 0, auto !important; }`
      });

      await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        func: () => {
          // Remove any existing listener
          if (window._gifRecorderMouseMove) {
            document.removeEventListener('mousemove', window._gifRecorderMouseMove);
            document.removeEventListener('mousedown', window._gifRecorderMouseDown);
            document.removeEventListener('mouseup', window._gifRecorderMouseUp);
          }

          let lastX = 0, lastY = 0;

          window._gifRecorderMouseMove = (e) => {
            lastX = e.clientX;
            lastY = e.clientY;
            chrome.runtime.sendMessage({
              action: 'cursorMove',
              x: e.clientX,
              y: e.clientY
            });
          };

          window._gifRecorderMouseDown = () => {
            chrome.runtime.sendMessage({
              action: 'cursorDown',
              x: lastX,
              y: lastY
            });
          };

          window._gifRecorderMouseUp = () => {
            chrome.runtime.sendMessage({
              action: 'cursorUp',
              x: lastX,
              y: lastY
            });
          };

          document.addEventListener('mousemove', window._gifRecorderMouseMove, { passive: true });
          document.addEventListener('mousedown', window._gifRecorderMouseDown, { passive: true });
          document.addEventListener('mouseup', window._gifRecorderMouseUp, { passive: true });
        }
      });

      // Send to settings tab to start recording
      await chrome.tabs.sendMessage(settingsTabId, {
        action: 'startRecording',
        streamId: streamId,
        siteName: siteName
      });

    } catch (error) {
      console.error('Start recording error:', error);
      recording = false;
      stopRecordingAnimation();
      await updateIcon();
    }
  } else {
    // On non-recordable tab, just focus settings
    chrome.tabs.update(settingsTabId, { active: true });
    const tab = await chrome.tabs.get(settingsTabId);
    chrome.windows.update(tab.windowId, { focused: true });
  }
});

// Track when settings tab is closed
chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (tabId === settingsTabId) {
    settingsTabId = null;
    if (recording) {
      recording = false;
      stopRecordingAnimation();
    }
    await updateIcon();
  }
});

// Listen for messages
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Relay cursor events from target tab to recorder tab
  if (request.action === 'cursorMove' || request.action === 'cursorDown' || request.action === 'cursorUp') {
    if (settingsTabId && recording) {
      chrome.tabs.sendMessage(settingsTabId, request).catch(() => {});
    }
    return false;
  }

  if (request.action === 'cursorTrackingActive') {
    console.log('Cursor tracking active in tab:', sender.tab?.id);
    return false;
  }

  if (request.action === 'recordingError') {
    recording = false;
    stopRecordingAnimation();
    updateIcon();
    sendResponse({ received: true });
  }
  return false;
});
