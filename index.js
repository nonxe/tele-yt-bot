const TelegramBot = require('node-telegram-bot-api');
const play = require('play-dl');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');

ffmpeg.setFfmpegPath(ffmpegPath);

const token = process.env.BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });

const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR);
}

// Clean up function
function cleanup(filePath) {
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

// Start command
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 
    '👋 Welcome! Send me a YouTube link to download.\n\n' +
    'Commands:\n' +
    '/help - Show help\n' +
    '/download <url> - Download a video'
  );
});

// Help command
bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId,
    'Just send me a YouTube link or use:\n' +
    '/download <youtube_url>\n\n' +
    'I\'ll give you options to download video or audio!'
  );
});

// Download command
bot.onText(/\/download (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const url = match[1];
  await handleYouTubeLink(chatId, url);
});

// Handle YouTube links
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text || text.startsWith('/')) return;

  // Check if message contains YouTube link
  const youtubeRegex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
  const match = text.match(youtubeRegex);

  if (match) {
    await handleYouTubeLink(chatId, text);
  }
});

async function handleYouTubeLink(chatId, url) {
  try {
    await bot.sendMessage(chatId, '⏳ Fetching video info...');

    // Validate YouTube URL
    const isValid = play.yt_validate(url);
    if (isValid !== 'video') {
      await bot.sendMessage(chatId, '❌ Invalid YouTube URL. Please send a valid video link.');
      return;
    }

    // Get video info
    const info = await play.video_info(url);
    const videoDetails = info.video_details;

    // Create quality options
    const keyboard = {
      inline_keyboard: []
    };

    // Add video quality options
    const qualities = ['360p', '480p', '720p', '1080p'];
    const availableQualities = [];

    for (const quality of qualities) {
      const format = info.format.find(f => f.quality === quality);
      if (format) {
        availableQualities.push({
          text: `📹 ${quality}`,
          callback_data: `video_${quality}_${url}`
        });
      }
    }

    if (availableQualities.length > 0) {
      keyboard.inline_keyboard.push(availableQualities);
    }

    // Add audio option
    keyboard.inline_keyboard.push([{
      text: '🎵 Audio Only (MP3)',
      callback_data: `audio_${url}`
    }]);

    await bot.sendMessage(chatId,
      `📺 *${videoDetails.title}*\n\n` +
      `👤 Channel: ${videoDetails.channel.name}\n` +
      `⏱️ Duration: ${Math.floor(videoDetails.durationInSec / 60)}:${String(videoDetails.durationInSec % 60).padStart(2, '0')}\n` +
      `👁️ Views: ${videoDetails.views.toLocaleString()}\n\n` +
      `Select quality to download:`,
      { 
        parse_mode: 'Markdown',
        reply_markup: keyboard 
      }
    );

  } catch (error) {
    console.error('Error:', error);
    await bot.sendMessage(chatId, 
      '❌ Error: Failed to fetch video info.\n\n' +
      'Please try again or use a different video.'
    );
  }
}

// Handle callback queries (button clicks)
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  await bot.answerCallbackQuery(query.id);

  if (data.startsWith('video_')) {
    const parts = data.split('_');
    const quality = parts[1];
    const url = parts.slice(2).join('_');
    await downloadVideo(chatId, url, quality);
  } else if (data.startsWith('audio_')) {
    const url = data.replace('audio_', '');
    await downloadAudio(chatId, url);
  }
});

async function downloadVideo(chatId, url, quality) {
  const statusMsg = await bot.sendMessage(chatId, `⏬ Downloading ${quality} video...`);
  const tempVideoPath = path.join(TEMP_DIR, `${Date.now()}_video.mp4`);

  try {
    // Get video stream
    const stream = await play.stream(url, { quality: parseInt(quality.replace('p', '')) });
    const writeStream = fs.createWriteStream(tempVideoPath);

    stream.stream.pipe(writeStream);

    await new Promise((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });

    await bot.editMessageText('⏫ Uploading to Telegram...', {
      chat_id: chatId,
      message_id: statusMsg.message_id
    });

    // Send video
    await bot.sendVideo(chatId, tempVideoPath, {
      caption: `✅ Downloaded in ${quality}`
    });

    await bot.deleteMessage(chatId, statusMsg.message_id);
    cleanup(tempVideoPath);

  } catch (error) {
    console.error('Download error:', error);
    await bot.editMessageText(
      '❌ Download failed. File might be too large or unavailable in this quality.\n\n' +
      'Try again or use a different quality.',
      {
        chat_id: chatId,
        message_id: statusMsg.message_id
      }
    );
    cleanup(tempVideoPath);
  }
}

async function downloadAudio(chatId, url) {
  const statusMsg = await bot.sendMessage(chatId, '⏬ Downloading audio...');
  const tempAudioPath = path.join(TEMP_DIR, `${Date.now()}_audio.mp3`);
  const tempRawPath = path.join(TEMP_DIR, `${Date.now()}_raw.webm`);

  try {
    // Get audio stream
    const stream = await play.stream(url, { quality: 0 }); // 0 = audio only
    const writeStream = fs.createWriteStream(tempRawPath);

    stream.stream.pipe(writeStream);

    await new Promise((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });

    await bot.editMessageText('🔄 Converting to MP3...', {
      chat_id: chatId,
      message_id: statusMsg.message_id
    });

    // Convert to MP3
    await new Promise((resolve, reject) => {
      ffmpeg(tempRawPath)
        .toFormat('mp3')
        .audioBitrate(192)
        .on('end', resolve)
        .on('error', reject)
        .save(tempAudioPath);
    });

    await bot.editMessageText('⏫ Uploading to Telegram...', {
      chat_id: chatId,
      message_id: statusMsg.message_id
    });

    // Get video info for title
    const info = await play.video_info(url);

    // Send audio
    await bot.sendAudio(chatId, tempAudioPath, {
      caption: '✅ Audio downloaded',
      title: info.video_details.title,
      performer: info.video_details.channel.name
    });

    await bot.deleteMessage(chatId, statusMsg.message_id);
    cleanup(tempAudioPath);
    cleanup(tempRawPath);

  } catch (error) {
    console.error('Download error:', error);
    await bot.editMessageText(
      '❌ Audio download failed.\n\n' +
      'Try again or use a different video.',
      {
        chat_id: chatId,
        message_id: statusMsg.message_id
      }
    );
    cleanup(tempAudioPath);
    cleanup(tempRawPath);
  }
}

// Clean up temp files on exit
process.on('exit', () => {
  if (fs.existsSync(TEMP_DIR)) {
    fs.readdirSync(TEMP_DIR).forEach(file => {
      cleanup(path.join(TEMP_DIR, file));
    });
  }
});

console.log('✅ Bot is running...');
