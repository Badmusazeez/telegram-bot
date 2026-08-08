import { Bot, Context, InlineKeyboard, InputFile } from "grammy";
import path from "node:path";
import { config } from "./config";
import { SCENE, formatLine } from "./script";

const HERO_IMAGE = path.join(__dirname, "..", "public", "hero.png");

function chatId(ctx: Context): string {
  return String(ctx.chat?.id ?? "");
}

function isAuthorized(ctx: Context): boolean {
  if (config.allowedChatIds.size === 0) {
    return true;
  }
  return config.allowedChatIds.has(chatId(ctx));
}

function continueKeyboard(index: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (index < SCENE.length - 1) {
    kb.text("Continue ▶", `scene:${index + 1}`);
  } else {
    kb.text("Replay scene ↺", "scene:0");
  }
  return kb;
}

async function sendHero(ctx: Context): Promise<void> {
  await ctx.replyWithPhoto(new InputFile(HERO_IMAGE), {
    caption:
      "<b>Ancient Door</b>\n" +
      "Three travelers stand before one massive ancient door.\n" +
      "Tap below to open am.",
    parse_mode: "HTML",
    reply_markup: new InlineKeyboard().text("Open the door", "scene:0"),
  });
}

async function sendLine(
  ctx: Context,
  index: number,
  { forceNew = false }: { forceNew?: boolean } = {}
): Promise<void> {
  const line = SCENE[index];
  if (!line) return;

  const text = formatLine(line, index, SCENE.length);
  const markup = continueKeyboard(index);
  const fromPhoto = Boolean(ctx.callbackQuery?.message?.photo);

  if (ctx.callbackQuery && !forceNew && !fromPhoto) {
    await ctx.editMessageText(text, {
      parse_mode: "HTML",
      reply_markup: markup,
    });
    return;
  }

  await ctx.reply(text, {
    parse_mode: "HTML",
    reply_markup: markup,
  });
}

export function createBot(): Bot {
  const bot = new Bot(config.telegramToken);

  bot.use(async (ctx, next) => {
    if (!isAuthorized(ctx)) {
      if (ctx.message?.text?.startsWith("/") || ctx.callbackQuery) {
        await ctx.reply(
          `Unauthorized chat (${chatId(ctx)}). Add it to TELEGRAM_ALLOWED_CHAT_IDS.`
        );
      }
      return;
    }
    await next();
  });

  bot.command("start", async (ctx) => {
    await ctx.reply(
      "<b>Ancient Door Mystery</b>\n\n" +
        "One massive ancient door dey wait.\n" +
        "Bright golden light shine from inside.\n\n" +
        "Commands: /scene · /help",
      { parse_mode: "HTML" }
    );
    await sendHero(ctx);
  });

  bot.command("scene", async (ctx) => {
    await sendHero(ctx);
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      "<b>Ancient Door Mystery</b>\n\n" +
        "/start — begin the scene\n" +
        "/scene — show the door again\n" +
        "/help — this message\n\n" +
        "<b>Cast</b>\n" +
        "Narrator · Young Explorer · Elderly Woman · Hooded Guide",
      { parse_mode: "HTML" }
    );
  });

  bot.callbackQuery(/^scene:(\d+)$/, async (ctx) => {
    const index = Number(ctx.match[1]);
    await ctx.answerCallbackQuery();

    if (!Number.isInteger(index) || index < 0 || index >= SCENE.length) {
      await ctx.reply("Scene line no dey. Use /scene to start again.");
      return;
    }

    await sendLine(ctx, index);
  });

  bot.catch((err) => {
    console.error("Bot error:", err.error);
  });

  return bot;
}
