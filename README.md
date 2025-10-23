```markdown
# tele-yt-bot

Telegram YouTube downloader bot (Node.js). Supports selecting video resolution and audio-only downloads.

Features:
- Resolution options (dynamically detects available resolutions)
- Audio-only option (converted to MP3)
- Streaming download (no YouTube API key required)
- Ready to deploy to Heroku via the Deploy button below

## Deploy to Heroku

Click the button to deploy this repository to Heroku. During deployment set the required environment variable BOT_TOKEN (your Telegram bot token).

[![Deploy](https://www.herokucdn.com/deploy/button.svg)](https://heroku.com/deploy?template=https://github.com/nonxe/tele-yt-bot)

Required config vars:
- BOT_TOKEN — your Telegram bot token

After deployment:
1. Scale the worker dyno (Heroku dashboard -> Resources -> enable the worker, or `heroku ps:scale worker=1`).
2. The bot uses long polling by default.

## Usage

- Send a YouTube link to the bot.
- Bot replies with available resolution buttons and "Audio only".
- Tap a button to start the download. The bot will upload the file to the chat.

Commands:
- /start — Welcome message
- /help — Usage instructions
- /download <youtube_url> — Manually request a URL

## Limitations and notes

- Telegram file size limits apply. If an upload fails due to size, try a lower resolution or audio-only.
- ffmpeg is bundled via `ffmpeg-static`, so no separate ffmpeg installation is required on Heroku.
- If you prefer webhooks instead of polling (recommended for production), you can modify index.js to set a webhook and expose a web process.

## Running locally

1. Install dependencies: `npm install`
2. Set BOT_TOKEN in your environment, e.g. `export BOT_TOKEN="123:ABC"`
3. Run: `node index.js`

## Contributing / Security

- This bot pipes streams from YouTube to Telegram; be mindful of copyright content distribution policies and bot usage limits.
```
