import { config } from "../config";
import { describeWallet } from "../robinhood/monitor";
import { shortAddress } from "../store/state";
import type { CopyResult, NftPurchase } from "../types";

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
    : purchase.isPaid
      ? "PAID"
      : "TRANSFER";
  const txUrl = config.chain.explorerTxUrl(purchase.txHash);
  const openSeaUrl = `https://opensea.io/assets/${config.chain.openseaChain}/${purchase.contract}/${purchase.tokenId}`;
  const copyTx = copy.txHash
    ? `\n<b>Our tx:</b> <a href="${config.chain.explorerTxUrl(copy.txHash)}">explorer</a>`
    : "";

  return [
    `<b>robinhood-nft-copy-boy alert</b>`,
    `<b>Chain:</b> ${escHtml(config.chain.name)}`,
    `<b>Type:</b> ${kind}`,
    ``,
    `<b>Wallet:</b> ${escHtml(describeWallet(purchase.buyer))}`,
    `<b>Collection:</b> ${escHtml(collection)}`,
    `<b>Item:</b> ${escHtml(title)}`,
    `<b>Token ID:</b> <code>${escHtml(purchase.tokenId)}</code>`,
    `<b>Contract:</b> <code>${escHtml(purchase.contract)}</code>`,
    `<b>Whale tx:</b> <a href="${txUrl}">explorer</a>`,
    `<b>OpenSea:</b> <a href="${openSeaUrl}">view</a>`,
    ``,
    `<b>Auto-mint:</b> ${escHtml(copy.reason)}${copyTx}`,
  ].join("\n");
}

export function formatStatus(params: {
  trackedCount: number;
  copyEnabled: boolean;
  dryRun: boolean;
  freeMintsOnly: boolean;
  maxBuyRobinhood: number;
  lastBlock: number;
  walletAddress?: string;
  balanceRobinhood?: string;
}): string {
  return [
    `<b>robinhood-nft-copy-boy status</b>`,
    ``,
    `Chain: <b>${escHtml(config.chain.name)}</b> (<code>${config.chain.chainId}</code>)`,
    `Mode: <b>${params.freeMintsOnly ? "FREE MINTS ONLY" : "ALL ACTIVITY"}</b>`,
    `Tracked wallets: <b>${params.trackedCount}</b>`,
    `Auto-mint: <b>${params.copyEnabled ? "ON" : "OFF"}</b>`,
    `Dry run: <b>${params.dryRun ? "ON" : "OFF"}</b>`,
    `Max buy (ignored for free mints): <b>${params.maxBuyRobinhood}</b>`,
    `Last block: <code>${params.lastBlock || "—"}</code>`,
    params.walletAddress
      ? `Bot wallet: <code>${escHtml(params.walletAddress)}</code> (balance ${escHtml(params.balanceRobinhood ?? "?")})`
      : `Bot wallet: <i>not configured</i>`,
  ].join("\n");
}

export function helpText(): string {
  return [
    `<b>robinhood-nft-copy-boy</b>`,
    `Active chain: <b>${escHtml(config.chain.name)}</b>`,
    ``,
    `Tracks whale wallets and auto-copies <b>free mints only</b> on Robinhood Chain. Paid buys are skipped.`,
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
    `/freemints on|off — free-mints-only filter`,
    `/maxbuy &lt;amount&gt; — max paid price (unused in free-mint mode)`,
    `/allow &lt;contract|clear&gt; — collection allowlist`,
  ].join("\n");
}
