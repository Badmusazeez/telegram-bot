# Ancient Door Mystery

Cinematic Pidgin scene — short voiceover video, Telegram bot, and web player.

## Download the video

File: [`public/ancient-door-mystery.mp4`](./public/ancient-door-mystery.mp4) (~20s, 1080×1920)

Or open the web page and use **Download video**.

## Scene script

**Narrator**
- One massive ancient door slowly open.
- Bright golden light shine from inside.

**Young Explorer**
- Wetin dey wait for us inside?

**Elderly Woman**
- Only person wey get courage go know.

**Hooded Guide**
- The biggest secret still dey front.

## Regenerate video

Requires `ffmpeg` and `edge-tts` (`pip install edge-tts`).

```bash
cd ancient-door-mystery
npm run video
```

## Web player + download

```bash
cd ancient-door-mystery
npm run web
```

Open [http://localhost:5173](http://localhost:5173) → **Watch scene** or **Download video**.

## Telegram bot

```bash
cd ancient-door-mystery
npm run setup   # paste TELEGRAM_BOT_TOKEN from @BotFather
npm run bot
```

- `/start` — intro + hero image
- `/video` — send the voiceover MP4 (save/share from Telegram)
- `/scene` — interactive text dialogue
