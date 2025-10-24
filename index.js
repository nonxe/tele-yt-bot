const { Telegraf, Markup } = require('telegraf');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const https = require('https');
const http = require('http');

// Initialize bot
const bot = new Telegraf(process.env.BOT_TOKEN);

// API Configuration
const API_BASE_URL = 'https://for-devs.ddns.net/api/downloader/youtube';
const API_KEY = process.env.API_KEY || '.r-e406e8b5fc4e447112d95703';

// Temp directory for downloads
const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR);
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

// Extract video ID from URL
function extractVideoId(url) {
  try {
    const urlObj = new URL(url);
    if (urlObj.hostname === 'youtu.be') {
      return urlObj.pathname.slice(1);
    }
    return urlObj.searchParams.get('v');
  } catch {
    return null;
  }
}

// Get video info from API
async function getVideoInfo(url) {
  try {
    const apiUrl = `${API_BASE_URL}?url=${encodeURIComponent(url)}&apikey=${API_KEY}`;
    
    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`API returned status ${response.status}`);
    }

    const data = await response.json();
    
    if (!data.status || data.status === 'error') {
      throw new Error(data.message || 'Failed to fetch video info');
    }

    return data;
  } catch (error) {
    throw new Error(`Failed to fetch video info: ${error.message}`);
  }
}

// Download file from URL
async function downloadFile(url, outputPath) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    
    const file = fs.createWriteStream(outputPath);
    
    protocol.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download: ${response.statusCode}`));
        return;
      }
      
      response.pipe(file);
      
      file.on('finish', () => {
        file.close();
        resolve();
      });
    }).on('error', (err) => {
      fs.unlink(outputPath, () => {});
      reject(err);
    });
    
    file.on('error', (err) => {
      fs.unlink(outputPath, () => {});
      reject(err);
    });
  });
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
    '✅ Fast and reliable API\n' +
    '✅ No bot detection issues\n\n' +
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
    '⚠️ *Note:* Files larger than 50MB may fail due to Telegram limits.',
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
    const data = await getVideoInfo(url);
    
    if (!data.result || !data.result.formats) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        processingMsg.message_id,
        null,
        '❌ No downloadable formats found for this video.'
      );
      return;
    }

    const result = data.result;
    const videoId = extractVideoId(url);
    
    // Create buttons for quality options
    const buttons = [];
    
    // Video quality buttons (get unique qualities)
    const videoFormats = result.formats.filter(f => f.quality && f.hasVideo && f.hasAudio);
    const uniqueQualities = [...new Set(videoFormats.map(f => f.quality))];
    
    uniqueQualities.slice(0, 5).forEach(quality => {
      buttons.push([Markup.button.callback(`📹 ${quality}`, `video_${quality}_${videoId}`)]);
    });
    
    // Audio only button
    buttons.push([Markup.button.callback('🎵 Audio Only (MP3)', `audio_${videoId}`)]);
    
    const title = result.title || 'Unknown Title';
    const duration = formatDuration(result.duration);
    const views = result.viewCount ? parseInt(result.viewCount).toLocaleString() : 'Unknown';
    
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      processingMsg.message_id,
      null,
      `*${title}*\n\n` +
      `⏱ Duration: ${duration}\n` +
      `👁 Views: ${views}\n` +
      `📺 Channel: ${result.channel || 'Unknown'}\n\n` +
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
  const parts = data.split('_');
  const type = parts[0];
  const quality = parts[1];
  const videoId = parts[2];
  
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
    await ctx.editMessageText('⏳ Fetching download link...');
    
    const data = await getVideoInfo(url);
    
    if (!data.result || !data.result.formats) {
      throw new Error('No formats available');
    }
    
    // Find the format with requested quality
    const format = data.result.formats.find(f => 
      f.quality === quality && f.hasVideo && f.hasAudio
    );
    
    if (!format || !format.url) {
      throw new Error('Selected quality not available');
    }
    
    await ctx.editMessageText('⬇️ Downloading video...');
    
    // Download the file
    await downloadFile(format.url, outputPath);
    
    // Check file size
    const stats = fs.statSync(outputPath);
    const fileSizeMB = stats.size / (1024 * 1024);
    
    if (fileSizeMB > 50) {
      await ctx.editMessageText(`❌ File too large (${fileSizeMB.toFixed(2)}MB).\n\nTelegram limit is 50MB.\nTry a lower quality or audio-only.`);
      fs.unlinkSync(outputPath);
      return;
    }
    
    await ctx.editMessageText(`⬆️ Uploading to Telegram (${fileSizeMB.toFixed(2)}MB)...`);
    
    await ctx.replyWithVideo(
      { source: outputPath },
      { 
        caption: `${data.result.title || 'Video'}\n\n📹 Quality: ${quality}`,
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
    await ctx.editMessageText('⏳ Fetching download link...');
    
    const data = await getVideoInfo(url);
    
    if (!data.result || !data.result.formats) {
      throw new Error('No formats available');
    }
    
    // Find audio format
    const audioFormat = data.result.formats.find(f => 
      f.hasAudio && !f.hasVideo
    ) || data.result.formats.find(f => f.hasAudio);
    
    if (!audioFormat || !audioFormat.url) {
      throw new Error('Audio format not available');
    }
    
    await ctx.editMessageText('⬇️ Downloading audio...');
    
    // Download the file
    await downloadFile(audioFormat.url, outputPath);
    
    // Check file size
    const stats = fs.statSync(outputPath);
    const fileSizeMB = stats.size / (1024 * 1024);
    
    if (fileSizeMB > 50) {
      await ctx.editMessageText(`❌ File too large (${fileSizeMB.toFixed(2)}MB).\n\nTelegram limit is 50MB.`);
      fs.unlinkSync(outputPath);
      return;
    }
    
    await ctx.editMessageText(`⬆️ Uploading to Telegram (${fileSizeMB.toFixed(2)}MB)...`);
    
    await ctx.replyWithAudio(
      { source: outputPath },
      {
        caption: `🎵 ${data.result.title || 'Audio'}`,
        title: data.result.title || 'Audio',
        performer: data.result.channel || 'Unknown'
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
console.log('🤖 Bot starting...');
bot.launch()
  .then(() => console.log('✅ Bot started successfully!'))
  .catch(err => {
    console.error('❌ Failed to start bot:', err);
    process.exit(1);
  });

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
