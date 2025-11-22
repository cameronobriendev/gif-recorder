// Import config
importScripts('config.js');

// State
let recording = false;
let spinInterval = null;
let settingsTabId = null;
let nativePort = null;

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
  if (recording) return;

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

  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });

  if (activeTab && isRecordable(activeTab) && activeTab.id !== settingsTabId) {
    setReadyIcon();
  } else {
    setDefaultIcon();
  }
}

// Connect to native app
function connectNative() {
  if (nativePort) {
    return nativePort;
  }

  nativePort = chrome.runtime.connectNative('com.cameron.gifrecorder');

  nativePort.onMessage.addListener((message) => {
    console.log('Native message:', message);

    // Forward to settings tab
    if (settingsTabId) {
      chrome.tabs.sendMessage(settingsTabId, {
        action: 'nativeStatus',
        data: message
      }).catch(() => {});
    }

    // Handle status changes
    if (message.status === 'recording_started') {
      recording = true;
      startRecordingAnimation();
    } else if (message.status === 'complete' || message.status === 'error') {
      recording = false;
      stopRecordingAnimation();
      updateIcon();
    }
  });

  nativePort.onDisconnect.addListener(() => {
    console.log('Native app disconnected');
    if (chrome.runtime.lastError) {
      console.error('Error:', chrome.runtime.lastError.message);

      // Notify settings tab of error
      if (settingsTabId) {
        chrome.tabs.sendMessage(settingsTabId, {
          action: 'nativeStatus',
          data: {
            status: 'error',
            error: chrome.runtime.lastError.message
          }
        }).catch(() => {});
      }
    }
    nativePort = null;
    recording = false;
    stopRecordingAnimation();
    updateIcon();
  });

  return nativePort;
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
  // If recording, stop and go to settings
  if (recording) {
    if (nativePort) {
      nativePort.postMessage({ command: 'stop' });
    }
    // Immediately reset icon to ready state
    recording = false;
    stopRecordingAnimation();
    setReadyIcon();
    // Focus settings tab to see progress
    if (settingsTabId) {
      try {
        chrome.tabs.update(settingsTabId, { active: true });
        const tab = await chrome.tabs.get(settingsTabId);
        chrome.windows.update(tab.windowId, { focused: true });
      } catch (e) {}
    }
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

  // Check if we're on a recordable tab (green icon state)
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (activeTab && isRecordable(activeTab) && activeTab.id !== settingsTabId) {
    // Get viewport dimensions from active tab
    let viewport = null;
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        func: () => ({
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          screenX: window.screenX,
          screenY: window.screenY,
          outerWidth: window.outerWidth,
          outerHeight: window.outerHeight,
          devicePixelRatio: window.devicePixelRatio
        })
      });
      viewport = results[0].result;
    } catch (e) {
      console.error('Failed to get viewport:', e);
    }

    // Start recording directly - get settings from storage
    const settings = await chrome.storage.local.get(['fps', 'width', 'quality']);
    const port = connectNative();
    port.postMessage({
      command: 'start',
      options: {
        fps: parseInt(settings.fps) || 30,
        width: parseInt(settings.width) || 720,
        quality: settings.quality || 'medium',
        viewport: viewport
      }
    });
    return;
  }

  // Focus settings tab (grey icon state or on settings tab)
  chrome.tabs.update(settingsTabId, { active: true });
  const tab = await chrome.tabs.get(settingsTabId);
  chrome.windows.update(tab.windowId, { focused: true });
});

// Track when settings tab is closed
chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (tabId === settingsTabId) {
    settingsTabId = null;
    if (recording && nativePort) {
      nativePort.postMessage({ command: 'stop' });
    }
    recording = false;
    stopRecordingAnimation();
    await updateIcon();
  }
});

// Listen for messages from settings tab
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'startRecording') {
    // Get viewport from active tab
    (async () => {
      const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      let viewport = null;
      if (activeTab && activeTab.id !== settingsTabId) {
        try {
          const results = await chrome.scripting.executeScript({
            target: { tabId: activeTab.id },
            func: () => ({
              innerWidth: window.innerWidth,
              innerHeight: window.innerHeight,
              screenX: window.screenX,
              screenY: window.screenY,
              outerWidth: window.outerWidth,
              outerHeight: window.outerHeight,
              devicePixelRatio: window.devicePixelRatio
            })
          });
          viewport = results[0].result;
        } catch (e) {
          console.error('Failed to get viewport:', e);
        }
      }

      const port = connectNative();
      port.postMessage({
        command: 'start',
        options: {
          fps: request.fps || 30,
          width: request.width || 720,
          quality: request.quality || 'medium',
          viewport: viewport
        }
      });
      sendResponse({ success: true });
    })();
    return true; // Keep channel open for async response
  }

  if (request.action === 'stopRecording') {
    if (nativePort) {
      nativePort.postMessage({
        command: 'stop',
        options: {
          fps: request.fps || 10,
          width: request.width || 720,
          quality: request.quality || 'medium'
        }
      });
    }
    sendResponse({ success: true });
  }

  if (request.action === 'getRecordingState') {
    sendResponse({ recording });
  }

  return true;
});
