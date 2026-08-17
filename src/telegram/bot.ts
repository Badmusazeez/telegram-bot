import { Bot, Context } from "grammy";
import { isAddress } from "ethers";
import { config } from "../config";
import {
  parseScheduleTime,
  resolveCalldata,
} from "../robinhood/mintScheduler";
import {
  ensureOpenSeaApiKey,
  getOpenSeaKeyStatus,
} from "../robinhood/openseaAuth";
import { resolveScheduleFromOpenSeaLink } from "../robinhood/openseaDrop";
import { parseOpenSeaUrl } from "../robinhood/openseaUrl";
import {
  getAllMintWallets,
  getNativeBalance,
  getProvider,
  getWallet,
  mintWalletCount,
} from "../robinhood/provider";
import {
  addMintWallet,
  listMintWalletPublic,
  removeMintWallet,
} from "../store/mintWallets";
import {
  addScheduledMint,
  addTrackedWallet,
  addWatchedPrice,
  cancelScheduledMint,
  getState,
  registerNotifyChat,
  removeTrackedWallet,
  removeWatchedPrice,
  shortAddress,
  updateState,
} from "../store/state";
import {
  formatPriceAlert,
  formatPurchaseAlert,
  formatScheduleCreated,
  formatScheduleResult,
  formatStatus,
  helpText,
} from "./formatter";
import { getLastCopySummary } from "../robinhood/copyExecutor";
import { getBlockscoutStatus } from "../robinhood/blockscoutWatcher";
import type {
  CopyResult,
  NftPurchase,
  PriceChangeAlert,
  ScheduledMint,
  ScheduledMintResult,
} from "../types";

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
      "robinhood-nft-copy-bot connected.\n\nTip: /track 0xWallet Label\n/help for all commands."
    );
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(helpText(), { parse_mode: "HTML" });
  });

  bot.command("status", async (ctx) => {
    const state = getState();
    const wallets = getAllMintWallets();
    const wallet = wallets[0] ?? getWallet();
    let balanceRobinhood: string | undefined;
    let walletAddress = wallet?.address;
    if (wallets.length > 1) {
      walletAddress = `${wallets.length} wallets (see /listkeys)`;
      try {
        const bals = await Promise.all(
          wallets.map(async (w) => {
            const bal = await getNativeBalance(w.address);
            return `${shortAddress(w.address.toLowerCase())}:${Number(bal).toFixed(4)}`;
          })
        );
        balanceRobinhood = bals.join(" ");
      } catch {
        balanceRobinhood = "?";
      }
    } else if (wallet) {
      try {
        balanceRobinhood = Number(
          await getNativeBalance(wallet.address)
        ).toFixed(4);
      } catch {
        balanceRobinhood = "?";
      }
    }
    const pendingSchedules = state.scheduledMints.filter(
      (j) => j.status === "pending"
    ).length;
    let tipBlock: number | undefined;
    try {
      tipBlock = Number(await getProvider().getBlockNumber());
    } catch {
      tipBlock = undefined;
    }
    await ctx.reply(
      formatStatus({
        trackedCount: state.trackedWallets.length,
        watchedPrices: state.watchedPrices.length,
        pendingSchedules,
        copyEnabled: state.copyEnabled,
        dryRun: state.dryRun,
        freeMintsOnly: state.freeMintsOnly,
        priceAlertsEnabled: state.priceAlertsEnabled,
        priceAlertPct: state.priceAlertPct,
        maxBuyRobinhood: state.maxBuyRobinhood,
        lastBlock: state.lastProcessedBlock,
        tipBlock,
        walletAddress,
        balanceRobinhood,
        lastCopy: getLastCopySummary(),
        blockscout: getBlockscoutStatus(),
      }),
      { parse_mode: "HTML" }
    );
  });

  bot.command("openseakey", async (ctx) => {
    const force = (ctx.match || "").trim().toLowerCase() === "refresh";
    try {
      await ensureOpenSeaApiKey({ forceRefresh: force });
      const st = getOpenSeaKeyStatus();
      await ctx.reply(
        [
          `<b>OpenSea API key</b>`,
          `Present: <b>${st.present ? "yes" : "no"}</b>`,
          `Source: <code>${st.source}</code>`,
          st.maskedKey ? `Key: <code>${st.maskedKey}</code>` : "",
          st.name ? `Name: <code>${st.name}</code>` : "",
          st.expiresAt ? `Expires: <code>${st.expiresAt}</code>` : "",
          ``,
          force
            ? `Refreshed via POST /api/v2/auth/keys`
            : `Auto-fetched on boot. Use /openseakey refresh to force a new key.`,
        ]
          .filter(Boolean)
          .join("\n"),
        { parse_mode: "HTML" }
      );
    } catch (err) {
      await ctx.reply(
        `OpenSea key failed: ${err instanceof Error ? err.message : String(err)}\n` +
          `On VPS try: curl -s -X POST https://api.opensea.io/api/v2/auth/keys`
      );
    }
  });

  bot.command("addkey", async (ctx) => {
    const parts = (ctx.match || "").trim().split(/\s+/).filter(Boolean);
    const key = parts[0];
    const label = parts.slice(1).join(" ") || undefined;
    if (!key) {
      await ctx.reply(
        "Usage: /addkey &lt;private_key&gt; [label]\n\n⚠️ Prefer setting PRIVATE_KEYS in VPS .env — Telegram is not fully private. Bot will try to delete your message.",
        { parse_mode: "HTML" }
      );
      return;
    }
    try {
      // Best-effort: remove the private key from chat history
      if (ctx.message?.message_id) {
        await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => undefined);
      }
      const wallet = await addMintWallet(key, label);
      await ctx.reply(
        [
          "✅ Mint wallet added.",
          `Address: <code>${wallet.address}</code>`,
          `Label: ${escape(wallet.label)}`,
          `Total mint wallets: <b>${mintWalletCount()}</b>`,
          "",
          "Free-mint copies + scheduled mints fire on <b>all</b> wallets at once.",
          "⚠️ Delete chat history if the key was still visible.",
        ].join("\n"),
        { parse_mode: "HTML" }
      );
    } catch (error) {
      await ctx.reply(
        `❌ ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });

  bot.command("listkeys", async (ctx) => {
    const wallets = listMintWalletPublic();
    if (wallets.length === 0) {
      await ctx.reply(
        "No mint wallets yet.\nUse /addkey &lt;private_key&gt; or set PRIVATE_KEY / PRIVATE_KEYS in .env",
        { parse_mode: "HTML" }
      );
      return;
    }
    const lines = wallets.map(
      (w, i) =>
        `${i + 1}. <b>${escape(w.label)}</b>\n   <code>${w.address}</code>`
    );
    await ctx.reply(
      `<b>Mint wallets</b> (addresses only — keys never shown)\n\n${lines.join("\n\n")}`,
      { parse_mode: "HTML" }
    );
  });

  bot.command("removekey", async (ctx) => {
    const address = (ctx.match || "").trim();
    if (!address || !isAddress(address)) {
      await ctx.reply("Usage: /removekey 0xWalletAddress");
      return;
    }
    const removed = await removeMintWallet(address);
    await ctx.reply(
      removed
        ? `🗑️ Removed mint wallet <code>${address.toLowerCase()}</code>\nRemaining: <b>${mintWalletCount()}</b>`
        : "That address was not in the mint wallet list.",
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
      (w, i) =>
        `${i + 1}. <b>${escape(w.label)}</b>\n   <code>${w.address}</code>`
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
      `👀 <b>Tracking ${escape(wallet.label)}</b>\n<code>${wallet.address}</code>\n\nYou'll get <b>Mint Detected (${escape(wallet.label)})</b> when this wallet free-mints.`,
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

  bot.command("golive", async (ctx) => {
    const wallets = getAllMintWallets();
    if (wallets.length === 0) {
      await ctx.reply(
        "No mint wallets. Add one first:\n/addkey <private_key>\nor set PRIVATE_KEY in .env"
      );
      return;
    }
    await updateState((s) => {
      s.copyEnabled = true;
      s.dryRun = false;
      s.freeMintsOnly = true;
    });
    await ctx.reply(
      [
        "<b>LIVE MAX MINT enabled</b>",
        "• /copy on",
        "• /dryrun off",
        "• /freemints on",
        ``,
        `Wallets: <b>${wallets.length}</b>`,
        `Fund each with Robinhood Chain gas, then keep the bot running.`,
      ].join("\n"),
      { parse_mode: "HTML" }
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
        : "Dry-run OFF — live free-mint replay enabled (needs PRIVATE_KEY + Robinhood gas)."
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
      s.maxBuyRobinhood = value;
    });
    await ctx.reply(`Max buy set to ${value} (Robinhood native)`);
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

  bot.command("prices", async (ctx) => {
    const list = getState().watchedPrices;
    if (list.length === 0) {
      await ctx.reply(
        "No price watches yet.\nSuccessful free mints are auto-watched.\nOr use /watchprice 0xContract [tokenId]"
      );
      return;
    }
    const lines = list.map((w, i) => {
      const price =
        w.lastPrice === null ? "—" : w.lastPrice.toFixed(6);
      const token = w.tokenId ? `#${w.tokenId}` : "floor";
      return `${i + 1}. <b>${escape(w.label)}</b> (${token})\n   <code>${w.contract}</code>\n   last: ${price}`;
    });
    await ctx.reply(`<b>Watched prices</b>\n\n${lines.join("\n\n")}`, {
      parse_mode: "HTML",
    });
  });

  bot.command("watchprice", async (ctx) => {
    const parts = (ctx.match || "").trim().split(/\s+/).filter(Boolean);
    const contract = parts[0];
    const tokenId = parts[1];
    if (!contract || !isAddress(contract)) {
      await ctx.reply(
        "Usage:\n/watchprice 0xContract\n/watchprice 0xContract 123"
      );
      return;
    }
    const item = await addWatchedPrice({
      contract,
      tokenId,
      label: tokenId
        ? `${shortAddress(contract.toLowerCase())} #${tokenId}`
        : `${shortAddress(contract.toLowerCase())} floor`,
    });
    await registerNotifyChat(chatId(ctx));
    await ctx.reply(
      `Watching price for <b>${escape(item.label)}</b>\n<code>${item.contract}</code>${
        item.tokenId ? `\nToken <code>${item.tokenId}</code>` : "\n(collection floor)"
      }`,
      { parse_mode: "HTML" }
    );
  });

  bot.command("unwatchprice", async (ctx) => {
    const parts = (ctx.match || "").trim().split(/\s+/).filter(Boolean);
    const contract = parts[0];
    const tokenId = parts[1] || "";
    if (!contract || !isAddress(contract)) {
      await ctx.reply("Usage: /unwatchprice 0xContract [tokenId]");
      return;
    }
    const removed = await removeWatchedPrice(contract, tokenId);
    await ctx.reply(removed ? "Stopped watching that price." : "Not watched.");
  });

  bot.command("pricealerts", async (ctx) => {
    const arg = (ctx.match || "").trim().toLowerCase();
    if (arg !== "on" && arg !== "off") {
      await ctx.reply("Usage: /pricealerts on|off");
      return;
    }
    await updateState((s) => {
      s.priceAlertsEnabled = arg === "on";
    });
    await ctx.reply(`Price alerts are now <b>${arg.toUpperCase()}</b>`, {
      parse_mode: "HTML",
    });
  });

  bot.command("pricepct", async (ctx) => {
    const value = Number((ctx.match || "").trim());
    if (!Number.isFinite(value) || value <= 0) {
      await ctx.reply("Usage: /pricepct 10");
      return;
    }
    await updateState((s) => {
      s.priceAlertPct = value;
    });
    await ctx.reply(`Price alert threshold set to ${value}%`);
  });

  bot.command("schedulemint", async (ctx) => {
    const parts = (ctx.match || "").trim().split(/\s+/).filter(Boolean);
    if (parts.length < 1) {
      await ctx.reply(
        [
          "Easiest (auto time from OpenSea Drop):",
          "/schedulemint https://opensea.io/collection/your-drop",
          "/schedulemint https://opensea.io/assets/robinhood/0xContract/1",
          "",
          "Manual time:",
          "/schedulemint +5m https://opensea.io/assets/robinhood/0xContract/1",
          "",
          "Advanced:",
          "/schedulemint <when> <contract> <mint|mint1|0xcalldata>",
          "",
          "Needs OpenSea API key (auto via POST /api/v2/auth/keys, or OPENSEA_API_KEY).",
        ].join("\n")
      );
      return;
    }

    // Link-only: /schedulemint <opensea-url>
    if (parts.length === 1 && parseOpenSeaUrl(parts[0])) {
      try {
        await ctx.reply("Looking up OpenSea drop schedule…");
        const resolved = await resolveScheduleFromOpenSeaLink(parts[0]);
        const job = await addScheduledMint({
          label: `opensea ${resolved.name} (${resolved.stageLabel})`,
          to: resolved.contract,
          // Placeholder; rebuilt from OpenSea Drops API at fire time.
          data: "0x",
          executeAt: resolved.executeAt,
          openSeaSlug: resolved.slug,
        });
        await registerNotifyChat(chatId(ctx));
        await ctx.reply(
          [
            formatScheduleCreated(job),
            ``,
            `<b>OpenSea drop:</b> <a href="${escape(resolved.openSeaUrl)}">${escape(resolved.name)}</a>`,
            `<b>Stage:</b> ${escape(resolved.stageLabel)} (${escape(resolved.stageType)})`,
            `<b>Time source:</b> OpenSea ${resolved.isLive ? "(live now → mint ASAP)" : "next stage start"}`,
            `<i>Calldata will be built from OpenSea at mint time. Allowlist stages may still revert.</i>`,
          ].join("\n"),
          { parse_mode: "HTML" }
        );
      } catch (err) {
        await ctx.reply(
          `❌ ${err instanceof Error ? err.message : String(err)}`
        );
      }
      return;
    }

    if (parts.length < 2) {
      await ctx.reply(
        "Usage:\n/schedulemint <opensea-url>\n/schedulemint <when> <opensea-url>\n/schedulemint <when> <contract> mint1"
      );
      return;
    }

    // Support either: /schedulemint +5m <url>  OR  /schedulemint <url> +5m
    let whenRaw = parts[0];
    let targetRaw = parts[1];
    let dataRaw = parts[2] || "mint1";
    if (parseOpenSeaUrl(parts[0]) && parseScheduleTime(parts[1])) {
      whenRaw = parts[1];
      targetRaw = parts[0];
      dataRaw = parts[2] || "mint1";
    }

    const when = parseScheduleTime(whenRaw);
    if (!when || when.getTime() <= Date.now()) {
      await ctx.reply("Invalid/past time. Use +5m, +2h, or ISO like 2026-07-31T18:00:00Z");
      return;
    }

    const openSea = parseOpenSeaUrl(targetRaw);
    if (openSea) {
      // Manual time + OpenSea link: still prefer Drop API schedule metadata / slug.
      try {
        const resolved = await resolveScheduleFromOpenSeaLink(targetRaw);
        const job = await addScheduledMint({
          label: `opensea ${resolved.name} (manual time)`,
          to: resolved.contract,
          data: "0x",
          executeAt: when,
          openSeaSlug: resolved.slug,
        });
        await registerNotifyChat(chatId(ctx));
        await ctx.reply(
          [
            formatScheduleCreated(job),
            ``,
            `<b>OpenSea drop:</b> ${escape(resolved.name)}`,
            `<b>Note:</b> using your manual time (OpenSea stage was ${escape(resolved.executeAt.toISOString())}).`,
          ].join("\n"),
          { parse_mode: "HTML" }
        );
      } catch (err) {
        // Fallback: contract from asset URL + mint1
        if (openSea.kind === "asset" && openSea.contract) {
          const wallet = getWallet();
          const data = resolveCalldata(dataRaw, wallet?.address || openSea.contract);
          if (!data) {
            await ctx.reply("Invalid calldata. Use mint / mint1 / 0x...");
            return;
          }
          const job = await addScheduledMint({
            label: `opensea ${shortAddress(openSea.contract)}${openSea.tokenId ? ` #${openSea.tokenId}` : ""}`,
            to: openSea.contract,
            data,
            executeAt: when,
          });
          await registerNotifyChat(chatId(ctx));
          await ctx.reply(
            `${formatScheduleCreated(job)}\n\n<i>OpenSea Drop API unavailable (${escape(
              err instanceof Error ? err.message : String(err)
            )}). Scheduled with mint1 fallback.</i>`,
            { parse_mode: "HTML" }
          );
          return;
        }
        await ctx.reply(`❌ ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    if (!isAddress(targetRaw)) {
      await ctx.reply(
        "Invalid target. Paste an OpenSea NFT/collection link or a 0x contract address."
      );
      return;
    }

    if (parts.length < 3) {
      await ctx.reply(
        "For contract address form, include mint function:\n/schedulemint +5m 0xContract mint1"
      );
      return;
    }

    const wallet = getWallet();
    const data = resolveCalldata(dataRaw, wallet?.address || targetRaw);
    if (!data) {
      await ctx.reply("Invalid calldata. Use hex 0x... or presets: mint / mint1");
      return;
    }
    const job = await addScheduledMint({
      label: `mint ${shortAddress(targetRaw.toLowerCase())}`,
      to: targetRaw,
      data,
      executeAt: when,
    });
    await registerNotifyChat(chatId(ctx));
    await ctx.reply(formatScheduleCreated(job), { parse_mode: "HTML" });
  });

  bot.command("schedulemintfromtx", async (ctx) => {
    const parts = (ctx.match || "").trim().split(/\s+/).filter(Boolean);
    if (parts.length < 2) {
      await ctx.reply(
        "Usage:\n/schedulemintfromtx <txHash> <when>\n\nExample:\n/schedulemintfromtx 0xabc... +2m"
      );
      return;
    }
    const txHash = parts[0];
    const when = parseScheduleTime(parts[1]);
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      await ctx.reply("Invalid tx hash.");
      return;
    }
    if (!when || when.getTime() <= Date.now()) {
      await ctx.reply("Invalid/past time. Use +5m, +2h, or ISO time.");
      return;
    }

    try {
      const tx = await getProvider().getTransaction(txHash);
      if (!tx?.to || !tx.data || tx.data === "0x") {
        await ctx.reply("Source tx has no mint calldata.");
        return;
      }
      if (tx.value > 0n) {
        await ctx.reply("Source tx is paid (value > 0). Free-mint scheduler skipped it.");
        return;
      }
      const job = await addScheduledMint({
        label: `fromtx ${txHash.slice(0, 10)}…`,
        to: tx.to,
        data: tx.data,
        executeAt: when,
        sourceTxHash: txHash,
      });
      await registerNotifyChat(chatId(ctx));
      await ctx.reply(formatScheduleCreated(job), { parse_mode: "HTML" });
    } catch (err) {
      await ctx.reply(
        `Failed to load tx: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  });

  bot.command("schedules", async (ctx) => {
    const list = getState().scheduledMints.slice(-20).reverse();
    if (list.length === 0) {
      await ctx.reply("No scheduled mints.");
      return;
    }
    const lines = list.map((j) => {
      return `• <code>${j.id}</code> [${j.status}]\n  ${escape(j.label)}\n  when: <code>${j.executeAt}</code>\n  to: <code>${j.to}</code>`;
    });
    await ctx.reply(`<b>Scheduled mints</b>\n\n${lines.join("\n\n")}`, {
      parse_mode: "HTML",
    });
  });

  bot.command("cancelschedule", async (ctx) => {
    const id = (ctx.match || "").trim();
    if (!id) {
      await ctx.reply("Usage: /cancelschedule sch_...");
      return;
    }
    const ok = await cancelScheduledMint(id);
    await ctx.reply(ok ? `Cancelled ${id}` : "Not found or not pending.");
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

export async function broadcastPriceAlert(
  bot: Bot,
  alert: PriceChangeAlert
): Promise<void> {
  const state = getState();
  const text = formatPriceAlert(alert);
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
      console.error(`[telegram] failed price alert to ${id}:`, err);
    }
  }
}

export async function broadcastScheduleResult(
  bot: Bot,
  job: ScheduledMint,
  result: ScheduledMintResult
): Promise<void> {
  const state = getState();
  const text = formatScheduleResult(job, result);
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
      console.error(`[telegram] failed schedule notify to ${id}:`, err);
    }
  }
}

/** Avoid spamming Telegram when RPC keeps returning quota errors. */
const RPC_ALERT_COOLDOWN_MS = 10 * 60 * 1000;
let lastRpcAlertAt = 0;
let lastRpcAlertKind = "";

export async function broadcastRpcAlert(
  bot: Bot,
  text: string,
  kind = "quota"
): Promise<void> {
  const now = Date.now();
  // Separate cooldowns per kind so Alchemy + Chainstack can both alert.
  if (kind === lastRpcAlertKind && now - lastRpcAlertAt < RPC_ALERT_COOLDOWN_MS) {
    return;
  }
  lastRpcAlertAt = now;
  lastRpcAlertKind = kind;

  const state = getState();
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
      console.error(`[telegram] failed RPC alert to ${id}:`, err);
    }
  }
}

/** Unthrottled HTML broadcast (heartbeat / status pulses). */
export async function broadcastHtml(bot: Bot, text: string): Promise<void> {
  const state = getState();
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
      console.error(`[telegram] failed broadcast to ${id}:`, err);
    }
  }
}
