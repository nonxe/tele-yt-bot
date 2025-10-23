/**
 * tele-yt-bot - Telegram YouTube downloader
 * - Uses Telegraf for Telegram bot
 * - Uses ytdl-core to fetch video/audio streams
 * - Uses fluent-ffmpeg + ffmpeg-static to convert audio when requested
 *
 * Environment variables:
 * - BOT_TOKEN (required) : Telegram bot token
 *
 * Notes:
 * - This implementation streams directly to Telegram where possible.
 * - For large files, Telegram limits apply; the bot will try and report if upload fails.
 */

const { Telegraf, Markup } = require('telegraf');
const ytdl = require('ytdl-core');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const { PassThrough } = require('stream');
const mime = require('mime');

ffmpeg.setFfmpegPath(ffmpegPath);

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('ERROR: BOT_TOKEN not set. Set the BOT_TOKEN environment variable.');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

function extractYouTubeUrl(text) {
  if (!text) return null;
  const urlRegex = /(https?:\/\/)?(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/)[\w-]{6,}/i;
  const match = text.match(urlRegex);
  return match ? match[0].startsWith('http') ? match[0] : 'https://' + match[0] : null;
}

async function getFormatsInfo(url) {
  const info = await ytdl.getInfo(url);
  const formats = info.formats.filter(f => f.container && (f.hasVideo || f.hasAudio));
  // Collect unique resolution options
  const videoFormats = formats.filter(f => f.hasVideo && f.hasAudio);
  // Map by quality label (like 1080p, 720p)
  const resMap = {};
  videoFormats.forEach(f => {
    const q = f.qualityLabel || (f.height ? f.height + 'p' : 'unknown');
    if (!resMap[q] || (resMap[q] && resMap[q].contentLength < f.contentLength)) {
      resMap[q] = f;
    }
  });
  // audio only (bestaudio)
  const audioFormats = formats.filter(f => f.hasAudio && !f.hasVideo);
  const bestAudio = audioFormats.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
  return {
    title: info.videoDetails.title || 'video',
    resolutions: Object.keys(resMap).sort((a, b) => {
      // sort numeric desc (1080p,720p,...)
      const na = parseInt(a) || 0;
      const nb = parseInt(b) || 0;
      return nb - na;
    }).map(label => ({ label, itag: resMap[label].itag })),
    audioItag: bestAudio ? bestAudio.itag : null
  };
}

bot.start((ctx) => {
  ctx.reply('Welcome! Send me a YouTube link and I\\'ll give you download options (video resolutions + audio-only). Use /help for details.');
});

bot.help((ctx) => {
  ctx.replyWithMarkdown('Usage:\\n- Send a YouTube link (https://youtu.be/...) or use /download <youtube_url>\\n- After link is processed, tap a resolution button or \"Audio only\" to download.\\n\\nNotes:\\n- Set BOT_TOKEN as an environment variable before running.\\n- Deploy to Heroku using the README Deploy button.');
});

bot.command('download', async (ctx) => {
  const args = ctx.message.text.split(' ').slice(1);
  const url = args[0] || extractYouTubeUrl(ctx.message.reply_to_message && ctx.message.reply_to_message.text);
  if (!url) {
    return ctx.reply('Please provide a YouTube URL: /download https://youtu.be/xxxxx');
  }
  await handleUrl(ctx, url);
});

bot.on('text', async (ctx) => {
  const text = ctx.message.text;
  const url = extractYouTubeUrl(text);
  if (url) {
    await handleUrl(ctx, url);
  } else {
    // ignore or give simple hint
    // ctx.reply('Send a YouTube link to download video or audio.');
  }
});

async function handleUrl(ctx, url) {
  let msg = await ctx.reply('Fetching formats, please wait...');
  try {
    const info = await getFormatsInfo(url);
    const buttons = [];
    // Build resolution buttons
    info.resolutions.forEach(r => {
      buttons.push(Markup.button.callback(r.label, `dl:video:${r.itag}:${encodeURIComponent(url)}`));
    });
    // Add audio-only if available
    if (info.audioItag) {
      buttons.unshift(Markup.button.callback('Audio only', `dl:audio:${info.audioItag}:${encodeURIComponent(url)}`));
    }
    // Add a cancel button
    buttons.push(Markup.button.callback('Cancel', `cancel:${encodeURIComponent(url)}`));

    // Create keyboard rows (2 per row)
    const keyboard = [];
    for (let i = 0; i < buttons.length; i += 2) {
      keyboard.push(buttons.slice(i, i + 2));
    }

    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
      `Found: *${escapeMarkdown(info.title)}*\\nChoose a format:`,
      { parse_mode: 'Markdown', reply_markup: Markup.inlineKeyboard(keyboard).reply_markup }
    );
  } catch (err) {
    console.error('Error in handleUrl:', err);
    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `Failed to fetch formats: ${err.message}`);
  }
}

bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery.data;
  if (!data) return ctx.answerCbQuery();
  if (data.startsWith('cancel:')) {
    await ctx.editMessageText('Cancelled.');
    return ctx.answerCbQuery('Cancelled');
  }
  // format: dl:video:<itag>:<encodedUrl> OR dl:audio:<itag>:<encodedUrl>
  const parts = data.split(':');
  if (parts.length < 4) return ctx.answerCbQuery();
  const [, type, itag, encodedUrl] = parts;
  const url = decodeURIComponent(encodedUrl);
  await ctx.answerCbQuery(`Preparing ${type === 'audio' ? 'audio' : 'video'}...`);
  try {
    await sendFormat(ctx, url, parseInt(itag, 10), type);
  } catch (err) {
    console.error('Error sending format:', err);
    try { await ctx.reply('Failed to prepare file: ' + (err.message || err)); } catch (e) {}
  }
});

async function sendFormat(ctx, url, itag, type) {
  // Notify upload action
  await ctx.replyWithChatAction('upload_document');

  const info = await ytdl.getInfo(url);
  const title = sanitizeFilename(info.videoDetails.title || 'video');
  const format = ytdl.chooseFormat(info.formats, { quality: itag });

  if (!format) {
    return ctx.reply('Requested format not available.');
  }

  if (type === 'audio') {
    // Stream audio-only, convert to mp3 via ffmpeg, then send
    const audioStream = ytdl.downloadFromInfo(info, { quality: itag });
    const pass = new PassThrough();
    const filename = `${title}.mp3`;
    // Convert to mp3
    ffmpeg(audioStream)
      .audioBitrate(128)
      .format('mp3')
      .on('error', (err) => {
        console.error('ffmpeg error', err);
      })
      .pipe(pass);
    // Send as document (so Telegram doesn't transcode)
    await ctx.replyWithDocument({ source: pass, filename, disable_notification: false })
      .catch(async (err) => {
        console.error('send audio err', err);
        await ctx.reply('Upload failed: ' + (err.message || err));
      });
  } else {
    // video: stream the chosen format directly to Telegram
    const videoStream = ytdl.downloadFromInfo(info, { quality: itag });
    // determine extension
    const ext = format.container || 'mp4';
    const mimeType = mime.getType(ext) || 'video/mp4';
    const filename = `${title}.${ext}`;
    // Send as document to avoid Telegram re-compression for larger files; replyWithVideo also available
    await ctx.replyWithDocument({ source: videoStream, filename })
      .catch(async (err) => {
        console.error('send video err', err);
        await ctx.reply('Upload failed: ' + (err.message || err));
      });
  }
}

function sanitizeFilename(name) {
  return name.replace(/[\\\/:*?"<>|]+/g, '').slice(0, 200);
}

function escapeMarkdown(text) {
  return (text || '').replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

// Global error handler
bot.catch((err, ctx) => {
  console.error('Bot error for update', ctx.update, 'error', err);
});

const PORT = process.env.PORT || 3000;

// Start polling (suitable for Heroku worker)
bot.launch().then(() => {
  console.log('Bot started (polling).');
  console.log('Press Ctrl+C to stop.');
});

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
