# Ancient Door Mystery

Cinematic Pidgin scene — Telegram bot + web experience.

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

## Telegram bot

```bash
cd ancient-door-mystery
npm run setup   # paste TELEGRAM_BOT_TOKEN from @BotFather
npm run bot     # starts polling
```

In Telegram:
- `/start` — intro + hero image
- tap **Open the door** — first Narrator line
- **Continue** through each line
- **Replay scene** at the end
- `/scene` — show the door again

Optional: set `TELEGRAM_ALLOWED_CHAT_IDS` in `.env` to lock the bot to your chats.

## Web scene

```bash
npm run web
```

Open [http://localhost:5173](http://localhost:5173).
