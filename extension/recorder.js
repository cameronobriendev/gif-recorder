// DOM elements
const statusEl = document.getElementById('status');
const fpsSelect = document.getElementById('fps');
const widthSelect = document.getElementById('width');
const qualitySelect = document.getElementById('quality');
const queueEl = document.getElementById('queue');
const downloadsEl = document.getElementById('downloads');
const recordBtn = document.getElementById('recordBtn');
const recordBtnText = document.getElementById('recordBtnText');

// State
let recording = false;
let downloadHistory = [];
let currentJob = null;

// Save settings to storage when changed
fpsSelect.addEventListener('change', saveSettings);
widthSelect.addEventListener('change', saveSettings);
qualitySelect.addEventListener('change', saveSettings);

function saveSettings() {
  chrome.storage.local.set({
    fps: fpsSelect.value,
    width: widthSelect.value,
    quality: qualitySelect.value
  });
}

// Load settings from storage
chrome.storage.local.get(['fps', 'width', 'quality'], (result) => {
  if (result.fps) fpsSelect.value = result.fps;
  if (result.width) widthSelect.value = result.width;
  if (result.quality) qualitySelect.value = result.quality;
});

// Record button click handler
recordBtn.addEventListener('click', async () => {
  if (recording) {
    // Stop recording
    chrome.runtime.sendMessage({
      action: 'stopRecording',
      fps: parseInt(fpsSelect.value),
      width: parseInt(widthSelect.value),
      quality: qualitySelect.value
    });
  } else {
    // Start recording
    chrome.runtime.sendMessage({
      action: 'startRecording',
      fps: parseInt(fpsSelect.value),
      width: parseInt(widthSelect.value),
      quality: qualitySelect.value
    });
    setStatus('Starting...', 'processing');
  }
});

// Handle native status updates from background
function handleNativeStatus(data) {
  switch (data.status) {
    case 'recording_started':
      recording = true;
      recordBtn.classList.add('recording');
      recordBtnText.textContent = 'Stop';
      setStatus('Recording...', 'recording');
      break;

    case 'uploading':
      recording = false;
      recordBtn.classList.remove('recording');
      recordBtnText.textContent = 'Record';
      setStatus('Uploading...', 'processing');

      // Create job for queue display
      currentJob = {
        id: 'native-job',
        progress: 0,
        status: 'uploading'
      };
      updateQueueDisplay();
      break;

    case 'processing':
      if (currentJob) {
        currentJob.progress = data.progress || 0;
        currentJob.status = 'processing';
        updateQueueDisplay();
      }
      setStatus(`Converting... ${data.progress || 0}%`, 'processing');
      break;

    case 'complete':
      if (currentJob) {
        currentJob.progress = 100;
        currentJob.status = 'completed';
        updateQueueDisplay();
      }

      // Extract filename from filepath
      const filepath = data.filepath || '';
      const filename = filepath.split('/').pop() || 'recording.gif';

      // Add to download history
      downloadHistory.unshift({
        id: 'dl-' + Date.now(),
        filename: filename,
        time: new Date().toLocaleTimeString(),
        isNew: true
      });

      currentJob = null;
      updateQueueDisplay();
      updateDownloadsDisplay();
      setStatus('Saved to Downloads!', 'ready');

      // Remove "new" highlight after animation
      setTimeout(() => {
        if (downloadHistory[0]) {
          downloadHistory[0].isNew = false;
          updateDownloadsDisplay();
        }
      }, 2000);
      break;

    case 'error':
      recording = false;
      recordBtn.classList.remove('recording');
      recordBtnText.textContent = 'Record';
      currentJob = null;
      updateQueueDisplay();
      setStatus('Error: ' + (data.error || 'Unknown error'), 'ready');
      break;

    case 'pong':
      // Native app is connected
      console.log('Native app connected');
      break;

    default:
      console.log('Unknown native status:', data.status);
  }
}

// Update queue display
function updateQueueDisplay() {
  if (!currentJob) {
    queueEl.innerHTML = '<div class="empty-message">No recordings in queue</div>';
    return;
  }

  queueEl.innerHTML = `
    <div class="queue-item">
      <div class="info">
        <div class="job-id">${currentJob.status}</div>
      </div>
      <div class="progress-bar">
        <div class="progress-fill" style="width: ${currentJob.progress}%"></div>
      </div>
      <span class="status-text">${currentJob.progress}%</span>
    </div>
  `;
}

// Update downloads display
function updateDownloadsDisplay() {
  if (downloadHistory.length === 0) {
    downloadsEl.innerHTML = '<div class="empty-message">No downloads yet</div>';
    return;
  }

  downloadsEl.innerHTML = downloadHistory.map(dl => `
    <div class="download-item${dl.isNew ? ' new' : ''}">
      <span class="filename">${dl.filename}</span>
      <span class="time">${dl.time}</span>
      <span class="checkmark">✓</span>
    </div>
  `).join('');
}

// Set status
function setStatus(text, type) {
  statusEl.textContent = text;
  statusEl.className = 'status ' + type;
}

// Listen for messages from background
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'nativeStatus') {
    handleNativeStatus(request.data);
    sendResponse({ success: true });
  }

  if (request.action === 'getRecordingState') {
    sendResponse({ recording });
  }

  return true;
});

// Initial state
setStatus('Ready to record', 'ready');
updateQueueDisplay();
updateDownloadsDisplay();
