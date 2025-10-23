/**
 * tele-yt-bot - Telegram YouTube downloader (improved)
 *
 * Fixes and features:
 * - Uses an in-memory id map for callback data to avoid long callback payloads.
 * - MAX_FILE_SIZE env var (bytes) to prevent trying uploads larger than Telegram/Heroku can handle.
 * - Checks contentLength or estimates size; warns user if file likely too large.
 * - Converts audio to MP3 using ffmpeg and writes to a temp file before sending (more reliable).
 * - Sends video either by streaming (if safe) or by downloading to a temp file and sending as document.
 *
 * Environment variables:
 * - BOT_TOKEN (required)
 * - MAX_FILE_SIZE (optional, default 50 * 1024 * 1024 = 50MB)
 *
 * Note: This implementation stores pending download info in memory. For production across multiple dynos
 * you should use a shared store (Redis / DB) to persist pending requests.
 */

const { Telegraf, Markup } = require('telegraf');
const ytdl = require('ytdl-core');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const { pipeline } = require('stream');
const { promisify } = require('util');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mime = require('mime');

const pipe = promisify(pipeline);
ffmpeg.setFfmpegPath(ffmpegPath);

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('ERROR: BOT_TOKEN not set. Set the BOT_TOKEN environment variable.');
  process.exit(1);
}

const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE || (50 * 1024 * 1024), 10); // 50 MB default

const bot = new Telegraf(BOT_TOKEN);

// In-memory map to hold pending download requests referenced by short ids
const pending = new Map();
// Entries expire after a timeout to avoid memory leak
const PENDING_TTL_MS = 10 * 60 * 1000; // 10 minutes

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}

function extractYouTubeUrl(text) {
  if (!text) return null;
  const urlRegex = /(https?:\/\/)?(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/)[\w-]{6,}/i;
  const match = text.match(urlRegex);
  if (!match) return null;
  const candidate = match[0];
  return candidate.startsWith('http') ? candidate : 'https://' + candidate;
}

async function getFormatsInfo(url) {
  const info = await ytdl.getInfo(url);
  const formats = info.formats.filter(f => f.container && (f.hasVideo || f.hasAudio));
  const videoFormats = formats.filter(f => f.hasVideo && f.hasAudio);
  const resMap = {};
  videoFormats.forEach(f => {
    const q = f.qualityLabel || (f.height ? f.height + 'p' : 'unknown');
    // choose a representative format for that label (prefer larger contentLength)
    if (!resMap[q] || (resMap[q] && (Number(resMap[q].contentLength || 0) < Number(f.contentLength || 0)))) {
      resMap[q] = f;
    }
  });
  const audioFormats = formats.filter(f => f.hasAudio && !f.hasVideo);
  const bestAudio = audioFormats.sort((a, b) => (Number(b.bitrate || b.audioBitrate || 0) - Number(a.bitrate || a.audioBitrate || 0)))[0];
  return {
    title: info.videoDetails.title || 'video',
    lengthSeconds: parseInt(info.videoDetails.lengthSeconds || '0', 10),
    resolutions: Object.keys(resMap).sort((a, b) => {
      const na = parseInt(a) || 0;
      const nb = parseInt(b) || 0;
      return nb - na;
    }).map(label => ({ label, itag: resMap[label].itag, contentLength: resMap[label].contentLength, avgBitrate: resMap[label].averageBitrate || resMap[label].bitrate || 0 })),
    audioItag: bestAudio ? bestAudio.itag : null,
    audioContentLength: bestAudio ? bestAudio.contentLength : null,
    audioAvgBitrate: bestAudio ? (bestAudio.averageBitrate || bestAudio.bitrate || bestAudio.audioBitrate || 0) : 0
  };
}

bot.start((ctx) => {
  ctx.reply('Welcome! Send me a YouTube link and I\'ll show download options (video resolutions + audio-only). Use /help for details.');
});

bot.help((ctx) => {
  ctx.replyWithMarkdown('Usage:\n- Send a YouTube link (https://youtu.be/...) or use /download <youtube_url>\n- After link is processed, tap a resolution button or "Audio only" to download.\n\nNotes:\n- Set BOT_TOKEN as an environment variable before running.\n- MAX_FILE_SIZE (bytes) can be set to limit uploads (default 50MB).');
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
  }
});

async function handleUrl(ctx, url) {
  let msg = await ctx.reply('Fetching formats, please wait...');
  try {
    const info = await getFormatsInfo(url);
    const buttons = [];
    // Add audio-only first if available
    if (info.audioItag) {
      const id = makeId();
      pending.set(id, { url, itag: info.audioItag, type: 'audio', title: info.title, lengthSeconds: info.lengthSeconds, contentLength: info.audioContentLength, avgBitrate: info.audioAvgBitrate });
      setTimeout(() => pending.delete(id), PENDING_TTL_MS);
      buttons.push(Markup.button.callback('Audio only', `dl:${id}`));
    }
    // Build resolution buttons
    info.resolutions.forEach(r => {
      const id = makeId();
      pending.set(id, { url, itag: r.itag, type: 'video', title: info.title, lengthSeconds: info.lengthSeconds, contentLength: r.contentLength, avgBitrate: r.avgBitrate });
      setTimeout(() => pending.delete(id), PENDING_TTL_MS);
      buttons.push(Markup.button.callback(r.label, `dl:${id}`));
    });

    // Add cancel
    const cancelId = makeId();
    pending.set(cancelId, { cancel: true, url });
    setTimeout(() => pending.delete(cancelId), PENDING_TTL_MS);
    buttons.push(Markup.button.callback('Cancel', `cancel:${cancelId}`));

    // Arrange keyboard in rows of 2
    const keyboard = [];
    for (let i = 0; i < buttons.length; i += 2) {
      keyboard.push(buttons.slice(i, i + 2));
    }

    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
      `Found: *${escapeMarkdown(info.title)}*\nChoose a format:`,
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
    const id = data.split(':')[1];
    pending.delete(id);
    await ctx.editMessageText('Cancelled.');
    return ctx.answerCbQuery('Cancelled');
  }
  if (!data.startsWith('dl:')) return ctx.answerCbQuery();
  const id = data.split(':')[1];
  const entry = pending.get(id);
  if (!entry) {
    await ctx.answerCbQuery('Request expired or not found. Please send the link again.', { show_alert: true });
    return;
  }
  // prevent reuse
  pending.delete(id);

  await ctx.answerCbQuery(`Preparing ${entry.type === 'audio' ? 'audio' : 'video'}...`);
  try {
    await sendFormat(ctx, entry);
  } catch (err) {
    console.error('Error sending format:', err);
    try { await ctx.reply('Failed to prepare file: ' + (err.message || err)); } catch (e) {}
  }
});

async function sendFormat(ctx, entry) {
  await ctx.replyWithChatAction('upload_document');
  const { url, itag, type, title, lengthSeconds } = entry;
  const info = await ytdl.getInfo(url);
  const chosenFormat = ytdl.chooseFormat(info.formats, { quality: itag });
  if (!chosenFormat) {
    return ctx.reply('Requested format not available.');
  }

  const fileTitle = sanitizeFilename(title || info.videoDetails.title || 'video');

  // Determine content length if available
  let contentLength = chosenFormat.contentLength ? Number(chosenFormat.contentLength) : null;
  // If not available, try averageBitrate or bitrate estimate
  if (!contentLength) {
    const avgBitrate = Number(chosenFormat.averageBitrate || chosenFormat.bitrate || chosenFormat.audioBitrate || entry.avgBitrate || 0);
    if (avgBitrate && lengthSeconds) {
      // averageBitrate is in bits/sec -> convert to bytes
      contentLength = Math.ceil((avgBitrate / 8) * Number(lengthSeconds));
    }
  }

  if (contentLength && contentLength > MAX_FILE_SIZE) {
    const mb = (contentLength / (1024 * 1024)).toFixed(2);
    const limitMb = (MAX_FILE_SIZE / (1024 * 1024)).toFixed(2);
    return ctx.reply(`The selected file is likely too large (~${mb} MB) which exceeds the configured limit (${limitMb} MB). Please choose a lower resolution or use Audio only.`);
  }

  // If we still don't know size, be conservative for video: refuse and ask user to choose lower resolution or audio-only
  if (!contentLength && type === 'video') {
    return ctx.reply('Could not determine file size reliably. To avoid failed uploads, please try a lower resolution or use Audio only.');
  }

  if (type === 'audio') {
    // audio: convert to mp3 file in tmp then send
    const tempFile = path.join(os.tmpdir(), `${fileTitle}-${Date.now()}.mp3`);
    try {
      const audioStream = ytdl.downloadFromInfo(info, { quality: itag });
      await new Promise((resolve, reject) => {
        const ff = ffmpeg(audioStream)
          .audioBitrate(128)
          .format('mp3')
          .on('error', (err) => {
            console.error('ffmpeg error', err);
            reject(err);
          })
          .on('end', () => resolve());
        ff.save(tempFile);
      });
      // Send file
      const stat = fs.statSync(tempFile);
      if (stat.size > MAX_FILE_SIZE) {
        fs.unlinkSync(tempFile);
        return ctx.reply(`Converted file is too large (${(stat.size / (1024 * 1024)).toFixed(2)} MB). Try a different option.`);
      }
      const readStream = fs.createReadStream(tempFile);
      await ctx.replyWithDocument({ source: readStream, filename: `${fileTitle}.mp3` }).catch(err => {
        console.error('send audio err', err);
        throw err;
      });
    } finally {
      // cleanup
      try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch (e) {}
    }
  } else {
    // video: if contentLength known and <= MAX, attempt streaming, else download to tmp and send
    const ext = chosenFormat.container || 'mp4';
    const filename = `${fileTitle}.${ext}`;

    // If streaming directly (contentLength known and small), stream
    if (contentLength && contentLength <= MAX_FILE_SIZE) {
      const videoStream = ytdl.downloadFromInfo(info, { quality: itag });
      try {
        await ctx.replyWithDocument({ source: videoStream, filename }).catch(async (err) => {
          console.error('streaming upload failed, err:', err);
          // fallback: download to temp then send
          throw err;
        });
      } catch (err) {
        // fallback to temp file
        const tmpPath = path.join(os.tmpdir(), `${fileTitle}-${Date.now()}.${ext}`);
        try {
          const dlStream = ytdl.downloadFromInfo(info, { quality: itag });
          await pipe(dlStream, fs.createWriteStream(tmpPath));
          const stat = fs.statSync(tmpPath);
          if (stat.size > MAX_FILE_SIZE) {
            fs.unlinkSync(tmpPath);
            return ctx.reply(`Downloaded file is too large (${(stat.size / (1024 * 1024)).toFixed(2)} MB). Try a different option.`);
          }
          await ctx.replyWithDocument({ source: fs.createReadStream(tmpPath), filename });
        } finally {
          try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (e) {}
        }
      }
    } else {
      // If contentLength unknown but previously passed earlier checks, do conservative fallback: download to tmp and check
      const tmpPath = path.join(os.tmpdir(), `${fileTitle}-${Date.now()}.${ext}`);
      try {
        const dlStream = ytdl.downloadFromInfo(info, { quality: itag });
        await pipe(dlStream, fs.createWriteStream(tmpPath));
        const stat = fs.statSync(tmpPath);
        if (stat.size > MAX_FILE_SIZE) {
          fs.unlinkSync(tmpPath);
          return ctx.reply(`Downloaded file is too large (${(stat.size / (1024 * 1024)).toFixed(2)} MB). Try a different option.`);
        }
        await ctx.replyWithDocument({ source: fs.createReadStream(tmpPath), filename });
      } finally {
        try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (e) {}
      }
    }
  }
}

function sanitizeFilename(name) {
  return (name || '').replace(/[\\\/:*?"<>|]+/g, '').slice(0, 200);
}

function escapeMarkdown(text) {
  return (text || '').replace(/([_*[\\]()~`>#+\\-=|{}.!])/g, '\\$1');
}

// Periodic cleanup (in case)
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pending.entries()) {
    // If entry older than TTL, remove. We stored no timestamp, but IDs encode time. We'll parse id date part.
    // IDs start with Date.now().toString(36)
    try {
      const tsPart = parseInt(k.slice(0, 8), 36);
      if (!isNaN(tsPart) && (now - tsPart) > PENDING_TTL_MS) pending.delete(k);
    } catch (e) {}
  }
}, 60 * 1000);

bot.catch((err, ctx) => {
  console.error('Bot error for update', ctx.update, 'error', err);
});

bot.launch().then(() => {
  console.log('Bot started (polling). MAX_FILE_SIZE =', MAX_FILE_SIZE);
});

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
