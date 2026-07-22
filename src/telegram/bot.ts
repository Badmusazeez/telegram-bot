import { Bot, Context } from "grammy";
import { config } from "../config";
import {
  getState,
  markAlertSent,
  registerNotifyChat,
  setPaused,
} from "../store/state";
import type { TradeSignal } from "../types";
import { formatSignalAlert, formatStatus, helpText } from "./formatter";

function chatId(ctx: Context): string {
  return String(ctx.chat?.id ?? "");
}

function isAuthorized(ctx: Context): boolean {
  if (config.allowedChatIds.size === 0) return true;
  return config.allowedChatIds.has(chatId(ctx));
}

async function deny(ctx: Context): Promise<void> {
  await ctx.reply(
    `Unauthorized chat (${chatId(ctx)}). Add it to TELEGRAM_ALLOWED_CHAT_IDS.`
  );
}

export function createTelegramBot(): Bot {
  const bot = new Bot(config.telegramToken);

  bot.use(async (ctx, next) => {
    if (!isAuthorized(ctx)) {
      if (ctx.message?.text?.startsWith("/")) {
        await deny(ctx);
      }
      return;
    }
    await next();
  });

  bot.command("start", async (ctx) => {
    await registerNotifyChat(chatId(ctx));
    await ctx.reply(
      "Connected. You will receive Binance Futures BUY/SELL alerts here.\n\n/help for commands."
    );
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(helpText(), { parse_mode: "HTML" });
  });

  bot.command("status", async (ctx) => {
    const state = getState();
    await ctx.reply(formatStatus(state.stats, state.paused), {
      parse_mode: "HTML",
    });
  });

  bot.command("pause", async (ctx) => {
    await setPaused(true);
    await ctx.reply("Scanner paused. /resume to continue.");
  });

  bot.command("resume", async (ctx) => {
    await setPaused(false);
    await ctx.reply("Scanner resumed.");
  });

  bot.catch((err) => {
    console.error("[telegram]", err);
  });

  return bot;
}

export async function broadcastSignal(
  bot: Bot,
  signal: TradeSignal
): Promise<void> {
  if (!config.alertsEnabled) {
    console.log("[alert] ALERTS_ENABLED=false — skipping send");
    return;
  }
  if (config.dryRun) {
    console.log("[alert] DRY_RUN — would send:\n" + formatSignalAlert(signal));
    return;
  }

  const state = getState();
  const targets = new Set<string>([
    ...state.notifyChatIds,
    ...config.allowedChatIds,
  ]);

  if (targets.size === 0) {
    console.warn(
      "[alert] No chat ids registered. Message your bot with /start or set TELEGRAM_ALLOWED_CHAT_IDS."
    );
    return;
  }

  const text = formatSignalAlert(signal);
  for (const id of targets) {
    try {
      await bot.api.sendMessage(id, text, { parse_mode: "HTML" });
      await markAlertSent();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[alert] failed for chat ${id}: ${msg}`);
    }
  }
}
