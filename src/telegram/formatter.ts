import { config } from "../config";
import { getState, shortAddress } from "../store/state";
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

/** Label for a tracked whale wallet (e.g. "davin"), else short address. */
export function trackedWalletLabel(address: string): string {
  const normalized = address.toLowerCase();
  const wallet = getState().trackedWallets.find(
    (w) => w.address.toLowerCase() === normalized
  );
  return wallet?.label?.trim() || shortAddress(normalized);
}

export function formatPurchaseAlert(
  purchase: NftPurchase,
  copy: CopyResult
): string {
  const label = trackedWalletLabel(purchase.buyer);
  const title = purchase.tokenName || `Token #${purchase.tokenId}`;
  const collection = purchase.collectionName || shortAddress(purchase.contract);
  const kind = purchase.isFreeMint
    ? "FREE MINT"
    : purchase.isPaid
      ? "PAID"
      : "TRANSFER";
  const txUrl = config.chain.explorerTxUrl(purchase.txHash);
  const openSeaUrl = `https://opensea.io/assets/${config.chain.openseaChain}/${purchase.contract}/${purchase.tokenId}`;
  const buyerUrl = config.chain.explorerAddressUrl(purchase.buyer);
  const contractUrl = config.chain.explorerAddressUrl(purchase.contract);

  const copyTx = copy.txHash
    ? `\n<b>Our tx:</b> <a href="${config.chain.explorerTxUrl(copy.txHash)}">explorer</a>`
    : "";

  const reason = escHtml((copy.reason || "").slice(0, 280));
  const mintLine =
    copy.success && !copy.dryRun
      ? `<b>Auto-mint:</b> ✅ MINTED — ${reason}${copyTx}`
      : copy.dryRun
        ? `<b>Auto-mint:</b> ⚠️ ${reason}`
        : `<b>Auto-mint:</b> ❌ ${reason}${copyTx}`;

  const via =
    purchase.marketplace === "free-mint"
      ? "free mint"
      : escHtml(purchase.marketplace || "on-chain");

  return [
    `<b>Mint Detected (${escHtml(label)})</b>`,
    `<b>Type:</b> ${kind}`,
    ``,
    `<b>Tracked wallet:</b> <b>${escHtml(label)}</b>`,
    `👛 <code>${escHtml(purchase.buyer)}</code>`,
    `<a href="${buyerUrl}">view wallet</a>`,
    ``,
    `<b>Collection:</b> ${escHtml(collection)}`,
    `<b>Item:</b> ${escHtml(title)}`,
    `📄 <b>Contract:</b> <code>${escHtml(purchase.contract)}</code>`,
    `<a href="${contractUrl}">view contract</a>`,
    `<b>Via:</b> ${via}`,
    `<b>Whale tx:</b> <a href="${txUrl}">explorer</a>`,
    `<b>OpenSea:</b> <a href="${openSeaUrl}">view</a>`,
    ``,
    mintLine,
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
    `<b>Old:</b> ${oldP}`,
    `<b>New:</b> ${alert.newPrice.toFixed(6)}`,
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
  priceAlertsEnabled: boolean;
  priceAlertPct: number;
  maxBuyRobinhood: number;
  lastBlock: number;
  tipBlock?: number;
  walletAddress?: string;
  balanceRobinhood?: string;
  lastCopy?: {
    at: string;
    txHash: string;
    success: boolean;
    reason: string;
  } | null;
  blockscout?: {
    lastOkAt: string | null;
    lastError: string | null;
    lastHitTx: string | null;
  };
}): string {
  const lag =
    params.tipBlock && params.lastBlock
      ? Math.max(0, params.tipBlock - params.lastBlock)
      : null;
  const lastCopyLine = params.lastCopy
    ? `Last copy: <b>${params.lastCopy.success ? "OK" : "FAIL"}</b> <code>${escHtml(params.lastCopy.at)}</code>\n<code>${escHtml(params.lastCopy.reason)}</code>`
    : `Last copy: <i>none yet</i>`;
  return [
    `<b>robinhood-nft-copy-bot status</b>`,
    ``,
    `Chain: <b>${escHtml(config.chain.name)}</b> (<code>${config.chain.chainId}</code>)`,
    `Mode: <b>${params.freeMintsOnly ? "FREE MINTS ONLY" : "ALL ACTIVITY"}</b>`,
    `Tracked wallets: <b>${params.trackedCount}</b>`,
    `Price watches: <b>${params.watchedPrices}</b>`,
    `Scheduled mints: <b>${params.pendingSchedules}</b> pending`,
    `Price alerts: <b>${params.priceAlertsEnabled ? "ON" : "OFF"}</b> (≥${params.priceAlertPct}%)`,
    `Detect: Alchemy getLogs + Blockscout transfers`,
    `Auto-mint: <b>${params.copyEnabled ? "ON" : "OFF"}</b>`,
    `Dry run: <b>${params.dryRun ? "ON" : "OFF"}</b>`,
    `Max buy (ignored for free mints): <b>${params.maxBuyRobinhood}</b>`,
    `Last scanned: <code>${params.lastBlock || "—"}</code>`,
    params.tipBlock
      ? `Chain tip: <code>${params.tipBlock}</code>${lag !== null ? ` (behind <b>${lag}</b> blocks)` : ""}`
      : "",
    params.blockscout
      ? `Blockscout: <b>${params.blockscout.lastOkAt ? "ok" : "—"}</b>${params.blockscout.lastOkAt ? ` <code>${escHtml(params.blockscout.lastOkAt)}</code>` : ""}${params.blockscout.lastHitTx ? `\nLast BS hit: <code>${escHtml(params.blockscout.lastHitTx.slice(0, 18))}…</code>` : ""}${params.blockscout.lastError ? `\nBS err: <code>${escHtml(params.blockscout.lastError.slice(0, 120))}</code>` : ""}`
      : "",
    lastCopyLine,
    params.walletAddress
      ? `Bot wallet: <code>${escHtml(params.walletAddress)}</code> (balance ${escHtml(params.balanceRobinhood ?? "?")})`
      : `Bot wallet: <i>not configured</i>`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function helpText(): string {
  return [
    `<b>robinhood-nft-copy-bot</b>`,
    `Active chain: <b>${escHtml(config.chain.name)}</b>`,
    ``,
    `Tracks whale wallets and auto-copies <b>free mints</b> from OpenSea, mint websites, and public contracts. Always tries <b>MAX</b> qty. Paid buys are skipped.`,
    `Also watches minted NFT / collection prices and alerts on Telegram.`,
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
    `/golive — /copy on + /dryrun off (live MAX mint)`,
    `/freemints on|off — free-mints-only filter`,
    `/addkey &lt;private_key&gt; [label] — add another mint wallet`,
    `/listkeys — list mint wallet addresses`,
    `/removekey &lt;address&gt; — remove a mint wallet`,
    `/maxbuy &lt;amount&gt; — max paid price (unused in free-mint mode)`,
    `/allow &lt;contract|clear&gt; — collection allowlist`,
    `/prices — list watched NFT prices`,
    `/watchprice &lt;contract&gt; [tokenId] — watch token or collection floor`,
    `/unwatchprice &lt;contract&gt; [tokenId] — stop watching`,
    `/pricealerts on|off — toggle price alerts`,
    `/pricepct &lt;percent&gt; — alert when price moves by this %`,
    `/openseakey — show OpenSea API key status`,
    `/openseakey refresh — force new instant key (7-day)`,
    `/schedulemint &lt;opensea-url&gt; — auto schedule from OpenSea Drop time`,
    `/schedulemint &lt;when&gt; &lt;opensea-url&gt; — manual time + OpenSea link`,
    `/schedulemint &lt;when&gt; &lt;contract&gt; &lt;mint|mint1|0x...&gt; — advanced`,
    `/schedulemintfromtx &lt;txHash&gt; &lt;when&gt; — copy whale mint calldata`,
    `/schedules — list scheduled mints`,
    `/cancelschedule &lt;id&gt; — cancel a pending schedule`,
  ].join("\n");
}

export function formatScheduleCreated(job: ScheduledMint): string {
  return [
    `<b>Mint scheduled</b>`,
    `<b>ID:</b> <code>${escHtml(job.id)}</code>`,
    `<b>Label:</b> ${escHtml(job.label)}`,
    `<b>When:</b> <code>${escHtml(job.executeAt)}</code>`,
    `<b>To:</b> <code>${escHtml(job.to)}</code>`,
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
