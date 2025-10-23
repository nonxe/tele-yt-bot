/**
 * tele-yt-bot - Telegram YouTube downloader (robust)
 *
 * Features:
 * - Tries ytdl-core first (with User-Agent header)
 * - Falls back to yt-dlp via youtube-dl-exec on extractor errors (e.g., Status code: 410)
 * - Offers resolution buttons + Audio-only
 * - Streams to Telegram; converts audio to mp3 when needed via ffmpeg
 *
 * Required env:
 * - BOT_TOKEN
 *
 * Notes:
 * - Uses polling (Procfile sets worker: node index.js)
 * - youtube-dl-exec spawns yt-dlp; ffmpeg-static provides ffmpeg binary
 */

const { Telegraf, Markup } = require('telegraf');
const ytdl = require('ytdl-core');
const ytdlExec = require('youtube-dl-exec');
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
  return match ? (match[0].startsWith('http') ? match[0] : 'https://' + match[0]) : null;
}

// Returns { title, resolutions:[{label, itag, source}], audio:{itag, source}, _fallbackInfo? }
async function getFormatsInfo(url) {
  // First try ytdl-core with browser UA
  try {
    const info = await ytdl.getInfo(url, {
      requestOptions: {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
        }
      }
    });

    const formats = info.formats.filter(f => f.container && (f.hasVideo || f.hasAudio));
    const videoFormats = formats.filter(f => f.hasVideo && f.hasAudio);
    const resMap = {};
    videoFormats.forEach(f => {
      const q = f.qualityLabel || (f.height ? `${f.height}p` : 'unknown');
      // prefer larger contentLength if available
      const existing = resMap[q];
      if (!existing) {
        resMap[q] = { itag: f.itag, contentLength: parseInt(f.contentLength || 0, 10) || 0 };
      } else {
        const cur = parseInt(f.contentLength || 0, 10) || 0;
        if (cur > (existing.contentLength || 0)) {
          resMap[q] = { itag: f.itag, contentLength: cur };
        }
      }
    });

    const audioFormats = formats.filter(f => f.hasAudio && !f.hasVideo);
    const bestAudio = audioFormats.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];

    return {
      title: info.videoDetails.title || 'video',
      resolutions: Object.keys(resMap)
        .sort((a, b) => {
          const na = parseInt(a) || 0;
          const nb = parseInt(b) || 0;
          return nb - na;
        })
        .map(label => ({ label, itag: String(resMap[label].itag), source: 'ytdl' })),
      audio: bestAudio ? { itag: String(bestAudio.itag), source: 'ytdl' } : null
    };
  } catch (err) {
    const msg = (err && err.message) ? err.message : String(err);
    console.warn('ytdl-core getInfo failed:', msg);

    // Fallback triggers on extractor-like errors (410/status/extractor/signature)
    if (msg.includes('Status code: 410') || msg.toLowerCase().includes('extractor') || msg.toLowerCase().includes('signature')) {
      try {
        // Use youtube-dl-exec (yt-dlp) to dump JSON metadata
        const json = await ytdlExec(url, {
          dumpSingleJson: true,
          noWarnings: true,
          noCallHome: true,
          preferFreeFormats: true,
          addHeader: [
            'referer: https://www.youtube.com/',
            'user-agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
          ]
        }, { stdio: 'pipe' });

        if (!json || !json.formats) throw new Error('yt-dlp returned no formats');

        const formats = json.formats.filter(f => (f.format_id || f.format) && (f.vcodec !== 'none' || f.acodec !== 'none'));
        const videoFormats = formats.filter(f => f.vcodec !== 'none' && f.acodec !== 'none');
        const resMap = {};
        videoFormats.forEach(f => {
          const q = f.format_note || (f.height ? `${f.height}p` : (f.tbr ? `${Math.round(f.tbr)}kbps` : 'unknown'));
          // prefer formats with numeric height or better tbr
          if (!resMap[q]) resMap[q] = f;
        });

        const audioFormats = formats.filter(f => (f.vcodec === 'none' || f.vcodec === 'none') && f.acodec !== 'none');
        const bestAudio = audioFormats.sort((a, b) => (b.abr || b.bitrate || 0) - (a.abr || a.bitrate || 0))[0];

        return {
          title: json.title || 'video',
          resolutions: Object.keys(resMap)
            .sort((a, b) => {
              const na = parseInt(a) || 0;
              const nb = parseInt(b) || 0;
              return nb - na;
            })
            .map(label => {
              const f = resMap[label];
              return { label, itag: String(f.format_id || f.format), source: 'yt-dlp' };
            }),
          audio: bestAudio ? { itag: String(bestAudio.format_id || bestAudio.format), source: 'yt-dlp' } : null,
          _fallbackInfo: json
        };
      } catch (fallbackErr) {
        console.error('yt-dlp fallback failed:', fallbackErr);
        throw err; // rethrow original to show user
      }
    }

    throw err;
  }
}

bot.start(ctx => {
  ctx.reply('Welcome! Send a YouTube link and I will show download options (video resolutions + audio-only). Use /help for details.');
});

bot.help(ctx => {
  ctx.replyWithMarkdown(
    'Usage:\n- Send a YouTube link (https://youtu.be/...) or use /download <youtube_url>\n- Tap a resolution button or "Audio only" to download.\n\nNotes:\n- Set BOT_TOKEN environment variable before running.\n- Deploy to Heroku using the README Deploy button.'
  );
});

bot.command('download', async ctx => {
  const args = ctx.message.text.split(' ').slice(1);
  const url = args[0] || extractYouTubeUrl(ctx.message.reply_to_message && ctx.message.reply_to_message.text);
  if (!url) return ctx.reply('Please provide a YouTube URL: /download https://youtu.be/xxxxx');
  await handleUrl(ctx, url);
});

bot.on('text', async ctx => {
  const text = ctx.message.text;
  const url = extractYouTubeUrl(text);
  if (url) await handleUrl(ctx, url);
});

async function handleUrl(ctx, url) {
  const sent = await ctx.reply('Fetching formats, please wait...');
  try {
    const info = await getFormatsInfo(url);
    const buttons = [];

    // audio first
    if (info.audio) {
      buttons.push(Markup.button.callback('Audio only', `dl:audio:${encodeURIComponent(JSON.stringify(info.audio))}:${encodeURIComponent(url)}`));
    }

    info.resolutions.forEach(r => {
      // encode resolution object as JSON so we carry source and itag
      buttons.push(Markup.button.callback(r.label, `dl:video:${encodeURIComponent(JSON.stringify(r))}:${encodeURIComponent(url)}`));
    });

    buttons.push(Markup.button.callback('Cancel', `cancel:${encodeURIComponent(url)}`));

    // Build rows (2 buttons per row)
    const rows = [];
    for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));

    await ctx.telegram.editMessageText(ctx.chat.id, sent.message_id, null,
      `Found: *${escapeMarkdown(info.title)}*\nChoose a format:`,
      { parse_mode: 'Markdown', reply_markup: Markup.inlineKeyboard(rows).reply_markup }
    );
  } catch (err) {
    console.error('handleUrl error:', err);
    await ctx.telegram.editMessageText(ctx.chat.id, sent.message_id, null, `Failed to fetch formats: ${err.message || err}`);
  }
}

bot.on('callback_query', async ctx => {
  const data = ctx.callbackQuery.data;
  if (!data) return ctx.answerCbQuery();
  if (data.startsWith('cancel:')) {
    await ctx.editMessageText('Cancelled.');
    return ctx.answerCbQuery('Cancelled');
  }

  // formats:
  // dl:video:<encodedResolutionJson>:<encodedUrl>
  // dl:audio:<encodedAudioJson>:<encodedUrl>
  const parts = data.split(':');
  if (parts.length < 4) return ctx.answerCbQuery();
  const [, type, encodedJson, encodedUrl] = parts;
  const payload = JSON.parse(decodeURIComponent(encodedJson));
  const url = decodeURIComponent(encodedUrl);

  await ctx.answerCbQuery(`Preparing ${type === 'audio' ? 'audio' : 'video'}...`);
  try {
    if (type === 'audio') {
      await sendFormat(ctx, url, payload.itag, payload.source, true);
    } else {
      await sendFormat(ctx, url, payload.itag, payload.source, false);
    }
  } catch (err) {
    console.error('sendFormat error:', err);
    try { await ctx.reply('Failed to prepare file: ' + (err.message || err)); } catch (e) {}
  }
});

// sendFormat: url, itag (string), source: 'ytdl' | 'yt-dlp', isAudio boolean
async function sendFormat(ctx, url, itag, source, isAudio) {
  await ctx.replyWithChatAction('upload_document');

  // ytdl-core path (source === 'ytdl')
  if (source === 'ytdl') {
    const info = await ytdl.getInfo(url);
    const title = sanitizeFilename(info.videoDetails.title || 'video');

    if (isAudio) {
      // audio: stream audio-only using ytdl, convert to mp3 via ffmpeg
      const audioStream = ytdl.downloadFromInfo(info, { quality: itag });
      const pass = new PassThrough();
      const filename = `${title}.mp3`;

      ffmpeg(audioStream)
        .noVideo()
        .audioBitrate(128)
        .format('mp3')
        .on('error', err => console.error('ffmpeg audio error:', err))
        .pipe(pass);

      try {
        await ctx.replyWithDocument({ source: pass, filename });
      } catch (err) {
        console.error('upload audio (ytdl) failed:', err);
        await ctx.reply('Upload failed: ' + (err.message || err));
      }
    } else {
      // video: stream chosen itag
      const format = ytdl.chooseFormat(info.formats, { quality: itag });
      if (!format) return ctx.reply('Requested format not available (ytdl).');

      const ext = format.container || 'mp4';
      const filename = `${sanitizeFilename(info.videoDetails.title || 'video')}.${ext}`;
      const videoStream = ytdl.downloadFromInfo(info, { quality: itag });

      try {
        await ctx.replyWithDocument({ source: videoStream, filename });
      } catch (err) {
        console.error('upload video (ytdl) failed:', err);
        await ctx.reply('Upload failed: ' + (err.message || err));
      }
    }
    return;
  }

  // fallback yt-dlp path (source === 'yt-dlp')
  // Use youtube-dl-exec to spawn yt-dlp and pipe stdout
  if (source === 'yt-dlp') {
    const filenameBase = sanitizeFilename((new Date()).toISOString()); // will try to get title if possible
    if (isAudio) {
      // Use yt-dlp to stream best audio, pipe to ffmpeg to convert to mp3
      // We'll spawn yt-dlp with -f <itag> -o -
      try {
        const subprocess = ytdlExec(url, {
          format: itag,
          output: '-',
          preferFreeFormats: true,
          addHeader: ['referer: https://www.youtube.com/', 'user-agent: Mozilla/5.0']
        }, { stdio: ['ignore', 'pipe', 'pipe'] });

        const pass = new PassThrough();
        const filename = `${filenameBase}.mp3`;

        ffmpeg(subprocess.stdout)
          .noVideo()
          .audioBitrate(128)
          .format('mp3')
          .on('error', err => {
            console.error('ffmpeg (yt-dlp->mp3) error:', err);
            try { subprocess.kill('SIGKILL'); } catch (e) {}
          })
          .pipe(pass);

        try {
          await ctx.replyWithDocument({ source: pass, filename });
        } catch (err) {
          console.error('upload audio (yt-dlp) failed:', err);
          await ctx.reply('Upload failed: ' + (err.message || err));
          try { subprocess.kill('SIGKILL'); } catch (e) {}
        }
      } catch (err) {
        console.error('yt-dlp audio spawn failed:', err);
        await ctx.reply('Failed to download audio: ' + (err.message || err));
      }
    } else {
      // Video via yt-dlp: spawn yt-dlp to stdout with format itag
      try {
        const subprocess = ytdlExec(url, {
          format: itag,
          output: '-',
          preferFreeFormats: true,
          addHeader: ['referer: https://www.youtube.com/', 'user-agent: Mozilla/5.0']
        }, { stdio: ['ignore', 'pipe', 'pipe'] });

        // We don't know extension reliably, try mp4
        const filename = `${filenameBase}.mp4`;
        try {
          await ctx.replyWithDocument({ source: subprocess.stdout, filename });
        } catch (err) {
          console.error('upload video (yt-dlp) failed:', err);
          await ctx.reply('Upload failed: ' + (err.message || err));
          try { subprocess.kill('SIGKILL'); } catch (e) {}
        }
      } catch (err) {
        console.error('yt-dlp video spawn failed:', err);
        await ctx.reply('Failed to download video: ' + (err.message || err));
      }
    }
    return;
  }

  // Unknown source
  await ctx.reply('Unknown format source; cannot process.');
}

function sanitizeFilename(name) {
  return (name || 'file').replace(/[\\\/:*?"<>|]+/g, '').slice(0, 200);
}

function escapeMarkdown(text) {
  return (text || '').replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

bot.catch((err, ctx) => {
  console.error('Bot error for update', ctx.update, 'error', err);
});

bot.launch().then(() => {
  console.log('Bot started (polling).');
});

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
