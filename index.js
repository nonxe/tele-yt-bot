const TelegramBot = require('node-telegram-bot-api');
const play = require('play-dl');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');

// Set ffmpeg path
ffmpeg.setFfmpegPath(ffmpegPath);

// Initialize bot
const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('❌ BOT_TOKEN is not set! Please set it in environment variables.');
  process.exit(1);
}

const bot = new TelegramBot(token, { 
  polling: true,
  filepath: false // Disable filepath to avoid issues
});

// Constants
const TEMP_DIR = path.join(__dirname, 'temp');
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB for Telegram
const DOWNLOAD_TIMEOUT = 300000; // 5 minutes

// Create temp directory if it doesn't exist
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Store active downloads to prevent duplicates
const activeDownloads = new Set();

// ============================================
// UTILITY FUNCTIONS
// ============================================

/**
 * Clean up temporary files
 */
function cleanup(...filePaths) {
  filePaths.forEach(filePath => {
    try {
      if (filePath && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`🗑️ Cleaned up: ${path.basename(filePath)}`);
      }
    } catch (err) {
      console.error(`Error cleaning up ${filePath}:`, err.message);
    }
  });
}

/**
 * Format file size
 */
function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

/**
 * Format duration
 */
function formatDuration(seconds) {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

/**
 * Escape markdown special characters
 */
function escapeMarkdown(text) {
  return text.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
}

/**
 * Get file size
 */
function getFileSize(filePath) {
  try {
    const stats = fs.statSync(filePath);
    return stats.size;
  } catch (err) {
    return 0;
  }
}

// ============================================
// BOT COMMANDS
// ============================================

/**
 * /start command
 */
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const firstName = msg.from.first_name || 'User';
  
  const welcomeMessage = `
👋 *Welcome ${escapeMarkdown(firstName)}!*

I'm a YouTube Downloader Bot\\. Send me any YouTube link and I'll help you download it\\!

*🎯 Features:*
• Multiple quality options
• Audio\\-only downloads \\(MP3\\)
• Fast processing
• Progress tracking

*📝 How to use:*
Just send me a YouTube link or use:
\`/download <youtube\\_url>\`

*Commands:*
/help \\- Show detailed help
/about \\- About this bot
/stats \\- Bot statistics

*Let's get started\\!* 🚀
  `.trim();
  
  bot.sendMessage(chatId, welcomeMessage, { 
    parse_mode: 'MarkdownV2',
    disable_web_page_preview: true 
  });
});

/**
 * /help command
 */
bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  
  const helpMessage = `
*📚 Help & Usage Guide*

*How to download:*
1\\. Send me any YouTube link
2\\. Choose quality or audio\\-only
3\\. Wait for download to complete
4\\. Enjoy\\!

*Supported formats:*
• youtube\\.com/watch?v=xxxxx
• youtu\\.be/xxxxx
• youtube\\.com/shorts/xxxxx

*Quality options:*
📹 360p, 480p, 720p, 1080p
🎵 Audio Only \\(MP3\\)

*Commands:*
/start \\- Welcome message
/help \\- This help message
/download <url> \\- Download video
/about \\- About bot
/stats \\- Statistics

*⚠️ Important Notes:*
• Telegram has a 50MB file size limit
• Large files may take time to process
• If download fails, try lower quality
• Only one download at a time per user

*Need help?* Just send a YouTube link\\!
  `.trim();
  
  bot.sendMessage(chatId, helpMessage, { 
    parse_mode: 'MarkdownV2',
    disable_web_page_preview: true 
  });
});

/**
 * /about command
 */
bot.onText(/\/about/, (msg) => {
  const chatId = msg.chat.id;
  
  const aboutMessage = `
*🤖 About This Bot*

*YouTube Downloader Bot*
Version: 2\\.0\\.0
Last Updated: October 2024

*Built with:*
• Node\\.js
• play\\-dl \\(YouTube handler\\)
• node\\-telegram\\-bot\\-api
• ffmpeg \\(audio processing\\)

*Features:*
✅ Fast downloads
✅ Multiple qualities
✅ Audio extraction
✅ Progress tracking
✅ Clean interface

*Developer:* @YourUsername
*Source Code:* GitHub

Made with ❤️ for YouTube lovers\\!
  `.trim();
  
  bot.sendMessage(chatId, aboutMessage, { 
    parse_mode: 'MarkdownV2',
    disable_web_page_preview: true 
  });
});

/**
 * /stats command
 */
bot.onText(/\/stats/, (msg) => {
  const chatId = msg.chat.id;
  
  const uptime = process.uptime();
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  
  const statsMessage = `
*📊 Bot Statistics*

*System Info:*
• Uptime: ${hours}h ${minutes}m
• Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB
• Active Downloads: ${activeDownloads.size}

*Status:* 🟢 Online
  `.trim();
  
  bot.sendMessage(chatId, statsMessage, { parse_mode: 'MarkdownV2' });
});

/**
 * /download command
 */
bot.onText(/\/download (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const url = match[1].trim();
  
  await handleYouTubeLink(chatId, url, msg.from.id);
});

// ============================================
// MESSAGE HANDLER
// ============================================

/**
 * Handle all messages (looking for YouTube links)
 */
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  
  const chatId = msg.chat.id;
  const text = msg.text;
  
  // YouTube URL regex
  const youtubeRegex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
  const match = text.match(youtubeRegex);
  
  if (match) {
    await handleYouTubeLink(chatId, text, msg.from.id);
  }
});

// ============================================
// YOUTUBE LINK HANDLER
// ============================================

/**
 * Main function to handle YouTube links
 */
async function handleYouTubeLink(chatId, url, userId) {
  const downloadKey = `${userId}_${url}`;
  
  // Check if already downloading
  if (activeDownloads.has(downloadKey)) {
    await bot.sendMessage(chatId, '⚠️ You already have an active download for this video. Please wait...');
    return;
  }
  
  const statusMsg = await bot.sendMessage(chatId, '⏳ Fetching video info...');
  
  try {
    // Validate URL
    const isValid = play.yt_validate(url);
    
    if (isValid !== 'video') {
      await bot.editMessageText('❌ Invalid YouTube URL. Please send a valid video link.', {
        chat_id: chatId,
        message_id: statusMsg.message_id
      });
      return;
    }
    
    // Get video info
    const info = await play.video_info(url);
    const videoDetails = info.video_details;
    
    // Check video duration (limit to 1 hour for safety)
    if (videoDetails.durationInSec > 3600) {
      await bot.editMessageText('❌ Video is too long (max 1 hour). Please try a shorter video.', {
        chat_id: chatId,
        message_id: statusMsg.message_id
      });
      return;
    }
    
    // Get available formats
    const formats = info.format;
    const availableQualities = [];
    
    // Standard qualities to check
    const qualityOptions = [
      { label: '1080p', value: 1080 },
      { label: '720p', value: 720 },
      { label: '480p', value: 480 },
      { label: '360p', value: 360 }
    ];
    
    // Check which qualities are available
    for (const quality of qualityOptions) {
      const format = formats.find(f => 
        f.qualityLabel && f.qualityLabel.includes(quality.label)
      );
      if (format) {
        availableQualities.push({
          text: `📹 ${quality.label}`,
          callback_data: `video_${quality.label}_${url}`
        });
      }
    }
    
    // Create keyboard
    const keyboard = {
      inline_keyboard: []
    };
    
    // Add quality buttons (2 per row)
    for (let i = 0; i < availableQualities.length; i += 2) {
      const row = [availableQualities[i]];
      if (i + 1 < availableQualities.length) {
        row.push(availableQualities[i + 1]);
      }
      keyboard.inline_keyboard.push(row);
    }
    
    // Add audio option
    keyboard.inline_keyboard.push([{
      text: '🎵 Audio Only (MP3)',
      callback_data: `audio_${url}`
    }]);
    
    // Format video info message
    const views = videoDetails.views ? videoDetails.views.toLocaleString() : 'N/A';
    const likes = videoDetails.likes ? videoDetails.likes.toLocaleString() : 'N/A';
    const duration = formatDuration(videoDetails.durationInSec);
    
    const infoMessage = `
*📺 Video Found\\!*

*Title:* ${escapeMarkdown(videoDetails.title.substring(0, 100))}
*Channel:* ${escapeMarkdown(videoDetails.channel.name)}
*Duration:* ${duration}
*Views:* ${views}
*Likes:* ${likes}

*Select quality to download:*
    `.trim();
    
    await bot.editMessageText(infoMessage, {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      parse_mode: 'MarkdownV2',
      reply_markup: keyboard
    });
    
  } catch (error) {
    console.error('Error fetching video info:', error);
    
    let errorMessage = '❌ Failed to fetch video info\\.\n\n';
    
    if (error.message.includes('private')) {
      errorMessage += 'This video is private or unavailable\\.';
    } else if (error.message.includes('age')) {
      errorMessage += 'This video is age\\-restricted\\.';
    } else if (error.message.includes('copyright')) {
      errorMessage += 'This video has copyright restrictions\\.';
    } else {
      errorMessage += 'Please try again or use a different video\\.';
    }
    
    await bot.editMessageText(errorMessage, {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      parse_mode: 'MarkdownV2'
    });
  }
}

// ============================================
// CALLBACK QUERY HANDLER
// ============================================

/**
 * Handle button clicks
 */
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  const userId = query.from.id;
  
  await bot.answerCallbackQuery(query.id, { text: '⏳ Processing...' });
  
  try {
    if (data.startsWith('video_')) {
      const parts = data.split('_');
      const quality = parts[1];
      const url = parts.slice(2).join('_');
      await downloadVideo(chatId, url, quality, userId);
    } else if (data.startsWith('audio_')) {
      const url = data.replace('audio_', '');
      await downloadAudio(chatId, url, userId);
    }
  } catch (error) {
    console.error('Callback error:', error);
    await bot.sendMessage(chatId, '❌ An error occurred. Please try again.');
  }
});

// ============================================
// DOWNLOAD VIDEO FUNCTION
// ============================================

/**
 * Download video in specified quality
 */
async function downloadVideo(chatId, url, quality, userId) {
  const downloadKey = `${userId}_${url}_${quality}`;
  
  if (activeDownloads.has(downloadKey)) {
    await bot.sendMessage(chatId, '⚠️ Download already in progress...');
    return;
  }
  
  activeDownloads.add(downloadKey);
  
  const statusMsg = await bot.sendMessage(chatId, `⏬ Downloading ${quality} video...`);
  const timestamp = Date.now();
  const tempVideoPath = path.join(TEMP_DIR, `${timestamp}_video.mp4`);
  
  try {
    // Get quality number
    const qualityNum = parseInt(quality.replace('p', ''));
    
    // Download stream
    await bot.editMessageText(`⏬ Downloading ${quality} video...\n\n⏳ Please wait, this may take a while...`, {
      chat_id: chatId,
      message_id: statusMsg.message_id
    });
    
    const stream = await play.stream(url, { 
      quality: qualityNum,
      discordPlayerCompatibility: false
    });
    
    const writeStream = fs.createWriteStream(tempVideoPath);
    let downloadedBytes = 0;
    
    // Track progress
    stream.stream.on('data', (chunk) => {
      downloadedBytes += chunk.length;
    });
    
    stream.stream.pipe(writeStream);
    
    // Wait for download to complete
    await new Promise((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
      
      // Timeout
      setTimeout(() => reject(new Error('Download timeout')), DOWNLOAD_TIMEOUT);
    });
    
    // Check file size
    const fileSize = getFileSize(tempVideoPath);
    
    if (fileSize === 0) {
      throw new Error('Downloaded file is empty');
    }
    
    if (fileSize > MAX_FILE_SIZE) {
      throw new Error(`File too large (${formatSize(fileSize)}). Try lower quality.`);
    }
    
    // Upload to Telegram
    await bot.editMessageText(`⏫ Uploading to Telegram...\n\n📦 Size: ${formatSize(fileSize)}`, {
      chat_id: chatId,
      message_id: statusMsg.message_id
    });
    
    // Get video info for caption
    const info = await play.video_info(url);
    const caption = `✅ ${info.video_details.title.substring(0, 200)}\n\n📹 Quality: ${quality}\n📦 Size: ${formatSize(fileSize)}`;
    
    await bot.sendVideo(chatId, tempVideoPath, {
      caption: caption,
      supports_streaming: true
    });
    
    await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
    
  } catch (error) {
    console.error('Video download error:', error);
    
    let errorMsg = '❌ Download failed\\.\n\n';
    
    if (error.message.includes('timeout')) {
      errorMsg += 'Download took too long\\. Try a shorter video\\.';
    } else if (error.message.includes('too large')) {
      errorMsg += error.message.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
    } else {
      errorMsg += 'Try again or use a different quality\\.';
    }
    
    await bot.editMessageText(errorMsg, {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      parse_mode: 'MarkdownV2'
    }).catch(() => {});
    
  } finally {
    cleanup(tempVideoPath);
    activeDownloads.delete(downloadKey);
  }
}

// ============================================
// DOWNLOAD AUDIO FUNCTION
// ============================================

/**
 * Download audio and convert to MP3
 */
async function downloadAudio(chatId, url, userId) {
  const downloadKey = `${userId}_${url}_audio`;
  
  if (activeDownloads.has(downloadKey)) {
    await bot.sendMessage(chatId, '⚠️ Download already in progress...');
    return;
  }
  
  activeDownloads.add(downloadKey);
  
  const statusMsg = await bot.sendMessage(chatId, '⏬ Downloading audio...');
  const timestamp = Date.now();
  const tempRawPath = path.join(TEMP_DIR, `${timestamp}_raw.webm`);
  const tempAudioPath = path.join(TEMP_DIR, `${timestamp}_audio.mp3`);
  
  try {
    // Download audio stream
    const stream = await play.stream(url, { 
      quality: 0,  // 0 = audio only
      discordPlayerCompatibility: false
    });
    
    const writeStream = fs.createWriteStream(tempRawPath);
    stream.stream.pipe(writeStream);
    
    await new Promise((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
      setTimeout(() => reject(new Error('Download timeout')), DOWNLOAD_TIMEOUT);
    });
    
    // Convert to MP3
    await bot.editMessageText('🔄 Converting to MP3...', {
      chat_id: chatId,
      message_id: statusMsg.message_id
    });
    
    await new Promise((resolve, reject) => {
      ffmpeg(tempRawPath)
        .toFormat('mp3')
        .audioBitrate(192)
        .on('end', () => {
          console.log('✅ MP3 conversion complete');
          resolve();
        })
        .on('error', (err) => {
          console.error('❌ FFmpeg error:', err);
          reject(err);
        })
        .save(tempAudioPath);
    });
    
    // Check file size
    const fileSize = getFileSize(tempAudioPath);
    
    if (fileSize === 0) {
      throw new Error('Converted file is empty');
    }
    
    if (fileSize > MAX_FILE_SIZE) {
      throw new Error(`File too large (${formatSize(fileSize)})`);
    }
    
    // Upload to Telegram
    await bot.editMessageText(`⏫ Uploading to Telegram...\n\n📦 Size: ${formatSize(fileSize)}`, {
      chat_id: chatId,
      message_id: statusMsg.message_id
    });
    
    // Get video info
    const info = await play.video_info(url);
    const title = info.video_details.title.substring(0, 200);
    const performer = info.video_details.channel.name.substring(0, 100);
    
    await bot.sendAudio(chatId, tempAudioPath, {
      caption: `✅ ${title}\n\n🎵 Audio Only\n📦 Size: ${formatSize(fileSize)}`,
      title: title,
      performer: performer
    });
    
    await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
    
  } catch (error) {
    console.error('Audio download error:', error);
    
    let errorMsg = '❌ Audio download failed\\.\n\n';
    
    if (error.message.includes('timeout')) {
      errorMsg += 'Download took too long\\.';
    } else if (error.message.includes('too large')) {
      errorMsg += error.message.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
    } else {
      errorMsg += 'Please try again\\.';
    }
    
    await bot.editMessageText(errorMsg, {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      parse_mode: 'MarkdownV2'
    }).catch(() => {});
    
  } finally {
    cleanup(tempRawPath, tempAudioPath);
    activeDownloads.delete(downloadKey);
  }
}

// ============================================
// ERROR HANDLERS
// ============================================

bot.on('polling_error', (error) => {
  console.error('❌ Polling error:', error.message);
});

bot.on('error', (error) => {
  console.error('❌ Bot error:', error.message);
});

// ============================================
// CLEANUP ON EXIT
// ============================================

process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down bot...');
  
  // Clean up all temp files
  if (fs.existsSync(TEMP_DIR)) {
    const files = fs.readdirSync(TEMP_DIR);
    files.forEach(file => {
      cleanup(path.join(TEMP_DIR, file));
    });
  }
  
  bot.stopPolling();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Received SIGTERM, shutting down...');
  bot.stopPolling();
  process.exit(0);
});

// ============================================
// START MESSAGE
// ============================================

console.log('='.repeat(50));
console.log('🤖 YouTube Downloader Bot');
console.log('='.repeat(50));
console.log('✅ Bot is running...');
console.log('📁 Temp directory:', TEMP_DIR);
console.log('⏰ Started at:', new Date().toLocaleString());
console.log('='.repeat(50));
