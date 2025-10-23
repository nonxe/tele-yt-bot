const { Telegraf, Markup } = require('telegraf');
const ytdl = require('@distube/ytdl-core');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// Set ffmpeg path
ffmpeg.setFfmpegPath(ffmpegPath);

// Initialize bot
const bot = new Telegraf(process.env.BOT_TOKEN);

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
      const stats = fs.statSync(filePath);
      // Delete files older than 10 minutes
      if (now - stats.mtimeMs > 10 * 60 * 1000) {
        fs.unlinkSync(filePath);
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

// Get video info and formats
async function getVideoInfo(url) {
  try {
    const info = await ytdl.getInfo(url, {
      requestOptions: {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      }
    });
    return info;
  } catch (error) {
    throw new Error(`Failed to fetch video info: ${error.message}`);
  }
}

// Get available quality options
function getQualityOptions(info) {
  const formats = ytdl.filterFormats(info.formats, 'videoandaudio');
  
  // Get unique qualities
  const qualities = [...new Set(formats.map(f => f.qualityLabel).filter(Boolean))];
  
  // Sort by quality (descending)
  qualities.sort((a, b) => {
    const aNum = parseInt(a);
    const bNum = parseInt(b);
    return bNum - aNum;
  });
  
  return qualities.slice(0, 5); // Limit to top 5 qualities
}

// Start command
bot.start((ctx) => {
  ctx.reply(
    '👋 *Welcome to YouTube Downloader Bot!*\n\n' +
    '📹 Send me a YouTube link and I\'ll help you download it.\n\n' +
    '*Features:*\n' +
    '✅ Multiple quality options\n' +
    '✅ Audio-only MP3 download\n' +
    '✅ Fast and reliable\n\n' +
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
      buttons.push([Markup.button.callback(`📹 ${quality}`, `video_${quality}_${info.videoDetails.videoId}`)]);
    });
    
    // Audio only button
    buttons.push([Markup.button.callback('🎵 Audio Only (MP3)', `audio_${info.videoDetails.videoId}`)]);
    
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      processingMsg.message_id,
      null,
      `*${info.videoDetails.title}*\n\n` +
      `⏱ Duration: ${Math.floor(info.videoDetails.lengthSeconds / 60)}:${(info.videoDetails.lengthSeconds % 60).toString().padStart(2, '0')}\n` +
      `👁 Views: ${parseInt(info.videoDetails.viewCount).toLocaleString()}\n\n` +
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
  await ctx.editMessageText('⏳ Downloading... Please wait...');
  
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  
  try {
    if (type === 'audio') {
      await downloadAudio(ctx, videoUrl, videoId);
    } else if (type === 'video') {
      await downloadVideo(ctx, videoUrl, quality, videoId);
    }
  } catch (error) {
    console.error('Download error:', error);
    await ctx.editMessageText(`❌ Download failed: ${error.message}\n\nPlease try again or choose a different quality.`);
  }
});

// Download video
async function downloadVideo(ctx, url, quality, videoId) {
  const outputPath = path.join(TEMP_DIR, `${videoId}_${quality}.mp4`);
  
  try {
    const info = await getVideoInfo(url);
    const format = ytdl.chooseFormat(info.formats, { quality: quality.replace('p', '') });
    
    if (!format) {
      throw new Error('Selected quality not available');
    }
    
    await ctx.editMessageText('⬇️ Downloading video...');
    
    const videoStream = ytdl(url, { format: format });
    const writeStream = fs.createWriteStream(outputPath);
    
    await new Promise((resolve, reject) => {
      videoStream.pipe(writeStream);
      videoStream.on('error', reject);
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });
    
    await ctx.editMessageText('⬆️ Uploading to Telegram...');
    
    const stats = fs.statSync(outputPath);
    const fileSizeMB = stats.size / (1024 * 1024);
    
    if (fileSizeMB > 50) {
      await ctx.editMessageText('❌ File too large (>50MB). Try a lower quality or audio-only.');
      fs.unlinkSync(outputPath);
      return;
    }
    
    await ctx.replyWithVideo(
      { source: outputPath },
      { caption: `${info.videoDetails.title}\n\n📹 Quality: ${quality}` }
    );
    
    await ctx.deleteMessage();
    fs.unlinkSync(outputPath);
    
  } catch (error) {
    fs.existsSync(outputPath) && fs.unlinkSync(outputPath);
    throw error;
  }
}

// Download audio
async function downloadAudio(ctx, url, videoId) {
  const audioPath = path.join(TEMP_DIR, `${videoId}_audio.webm`);
  const mp3Path = path.join(TEMP_DIR, `${videoId}.mp3`);
  
  try {
    const info = await getVideoInfo(url);
    
    await ctx.editMessageText('⬇️ Downloading audio...');
    
    const audioStream = ytdl(url, { quality: 'highestaudio' });
    const writeStream = fs.createWriteStream(audioPath);
    
    await new Promise((resolve, reject) => {
      audioStream.pipe(writeStream);
      audioStream.on('error', reject);
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });
    
    await ctx.editMessageText('🎵 Converting to MP3...');
    
    await new Promise((resolve, reject) => {
      ffmpeg(audioPath)
        .toFormat('mp3')
        .audioBitrate(192)
        .on('end', resolve)
        .on('error', reject)
        .save(mp3Path);
    });
    
    await ctx.editMessageText('⬆️ Uploading to Telegram...');
    
    const stats = fs.statSync(mp3Path);
    const fileSizeMB = stats.size / (1024 * 1024);
    
    if (fileSizeMB > 50) {
      await ctx.editMessageText('❌ File too large (>50MB).');
      fs.unlinkSync(audioPath);
      fs.unlinkSync(mp3Path);
      return;
    }
    
    await ctx.replyWithAudio(
      { source: mp3Path },
      {
        caption: `🎵 ${info.videoDetails.title}`,
        title: info.videoDetails.title,
        performer: info.videoDetails.author.name
      }
    );
    
    await ctx.deleteMessage();
    fs.unlinkSync(audioPath);
    fs.unlinkSync(mp3Path);
    
  } catch (error) {
    fs.existsSync(audioPath) && fs.unlinkSync(audioPath);
    fs.existsSync(mp3Path) && fs.unlinkSync(mp3Path);
    throw error;
  }
}

// Error handler
bot.catch((err, ctx) => {
  console.error('Bot error:', err);
  ctx.reply('❌ An error occurred. Please try again later.');
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
