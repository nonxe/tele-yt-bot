const { Telegraf, Markup } = require('telegraf');
const YTDlpWrap = require('yt-dlp-wrap').default;
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { exec } = require('child_process');
const { promisify } = require('util');

const execPromise = promisify(exec);

// Initialize bot
const bot = new Telegraf(process.env.BOT_TOKEN);

// Temp directory for downloads
const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR);
}

// Initialize yt-dlp
let ytDlp;
const YTDLP_PATH = path.join(__dirname, 'yt-dlp');

// Download and setup yt-dlp on startup
async function setupYtDlp() {
  try {
    console.log('🔧 Setting up yt-dlp...');
    
    // Download yt-dlp binary
    ytDlp = new YTDlpWrap();
    await YTDlpWrap.downloadFromGithub(YTDLP_PATH);
    ytDlp = new YTDlpWrap(YTDLP_PATH);
    
    // Make it executable
    if (process.platform !== 'win32') {
      await execPromise(`chmod +x ${YTDLP_PATH}`);
    }
    
    console.log('✅ yt-dlp ready!');
  } catch (error) {
    console.error('❌ Failed to setup yt-dlp:', error);
    process.exit(1);
  }
}

// Cleanup old files
function cleanupOldFiles() {
  try {
    const files = fs.readdirSync(TEMP_DIR);
    const now = Date.now();
    files.forEach(file => {
      const filePath = path.join(TEMP_DIR, file);
      try {
        const stats = fs.statSync(filePath);
        // Delete files older than 10 minutes
        if (now - stats.mtimeMs > 10 * 60 * 1000) {
          fs.unlinkSync(filePath);
        }
      } catch (err) {
        // File might have been deleted already
      }
    });
  } catch (error) {
    console.error('Cleanup error:', error);
  }
}

// Run cleanup every 5 minutes
setInterval(cleanupOldFiles, 5 * 60 * 1000);

// Validate YouTube URL
function isValidYouTubeUrl(url) {
  try {
    const urlObj = new URL(url);
    return (
      (urlObj.hostname === 'www.youtube.com' || urlObj.hostname === 'youtube.com' || 
       urlObj.hostname === 'youtu.be' || urlObj.hostname === 'm.youtube.com') &&
      (urlObj.pathname.includes('/watch') || urlObj.pathname.includes('/shorts') || 
       urlObj.hostname === 'youtu.be')
    );
  } catch {
    return false;
  }
}

// Get video info using yt-dlp with anti-bot measures
async function getVideoInfo(url) {
  try {
    const info = await ytDlp.execPromise([
      url,
      '--dump-json',
      '--no-warnings',
      '--no-playlist',
      '--extractor-args', 'youtube:player_client=android,web',
      '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      '--add-header', 'Accept-Language:en-US,en;q=0.9',
      '--add-header', 'Accept:text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      '--add-header', 'Sec-Fetch-Mode:navigate'
    ]);
    return JSON.parse(info);
  } catch (error) {
    throw new Error(`Failed to fetch video info: ${error.message}`);
  }
}

// Get available quality options
function getQualityOptions(info) {
  const formats = info.formats || [];
  
  // Filter video+audio formats
  const videoFormats = formats.filter(f => 
    f.vcodec !== 'none' && 
    f.acodec !== 'none' && 
    f.height
  );
  
  // Get unique heights
  const heights = [...new Set(videoFormats.map(f => f.height))];
  
  // Sort descending
  heights.sort((a, b) => b - a);
  
  // Convert to quality labels and limit to 5
  return heights.slice(0, 5).map(h => `${h}p`);
}

// Format file size
function formatSize(bytes) {
  if (!bytes) return 'Unknown';
  const mb = bytes / (1024 * 1024);
  return mb.toFixed(2) + ' MB';
}

// Format duration
function formatDuration(seconds) {
  if (!seconds) return 'Unknown';
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Start command
bot.start((ctx) => {
  ctx.reply(
    '👋 *Welcome to YouTube Downloader Bot!*\n\n' +
    '📹 Send me a YouTube link and I\'ll help you download it.\n\n' +
    '*Features:*\n' +
    '✅ Multiple quality options\n' +
    '✅ Audio-only MP3 download\n' +
    '✅ Fast and reliable (using yt-dlp)\n' +
    '✅ Works with all YouTube videos\n\n' +
    'Just send me a YouTube URL to get started!',
    { parse_mode: 'Markdown' }
  );
});

// Help command
bot.help((ctx) => {
  ctx.reply(
    '*How to use:*\n\n' +
    '1️⃣ Send me a YouTube video URL\n' +
    '2️⃣ Choose video quality or audio-only\n' +
    '3️⃣ Wait for the download to complete\n' +
    '4️⃣ Receive your file!\n\n' +
    '*Supported URLs:*\n' +
    '• youtube.com/watch?v=...\n' +
    '• youtu.be/...\n' +
    '• youtube.com/shorts/...\n\n' +
    '⚠️ *Note:* Files larger than 50MB may fail due to Telegram limits.\n' +
    'Use lower quality or audio-only for large videos.',
    { parse_mode: 'Markdown' }
  );
});

// Download command
bot.command('download', async (ctx) => {
  const url = ctx.message.text.split(' ')[1];
  if (!url) {
    return ctx.reply('❌ Please provide a YouTube URL\nExample: /download https://youtube.com/watch?v=...');
  }
  await handleYouTubeUrl(ctx, url);
});

// Handle text messages (YouTube URLs)
bot.on('text', async (ctx) => {
  const text = ctx.message.text;
  
  if (text.startsWith('/')) return; // Ignore commands
  
  if (isValidYouTubeUrl(text)) {
    await handleYouTubeUrl(ctx, text);
  } else {
    ctx.reply('❌ Please send a valid YouTube URL');
  }
});

// Main YouTube URL handler
async function handleYouTubeUrl(ctx, url) {
  const processingMsg = await ctx.reply('⏳ Fetching video information...');
  
  try {
    const info = await getVideoInfo(url);
    const qualities = getQualityOptions(info);
    
    if (qualities.length === 0) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        processingMsg.message_id,
        null,
        '❌ No downloadable formats found for this video.'
      );
      return;
    }
    
    // Create buttons for quality options
    const buttons = [];
    
    // Video quality buttons
    qualities.forEach(quality => {
      buttons.push([Markup.button.callback(`📹 ${quality}`, `video_${quality}_${info.id}`)]);
    });
    
    // Audio only button
    buttons.push([Markup.button.callback('🎵 Audio Only (MP3)', `audio_${info.id}`)]);
    
    const title = info.title || 'Unknown Title';
    const duration = formatDuration(info.duration);
    const views = info.view_count ? parseInt(info.view_count).toLocaleString() : 'Unknown';
    
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      processingMsg.message_id,
      null,
      `*${title}*\n\n` +
      `⏱ Duration: ${duration}\n` +
      `👁 Views: ${views}\n\n` +
      `Select quality:`,
      {
        parse_mode: 'Markdown',
        reply_markup: Markup.inlineKeyboard(buttons).reply_markup
      }
    );
    
  } catch (error) {
    console.error('Error:', error);
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      processingMsg.message_id,
      null,
      `❌ Error: ${error.message}\n\nTry again or use a different video.`
    );
  }
}

// Handle callback queries (button clicks)
bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery.data;
  const [type, quality, videoId] = data.split('_');
  
  await ctx.answerCbQuery();
  await ctx.editMessageText('⏳ Preparing download... Please wait...');
  
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  
  try {
    if (type === 'audio') {
      await downloadAudio(ctx, videoUrl, videoId);
    } else if (type === 'video') {
      await downloadVideo(ctx, videoUrl, quality, videoId);
    }
  } catch (error) {
    console.error('Download error:', error);
    await ctx.editMessageText(
      `❌ Download failed: ${error.message}\n\n` +
      `Possible reasons:\n` +
      `• File too large (>50MB)\n` +
      `• Network issue\n` +
      `• Video unavailable\n\n` +
      `Try a different quality or video.`
    );
  }
});

// Download video
async function downloadVideo(ctx, url, quality, videoId) {
  const sanitizedId = videoId.replace(/[^a-zA-Z0-9_-]/g, '');
  const outputPath = path.join(TEMP_DIR, `${sanitizedId}_${quality}.mp4`);
  
  try {
    await ctx.editMessageText('⬇️ Downloading video...');
    
    const height = quality.replace('p', '');
    
    // Download with yt-dlp with anti-bot measures
    await ytDlp.execPromise([
      url,
      '-f', `bestvideo[height<=${height}]+bestaudio/best[height<=${height}]/best`,
      '--merge-output-format', 'mp4',
      '-o', outputPath,
      '--no-playlist',
      '--no-warnings',
      '--extractor-args', 'youtube:player_client=android,web',
      '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      '--add-header', 'Accept-Language:en-US,en;q=0.9',
      '--add-header', 'Accept:text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      '--concurrent-fragments', '5',
      '--newline'
    ]);
    
    // Check if file exists and size
    if (!fs.existsSync(outputPath)) {
      throw new Error('Download failed - file not created');
    }
    
    const stats = fs.statSync(outputPath);
    const fileSizeMB = stats.size / (1024 * 1024);
    
    if (fileSizeMB > 50) {
      await ctx.editMessageText(`❌ File too large (${fileSizeMB.toFixed(2)}MB).\n\nTelegram limit is 50MB.\nTry a lower quality or audio-only.`);
      fs.unlinkSync(outputPath);
      return;
    }
    
    await ctx.editMessageText(`⬆️ Uploading to Telegram (${fileSizeMB.toFixed(2)}MB)...`);
    
    const info = await getVideoInfo(url);
    
    await ctx.replyWithVideo(
      { source: outputPath },
      { 
        caption: `${info.title || 'Video'}\n\n📹 Quality: ${quality}`,
        supports_streaming: true
      }
    );
    
    await ctx.deleteMessage();
    fs.unlinkSync(outputPath);
    
  } catch (error) {
    if (fs.existsSync(outputPath)) {
      fs.unlinkSync(outputPath);
    }
    throw error;
  }
}

// Download audio
async function downloadAudio(ctx, url, videoId) {
  const sanitizedId = videoId.replace(/[^a-zA-Z0-9_-]/g, '');
  const outputPath = path.join(TEMP_DIR, `${sanitizedId}.mp3`);
  
  try {
    await ctx.editMessageText('⬇️ Downloading audio...');
    
    // Download and convert to MP3 with yt-dlp with anti-bot measures
    await ytDlp.execPromise([
      url,
      '-f', 'bestaudio/best',
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', '192K',
      '-o', outputPath,
      '--no-playlist',
      '--no-warnings',
      '--extractor-args', 'youtube:player_client=android,web',
      '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      '--add-header', 'Accept-Language:en-US,en;q=0.9',
      '--concurrent-fragments', '5',
      '--newline'
    ]);
    
    if (!fs.existsSync(outputPath)) {
      throw new Error('Download failed - file not created');
    }
    
    const stats = fs.statSync(outputPath);
    const fileSizeMB = stats.size / (1024 * 1024);
    
    if (fileSizeMB > 50) {
      await ctx.editMessageText(`❌ File too large (${fileSizeMB.toFixed(2)}MB).\n\nTelegram limit is 50MB.`);
      fs.unlinkSync(outputPath);
      return;
    }
    
    await ctx.editMessageText(`⬆️ Uploading to Telegram (${fileSizeMB.toFixed(2)}MB)...`);
    
    const info = await getVideoInfo(url);
    
    await ctx.replyWithAudio(
      { source: outputPath },
      {
        caption: `🎵 ${info.title || 'Audio'}`,
        title: info.title || 'Audio',
        performer: info.uploader || 'Unknown'
      }
    );
    
    await ctx.deleteMessage();
    fs.unlinkSync(outputPath);
    
  } catch (error) {
    if (fs.existsSync(outputPath)) {
      fs.unlinkSync(outputPath);
    }
    throw error;
  }
}

// Error handler
bot.catch((err, ctx) => {
  console.error('Bot error:', err);
  try {
    ctx.reply('❌ An error occurred. Please try again later.');
  } catch (e) {
    console.error('Failed to send error message:', e);
  }
});

// Start bot
async function startBot() {
  try {
    console.log('🤖 Starting bot...');
    
    // Setup yt-dlp first
    await setupYtDlp();
    
    // Then launch bot
    await bot.launch();
    console.log('✅ Bot started successfully!');
    
    // Enable graceful stop
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
    
  } catch (error) {
    console.error('❌ Failed to start bot:', error);
    process.exit(1);
  }
}

// Start everything
startBot();
