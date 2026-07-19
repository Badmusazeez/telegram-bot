import { Bot, Context } from "grammy";
import { isAddress } from "ethers";
import { config } from "../config";
import { getEthBalance, getWallet } from "../ethereum/provider";
import {
  addTrackedWallet,
  getState,
  registerNotifyChat,
  removeTrackedWallet,
  shortAddress,
  updateState,
} from "../store/state";
import { formatPurchaseAlert, formatStatus, helpText } from "./formatter";
import type { CopyResult, NftPurchase } from "../types";

function chatId(ctx: Context): string {
  return String(ctx.chat?.id ?? "");
}

function isAuthorized(ctx: Context): boolean {
  if (config.allowedChatIds.size === 0) {
    return true;
  }
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
      "Connected. You will receive NFT alerts here.\n\nTip: /track 0xWallet Label\n/help for all commands."
    );
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(helpText(), { parse_mode: "HTML" });
  });

  bot.command("status", async (ctx) => {
    const state = getState();
    const wallet = getWallet();
    let balanceEth: string | undefined;
    if (wallet) {
      try {
        balanceEth = Number(await getEthBalance(wallet.address)).toFixed(4);
      } catch {
        balanceEth = "?";
      }
    }
    await ctx.reply(
      formatStatus({
        trackedCount: state.trackedWallets.length,
        copyEnabled: state.copyEnabled,
        dryRun: state.dryRun,
        freeMintsOnly: state.freeMintsOnly,
        maxBuyEth: state.maxBuyEth,
        lastBlock: state.lastProcessedBlock,
        walletAddress: wallet?.address,
        balanceEth,
      }),
      { parse_mode: "HTML" }
    );
  });

  bot.command("wallets", async (ctx) => {
    const { trackedWallets } = getState();
    if (trackedWallets.length === 0) {
      await ctx.reply("No wallets tracked yet. Use /track <address> [label]");
      return;
    }
    const lines = trackedWallets.map(
      (w, i) => `${i + 1}. <b>${escape(w.label)}</b>\n   <code>${w.address}</code>`
    );
    await ctx.reply(`<b>Tracked wallets</b>\n\n${lines.join("\n\n")}`, {
      parse_mode: "HTML",
    });
  });

  bot.command("track", async (ctx) => {
    const parts = (ctx.match || "").trim().split(/\s+/).filter(Boolean);
    const address = parts[0];
    const label = parts.slice(1).join(" ");
    if (!address || !isAddress(address)) {
      await ctx.reply("Usage: /track 0xAddress [optional label]");
      return;
    }
    const wallet = await addTrackedWallet(address, label);
    await registerNotifyChat(chatId(ctx));
    await ctx.reply(
      `Tracking <b>${escape(wallet.label)}</b>\n<code>${wallet.address}</code>`,
      { parse_mode: "HTML" }
    );
  });

  bot.command("untrack", async (ctx) => {
    const address = (ctx.match || "").trim();
    if (!address || !isAddress(address)) {
      await ctx.reply("Usage: /untrack 0xAddress");
      return;
    }
    const removed = await removeTrackedWallet(address);
    await ctx.reply(
      removed
        ? `Stopped tracking ${shortAddress(address.toLowerCase())}`
        : "That address was not tracked."
    );
  });

  bot.command("copy", async (ctx) => {
    const arg = (ctx.match || "").trim().toLowerCase();
    if (arg !== "on" && arg !== "off") {
      await ctx.reply("Usage: /copy on|off");
      return;
    }
    await updateState((s) => {
      s.copyEnabled = arg === "on";
    });
    await ctx.reply(`Auto-mint is now <b>${arg.toUpperCase()}</b>`, {
      parse_mode: "HTML",
    });
  });

  bot.command("dryrun", async (ctx) => {
    const arg = (ctx.match || "").trim().toLowerCase();
    if (arg !== "on" && arg !== "off") {
      await ctx.reply("Usage: /dryrun on|off");
      return;
    }
    await updateState((s) => {
      s.dryRun = arg === "on";
    });
    await ctx.reply(
      arg === "on"
        ? "Dry-run ON — bot will simulate free-mint copies only."
        : "Dry-run OFF — live free-mint replay enabled (needs PRIVATE_KEY + gas ETH)."
    );
  });

  bot.command("freemints", async (ctx) => {
    const arg = (ctx.match || "").trim().toLowerCase();
    if (arg !== "on" && arg !== "off") {
      await ctx.reply("Usage: /freemints on|off");
      return;
    }
    await updateState((s) => {
      s.freeMintsOnly = arg === "on";
    });
    await ctx.reply(
      arg === "on"
        ? "Free-mints-only ON — paid buys will be skipped."
        : "Free-mints-only OFF — bot will watch broader NFT activity."
    );
  });

  bot.command("maxbuy", async (ctx) => {
    const arg = (ctx.match || "").trim();
    const value = Number(arg);
    if (!Number.isFinite(value) || value <= 0) {
      await ctx.reply("Usage: /maxbuy 0.05");
      return;
    }
    await updateState((s) => {
      s.maxBuyEth = value;
    });
    await ctx.reply(`Max buy set to ${value} ETH`);
  });

  bot.command("allow", async (ctx) => {
    const arg = (ctx.match || "").trim().toLowerCase();
    if (!arg) {
      const list = getState().allowedCollections;
      await ctx.reply(
        list.length
          ? `Allowlist:\n${list.map((c) => `<code>${c}</code>`).join("\n")}`
          : "Allowlist empty (all collections allowed).\nUsage: /allow 0xContract | /allow clear",
        { parse_mode: "HTML" }
      );
      return;
    }
    if (arg === "clear") {
      await updateState((s) => {
        s.allowedCollections = [];
      });
      await ctx.reply("Allowlist cleared — all collections allowed.");
      return;
    }
    if (!isAddress(arg)) {
      await ctx.reply("Usage: /allow 0xContract | /allow clear");
      return;
    }
    await updateState((s) => {
      if (!s.allowedCollections.includes(arg)) {
        s.allowedCollections.push(arg);
      }
    });
    await ctx.reply(`Added to allowlist:\n<code>${arg}</code>`, {
      parse_mode: "HTML",
    });
  });

  bot.catch((err) => {
    console.error("[telegram] bot error:", err);
  });

  return bot;
}

function escape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export async function broadcastPurchase(
  bot: Bot,
  purchase: NftPurchase,
  copy: CopyResult
): Promise<void> {
  const state = getState();
  const text = formatPurchaseAlert(purchase, copy);
  const targets =
    state.notifyChatIds.length > 0
      ? state.notifyChatIds
      : [...config.allowedChatIds];

  for (const id of targets) {
    try {
      await bot.api.sendMessage(id, text, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
    } catch (err) {
      console.error(`[telegram] failed to notify ${id}:`, err);
    }
  }
}
