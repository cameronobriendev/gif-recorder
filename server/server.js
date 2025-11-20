const express = require('express');
const multer = require('multer');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3003;

// Enable CORS for Chrome extension
app.use(cors());
app.use(express.json());

// Storage directories
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'output');

// Ensure directories exist
async function ensureDirectories() {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
}

// Configure multer for WebM uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const jobId = crypto.randomBytes(16).toString('hex');
    cb(null, `${jobId}.webm`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB max
});

// Job status tracking
const jobs = new Map();

// POST /convert - Upload WebM and start conversion
app.post('/convert', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No video file uploaded' });
    }

    const jobId = path.basename(req.file.filename, '.webm');
    const inputPath = req.file.path;
    const outputPath = path.join(OUTPUT_DIR, `${jobId}.gif`);

    // Get conversion options from request
    const fps = parseInt(req.body.fps) || 10;
    const width = parseInt(req.body.width) || 720;
    const quality = req.body.quality || 'medium';

    // Quality settings
    const qualitySettings = {
      low: { colors: 128, dither: 'none' },
      medium: { colors: 256, dither: 'bayer:bayer_scale=3' },
      high: { colors: 256, dither: 'sierra2_4a' }
    };

    const settings = qualitySettings[quality] || qualitySettings.medium;

    // Initialize job status
    jobs.set(jobId, {
      status: 'processing',
      progress: 0,
      inputPath,
      outputPath,
      createdAt: Date.now()
    });

    // Start conversion in background
    convertToGif(jobId, inputPath, outputPath, fps, width, settings);

    res.json({
      jobId,
      status: 'processing',
      message: 'Conversion started'
    });

  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /status/:jobId - Check conversion status
app.get('/status/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  res.json({
    jobId,
    status: job.status,
    progress: job.progress,
    error: job.error
  });
});

// GET /download/:jobId - Download finished GIF
app.get('/download/:jobId', async (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  if (job.status !== 'completed') {
    return res.status(400).json({ error: 'Conversion not complete' });
  }

  try {
    // Check if file exists
    await fs.access(job.outputPath);

    res.download(job.outputPath, `recording-${jobId}.gif`, async (err) => {
      if (err) {
        console.error('Download error:', err);
      }
      // Auto-cleanup after download
      await cleanupJob(jobId);
    });
  } catch (error) {
    res.status(404).json({ error: 'File not found' });
  }
});

// DELETE /cleanup/:jobId - Manual cleanup
app.delete('/cleanup/:jobId', async (req, res) => {
  const { jobId } = req.params;
  await cleanupJob(jobId);
  res.json({ message: 'Cleaned up successfully' });
});

// Convert WebM to GIF using ffmpeg
async function convertToGif(jobId, inputPath, outputPath, fps, width, settings) {
  const job = jobs.get(jobId);

  // FFmpeg command with palette generation for better quality
  // Step 1: Generate color palette
  const paletteCmd = `ffmpeg -i "${inputPath}" -vf "fps=${fps},scale=${width}:-1:flags=lanczos,palettegen=max_colors=${settings.colors}" -y "/tmp/${jobId}_palette.png"`;

  // Step 2: Use palette to create GIF
  const gifCmd = `ffmpeg -i "${inputPath}" -i "/tmp/${jobId}_palette.png" -lavfi "fps=${fps},scale=${width}:-1:flags=lanczos [x]; [x][1:v] paletteuse=dither=${settings.dither}" -y "${outputPath}"`;

  try {
    // Generate palette
    await execPromise(paletteCmd);
    job.progress = 50;

    // Create GIF
    await execPromise(gifCmd);
    job.progress = 100;
    job.status = 'completed';

    // Cleanup palette
    await fs.unlink(`/tmp/${jobId}_palette.png`).catch(() => {});

    console.log(`✅ Conversion complete: ${jobId}`);

  } catch (error) {
    console.error(`❌ Conversion failed: ${jobId}`, error);
    job.status = 'failed';
    job.error = error.message;
  }
}

// Promisified exec
function execPromise(command) {
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });
}

// Cleanup job files
async function cleanupJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;

  try {
    // Delete input WebM
    await fs.unlink(job.inputPath).catch(() => {});

    // Delete output GIF
    await fs.unlink(job.outputPath).catch(() => {});

    // Remove from jobs map
    jobs.delete(jobId);

    console.log(`🗑️  Cleaned up job: ${jobId}`);
  } catch (error) {
    console.error(`Cleanup error for ${jobId}:`, error);
  }
}

// Auto-cleanup old jobs (runs every hour)
setInterval(async () => {
  const now = Date.now();
  const MAX_AGE = 60 * 60 * 1000; // 1 hour

  for (const [jobId, job] of jobs.entries()) {
    if (now - job.createdAt > MAX_AGE) {
      console.log(`⏰ Auto-cleanup expired job: ${jobId}`);
      await cleanupJob(jobId);
    }
  }
}, 60 * 60 * 1000); // Run every hour

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    activeJobs: jobs.size,
    uptime: process.uptime()
  });
});

// Start server
async function start() {
  await ensureDirectories();
  app.listen(PORT, () => {
    console.log(`🎬 GIF Converter API running on port ${PORT}`);
  });
}

start();
