# GIF Recorder

Chrome extension that records screen content and converts to GIF using server-side processing.

![Settings Page](settings.png)

## Features

- Record any tab, window, or screen with one click
- Server-side WebM to GIF conversion (ffmpeg with palette optimization)
- Animated icon shows recording state (green = ready, red pulse = recording)
- Auto-download with smart filenames: `site-name_Nov20-2025-230pm.gif`
- Queue system for multiple recordings
- Configurable FPS, resolution, and quality
- Settings persist between sessions

## Components

### `/extension` - Chrome Extension
- Records screen content using `navigator.mediaDevices.getDisplayMedia`
- Uploads WebM to server for conversion
- Auto-downloads completed GIFs

### `/server` - Conversion API
- Express server with ffmpeg
- Converts WebM to GIF with palette optimization
- Background job processing with progress tracking
- Auto-cleanup after 1 hour

## Quick Start

### 1. Deploy Server

```bash
# Copy to your server
scp -r server/* root@YOUR_IP:/var/www/gif-converter-api/

# SSH and install
ssh root@YOUR_IP
cd /var/www/gif-converter-api
apt install ffmpeg  # if not installed
npm install
pm2 start ecosystem.config.cjs
pm2 save
```

### 2. Configure Extension

```bash
cd extension
cp config.example.js config.js
```

Edit `config.js` with your server URL:
```javascript
const CONFIG = {
  API_URL: 'http://YOUR_IP:3005'
};
```

### 3. Load Extension

1. Open Chrome/Vivaldi: `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select the `extension/` folder

## Usage

1. **Click extension icon** - Opens settings tab
2. **Click Record button** - System picker dialog appears
3. **Select what to record** - Choose tab, window, or entire screen
4. **Recording starts** - Button changes to "Stop" with pulsing indicator
5. **Click Stop** - Recording ends, upload begins
6. **GIF auto-downloads** when conversion completes

You can also click the extension icon while recording to stop.

## Settings

- **FPS**: 5/10/15 fps (default: 10)
- **Width**: 480p/720p/1080p (default: 720p)
- **Quality**: Low/Medium/High (default: Medium)

Defaults are optimized for GitHub READMEs. Settings persist between recordings.

## Architecture

```
Click Record → getDisplayMedia Picker → MediaRecorder → WebM Upload → Server (ffmpeg) → GIF Download
```

## Technical Challenges & Solutions

### Cursor Position Offset on macOS Retina

**Problem**: When using `chrome.tabCapture` API on macOS Retina displays, cursor position had vertical offset errors. The cursor appeared compressed toward the vertical center - the further from center, the larger the error.

**Root Cause**: Chrome's tabCapture coordinate transformation pipeline has vertical-specific bugs:
- Browser chrome offset calculation (no horizontal equivalent)
- Y-axis coordinate system inversion between macOS (bottom-left origin) and browser (top-left origin)
- CSS pixels vs physical pixels ambiguity with devicePixelRatio

**Solution**: Switched from `tabCapture` to `getDisplayMedia()` API which handles cursor coordinate transformations correctly. This is the same approach used by professional tools like Loom. Trade-off: requires user to select capture target via system picker.

### WebM Duration Metadata Missing

**Problem**: MediaRecorder creates WebM files without proper duration metadata (`Duration: N/A`), causing ffmpeg to fail with exit code 190.

**Solution**: Server now handles WebM files without duration gracefully - ffmpeg can still process them, duration is estimated from frame count.

### Dynamic Resolution During Recording

**Problem**: When recording windows that resize, the video resolution changes mid-stream (e.g., 1454x766 → 1454x724), causing ffmpeg filter graph error: "Internal bug, should not have happened."

**Root Cause**: The two-pass palette generation approach fails when resolution changes between passes because the palette was generated for the original resolution.

**Solution**: Switched to single-pass conversion using ffmpeg's `split` filter:
```bash
-vf "fps=10,scale=720:-1:flags=lanczos:force_original_aspect_ratio=decrease,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse"
```
This generates the palette and applies it in one pass, handling resolution changes gracefully.

### Background Tab Throttling

**Problem**: When using canvas overlay approach with `requestAnimationFrame`, recording would produce 0 frames because rAF pauses when tab loses focus.

**Solution**: Use `setInterval` instead of `requestAnimationFrame` for any processing that needs to continue in background tabs.

### getDisplayMedia Must Be Called from Focused Page

**Problem**: Wanted to keep user on their current tab while showing the capture picker, but `getDisplayMedia()` requires the calling page to be focused and visible.

**Solution**: Extension switches to recorder tab before triggering getDisplayMedia. Added convenient Record button on the settings page so users don't need to click the extension icon twice.

## Server Requirements

- Node.js 18+
- ffmpeg installed
- PM2 for process management

## Server Endpoints

- `POST /convert` - Upload WebM for conversion
- `GET /status/:jobId` - Check job progress (1% increments)
- `GET /download/:jobId` - Download completed GIF
- `DELETE /cleanup/:jobId` - Manual cleanup

## License

MIT
