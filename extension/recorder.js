// API endpoint from config
const API_URL = CONFIG.API_URL;

// DOM elements
const statusEl = document.getElementById('status');
const fpsSelect = document.getElementById('fps');
const widthSelect = document.getElementById('width');
const qualitySelect = document.getElementById('quality');
const queueEl = document.getElementById('queue');
const downloadsEl = document.getElementById('downloads');

// State
let recording = false;
let mediaRecorder = null;
let recordedChunks = [];
let mediaStream = null;
let jobQueue = [];
let downloadHistory = [];
let activePolls = new Map();
let currentSiteName = 'recording';

// Cursor tracking
let cursorX = 0;
let cursorY = 0;
let cursorDown = false;
let cursorImage = null;
let videoElement = null;
let canvas = null;
let ctx = null;
let animationId = null;

// Load cursor image
function loadCursorImage() {
  return new Promise((resolve) => {
    cursorImage = new Image();
    cursorImage.onload = () => resolve();
    cursorImage.onerror = () => resolve(); // Continue even if cursor fails to load
    cursorImage.src = 'icons/cursor.png';
  });
}

// Initialize cursor image
loadCursorImage();

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

// Start recording (called via message from background)
async function startRecording(streamId, siteName) {
  try {
    setStatus('Recording...', 'recording');
    currentSiteName = siteName || 'recording';

    // Get media stream using the stream ID from background
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      }
    });

    // Create video element to receive the stream
    videoElement = document.createElement('video');
    videoElement.srcObject = mediaStream;
    videoElement.muted = true;
    await videoElement.play();

    // Wait for video dimensions
    await new Promise(resolve => {
      if (videoElement.videoWidth > 0) {
        resolve();
      } else {
        videoElement.onloadedmetadata = resolve;
      }
    });

    // Create canvas for compositing
    canvas = document.createElement('canvas');
    canvas.width = videoElement.videoWidth;
    canvas.height = videoElement.videoHeight;
    ctx = canvas.getContext('2d');

    // Start drawing loop
    function draw() {
      if (!recording) return;

      // Draw video frame
      ctx.drawImage(videoElement, 0, 0);

      // Draw cursor at tracked position
      if (cursorImage && cursorImage.complete) {
        // Scale cursor position from CSS pixels to video pixels
        const scaleX = canvas.width / videoElement.videoWidth;
        const scaleY = canvas.height / videoElement.videoHeight;
        const x = cursorX * scaleX;
        const y = cursorY * scaleY;

        // Draw cursor (slightly larger if clicked)
        const size = cursorDown ? 24 : 20;
        ctx.drawImage(cursorImage, x, y, size, size);

        // Optional: draw click indicator
        if (cursorDown) {
          ctx.beginPath();
          ctx.arc(x + 3, y + 3, 15, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(255, 100, 100, 0.5)';
          ctx.lineWidth = 3;
          ctx.stroke();
        }
      }

      animationId = requestAnimationFrame(draw);
    }
    draw();

    // Capture the canvas as a stream
    const fps = parseInt(fpsSelect.value) || 10;
    const canvasStream = canvas.captureStream(fps);

    // Setup MediaRecorder with canvas stream
    recordedChunks = [];
    const options = { mimeType: 'video/webm;codecs=vp9' };
    if (!MediaRecorder.isTypeSupported(options.mimeType)) {
      options.mimeType = 'video/webm';
    }

    mediaRecorder = new MediaRecorder(canvasStream, options);

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        recordedChunks.push(event.data);
      }
    };

    mediaRecorder.onstop = async () => {
      // Stop animation loop
      if (animationId) {
        cancelAnimationFrame(animationId);
        animationId = null;
      }

      // Stop streams
      mediaStream.getTracks().forEach(track => track.stop());
      canvasStream.getTracks().forEach(track => track.stop());

      // Clean up
      videoElement = null;
      canvas = null;
      ctx = null;

      // Create blob and upload
      const webmBlob = new Blob(recordedChunks, { type: 'video/webm' });
      await uploadAndConvert(webmBlob);
    };

    mediaRecorder.start(100);
    recording = true;

  } catch (error) {
    console.error('Start recording error:', error);
    setStatus('Error: ' + error.message, 'ready');
    chrome.runtime.sendMessage({ action: 'recordingError', error: error.message });
  }
}

// Stop recording (called via message from background)
async function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }

  recording = false;
  setStatus('Processing...', 'processing');
}

// Upload and convert
async function uploadAndConvert(webmBlob) {
  try {
    setStatus('Uploading...', 'processing');

    const formData = new FormData();
    formData.append('video', webmBlob, 'recording.webm');
    formData.append('fps', fpsSelect.value);
    formData.append('width', widthSelect.value);
    formData.append('quality', qualitySelect.value);

    const response = await fetch(`${API_URL}/convert`, {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      throw new Error('Upload failed');
    }

    const data = await response.json();

    // Add to queue
    const job = {
      id: data.jobId,
      progress: 0,
      status: 'processing',
      startTime: Date.now()
    };
    jobQueue.push(job);
    updateQueueDisplay();

    // Start polling
    pollJobStatus(job);

    setStatus('Ready to record', 'ready');

  } catch (error) {
    console.error('Upload error:', error);
    setStatus('Upload failed: ' + error.message, 'ready');
  }
}

// Poll job status
function pollJobStatus(job) {
  const pollInterval = setInterval(async () => {
    try {
      const response = await fetch(`${API_URL}/status/${job.id}`);
      const data = await response.json();

      job.progress = data.progress;
      job.status = data.status;
      updateQueueDisplay();

      if (data.status === 'completed') {
        clearInterval(pollInterval);
        activePolls.delete(job.id);

        // Auto-download with site name and datetime
        const now = new Date();
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const month = months[now.getMonth()];
        const day = now.getDate();
        const year = now.getFullYear();
        let hours = now.getHours();
        const minutes = now.getMinutes().toString().padStart(2, '0');
        const ampm = hours >= 12 ? 'pm' : 'am';
        hours = hours % 12 || 12;
        const datetime = `${month}${day}-${year}-${hours}${minutes}${ampm}`;
        const filename = `${currentSiteName}_${datetime}.gif`;
        await autoDownload(job, filename);

        // Move to history
        jobQueue = jobQueue.filter(j => j.id !== job.id);
        downloadHistory.unshift({
          id: job.id,
          filename: filename,
          time: new Date().toLocaleTimeString(),
          isNew: true
        });

        updateQueueDisplay();
        updateDownloadsDisplay();
        setStatus('Download complete!', 'ready');

        // Remove "new" highlight after animation
        setTimeout(() => {
          if (downloadHistory[0]) {
            downloadHistory[0].isNew = false;
            updateDownloadsDisplay();
          }
        }, 2000);

      } else if (data.status === 'failed') {
        clearInterval(pollInterval);
        activePolls.delete(job.id);
        job.status = 'failed';
        job.error = data.error;
        updateQueueDisplay();
      }
    } catch (error) {
      console.error('Poll error:', error);
    }
  }, 2000);

  activePolls.set(job.id, pollInterval);
}

// Auto-download
async function autoDownload(job, filename) {
  try {
    chrome.downloads.download({
      url: `${API_URL}/download/${job.id}`,
      filename: filename,
      saveAs: false
    });
  } catch (error) {
    console.error('Download error:', error);
  }
}

// Update queue display
function updateQueueDisplay() {
  if (jobQueue.length === 0) {
    queueEl.innerHTML = '<div class="empty-message">No recordings in queue</div>';
    return;
  }

  queueEl.innerHTML = jobQueue.map(job => `
    <div class="queue-item">
      <div class="info">
        <div class="job-id">${job.id.substring(0, 8)}...</div>
      </div>
      <div class="progress-bar">
        <div class="progress-fill" style="width: ${job.progress}%"></div>
      </div>
      <span class="status-text">${job.progress}%</span>
    </div>
  `).join('');
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
  if (request.action === 'startRecording') {
    startRecording(request.streamId, request.siteName);
    sendResponse({ success: true });
  }

  if (request.action === 'stopRecording') {
    stopRecording();
    sendResponse({ success: true });
  }

  if (request.action === 'getRecordingState') {
    sendResponse({ recording });
  }

  // Cursor tracking events
  if (request.action === 'cursorMove') {
    cursorX = request.x;
    cursorY = request.y;
  }

  if (request.action === 'cursorDown') {
    cursorDown = true;
    cursorX = request.x;
    cursorY = request.y;
  }

  if (request.action === 'cursorUp') {
    cursorDown = false;
  }
});
