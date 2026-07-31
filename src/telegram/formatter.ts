import { config } from "../config";
import { describeWallet } from "../eth/monitor";
import { BOT } from "../identity";
import { shortAddress } from "../store/state";
import type {
  CopyResult,
  NftPurchase,
  PriceChangeAlert,
  ScheduledMint,
  ScheduledMintResult,
} from "../types";

function escHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function formatPurchaseAlert(
  purchase: NftPurchase,
  copy: CopyResult
): string {
  const title = purchase.tokenName || `Token #${purchase.tokenId}`;
  const collection = purchase.collectionName || shortAddress(purchase.contract);
  const kind = purchase.isFreeMint
    ? "FREE MINT"
    : purchase.isPrivateMint
      ? `PRIVATE MINT (${purchase.valueEth} ETH)`
      : purchase.isPaid
        ? "PAID"
        : "TRANSFER";
  const txUrl = config.chain.explorerTxUrl(purchase.txHash);
  const openSeaUrl = `https://opensea.io/assets/${config.chain.openseaChain}/${purchase.contract}/${purchase.tokenId}`;
  const copyTx = copy.txHash
    ? `\n<b>Our tx:</b> <a href="${config.chain.explorerTxUrl(copy.txHash)}">explorer</a>`
    : "";

  return [
    `<b>@${BOT.telegramUsername} alert</b>`,
    `<b>Bot:</b> ${escHtml(BOT.title)} (Ethereum)`,
    `<b>Chain:</b> ${escHtml(config.chain.name)}`,
    `<b>Type:</b> ${kind}`,
    ``,
    `<b>Wallet:</b> ${escHtml(describeWallet(purchase.buyer))}`,
    `<b>Collection:</b> ${escHtml(collection)}`,
    `<b>Item:</b> ${escHtml(title)}`,
    `<b>Token ID:</b> <code>${escHtml(purchase.tokenId)}</code>`,
    `<b>Contract:</b> <code>${escHtml(purchase.contract)}</code>`,
    purchase.valueEth > 0
      ? `<b>Price:</b> ${purchase.valueEth} ETH`
      : `<b>Price:</b> free`,
    `<b>Whale tx:</b> <a href="${txUrl}">explorer</a>`,
    `<b>OpenSea:</b> <a href="${openSeaUrl}">view</a>`,
    ``,
    `<b>Auto-mint:</b> ${escHtml(copy.reason)}${copyTx}`,
  ].join("\n");
}

export function formatPriceAlert(alert: PriceChangeAlert): string {
  const direction =
    alert.changePct !== null && alert.changePct >= 0 ? "UP" : "DOWN";
  const pct =
    alert.changePct === null ? "n/a" : `${alert.changePct.toFixed(2)}%`;
  const oldP = alert.oldPrice === null ? "—" : alert.oldPrice.toFixed(6);
  const kind = alert.item.tokenId ? "Token listing" : "Collection floor";

  return [
    `<b>Price alert</b>`,
    `<b>Chain:</b> ${escHtml(config.chain.name)}`,
    `<b>Type:</b> ${kind} ${direction}`,
    `<b>Item:</b> ${escHtml(alert.item.label)}`,
    `<b>Contract:</b> <code>${escHtml(alert.item.contract)}</code>`,
    alert.item.tokenId
      ? `<b>Token ID:</b> <code>${escHtml(alert.item.tokenId)}</code>`
      : `<b>Watch:</b> collection floor`,
    `<b>Old:</b> ${oldP} ETH`,
    `<b>New:</b> ${alert.newPrice.toFixed(6)} ETH`,
    `<b>Change:</b> ${escHtml(pct)}`,
    `<b>OpenSea:</b> <a href="${alert.openSeaUrl}">view</a>`,
  ].join("\n");
}

export function formatStatus(params: {
  trackedCount: number;
  watchedPrices: number;
  pendingSchedules: number;
  copyEnabled: boolean;
  dryRun: boolean;
  freeMintsOnly: boolean;
  privateMintsEnabled: boolean;
  priceAlertsEnabled: boolean;
  priceAlertPct: number;
  maxBuyEth: number;
  lastBlock: number;
  walletAddress?: string;
  balanceEth?: string;
}): string {
  const mode = params.freeMintsOnly
    ? "FREE MINTS ONLY"
    : params.privateMintsEnabled
      ? "FREE + PRIVATE MINTS"
      : "FREE MINTS (private off)";

  return [
    `<b>@${BOT.telegramUsername} status</b>`,
    ``,
    `Bot: <b>${escHtml(BOT.title)}</b> · Telegram <code>@${BOT.telegramUsername}</code>`,
    `Chain: <b>${escHtml(config.chain.name)}</b> (<code>${config.chain.chainId}</code>) — Ethereum only`,
    `Not related to <code>@${BOT.siblingBot}</code> (Robinhood).`,
    `Mode: <b>${mode}</b>`,
    `Tracked wallets: <b>${params.trackedCount}</b>`,
    `Price watches: <b>${params.watchedPrices}</b>`,
    `Scheduled mints: <b>${params.pendingSchedules}</b> pending`,
    `Price alerts: <b>${params.priceAlertsEnabled ? "ON" : "OFF"}</b> (≥${params.priceAlertPct}%)`,
    `Auto-mint: <b>${params.copyEnabled ? "ON" : "OFF"}</b>`,
    `Dry run: <b>${params.dryRun ? "ON" : "OFF"}</b>`,
    `Private mints: <b>${params.privateMintsEnabled ? "ON" : "OFF"}</b>`,
    `Max buy (private mints): <b>${params.maxBuyEth} ETH</b>`,
    `Last block: <code>${params.lastBlock || "—"}</code>`,
    params.walletAddress
      ? `Bot wallet: <code>${escHtml(params.walletAddress)}</code> (balance ${escHtml(params.balanceEth ?? "?")} ETH)`
      : `Bot wallet: <i>not configured</i>`,
  ].join("\n");
}

export function helpText(): string {
  return [
    `<b>@${BOT.telegramUsername}</b> — ${escHtml(BOT.title)}`,
    `Active chain: <b>${escHtml(config.chain.name)}</b> (Ethereum only)`,
    `Separate from <code>@${BOT.siblingBot}</code> (Robinhood Chain).`,
    ``,
    `Tracks whale wallets and auto-copies <b>free mints</b> + optional <b>private/paid mints</b> (under max buy) on Ethereum.`,
    `Secondary marketplace buys are always skipped.`,
    ``,
    `<b>Commands</b>`,
    `/start — register this chat for alerts`,
    `/help — show this help`,
    `/status — bot + wallet status`,
    `/wallets — list tracked wallets`,
    `/track &lt;address&gt; [label] — track a wallet`,
    `/untrack &lt;address&gt; — stop tracking`,
    `/copy on|off — toggle auto-mint`,
    `/dryrun on|off — toggle simulation mode`,
    `/freemints on|off — free-only vs free+private`,
    `/privatemints on|off — allow private/paid mints under max buy`,
    `/addkey &lt;private_key&gt; [label] — add another mint wallet`,
    `/listkeys — list mint wallet addresses`,
    `/removekey &lt;address&gt; — remove a mint wallet`,
    `/maxbuy &lt;amount&gt; — max ETH for private mints`,
    `/allow &lt;contract|clear&gt; — collection allowlist`,
    `/prices — list watched NFT prices`,
    `/watchprice &lt;contract&gt; [tokenId] — watch token or collection floor`,
    `/unwatchprice &lt;contract&gt; [tokenId] — stop watching`,
    `/pricealerts on|off — toggle price alerts`,
    `/pricepct &lt;percent&gt; — alert when price moves by this %`,
    `/schedulemint &lt;when&gt; &lt;contract&gt; &lt;calldata|mint|mint1&gt;`,
    `/schedulemintfromtx &lt;txHash&gt; &lt;when&gt; — copy whale mint calldata`,
    `/schedules — list scheduled mints`,
    `/cancelschedule &lt;id&gt; — cancel a pending schedule`,
  ].join("\n");
}

export function formatScheduleCreated(job: ScheduledMint): string {
  const valueEth =
    job.valueWei && job.valueWei !== "0"
      ? (Number(job.valueWei) / 1e18).toFixed(6)
      : "0";
  return [
    `<b>Mint scheduled</b>`,
    `<b>ID:</b> <code>${escHtml(job.id)}</code>`,
    `<b>Label:</b> ${escHtml(job.label)}`,
    `<b>When:</b> <code>${escHtml(job.executeAt)}</code>`,
    `<b>To:</b> <code>${escHtml(job.to)}</code>`,
    `<b>Value:</b> ${valueEth} ETH`,
    `<b>Data:</b> <code>${escHtml(job.data.slice(0, 66))}${job.data.length > 66 ? "…" : ""}</code>`,
    job.sourceTxHash
      ? `<b>Source tx:</b> <a href="${config.chain.explorerTxUrl(job.sourceTxHash)}">explorer</a>`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatScheduleResult(
  job: ScheduledMint,
  result: ScheduledMintResult
): string {
  const tx = result.txHash
    ? `\n<b>Tx:</b> <a href="${config.chain.explorerTxUrl(result.txHash)}">explorer</a>`
    : "";
  return [
    `<b>Scheduled mint ${result.success ? "DONE" : "FAILED"}</b>`,
    `<b>ID:</b> <code>${escHtml(job.id)}</code>`,
    `<b>Label:</b> ${escHtml(job.label)}`,
    `<b>When:</b> <code>${escHtml(job.executeAt)}</code>`,
    `<b>Result:</b> ${escHtml(result.reason)}${tx}`,
  ].join("\n");
}
