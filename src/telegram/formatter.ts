import { describeWallet } from "../ethereum/monitor";
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
  const price =
    purchase.valueEth > 0
      ? `${purchase.valueEth.toFixed(4)} ETH`
      : "unknown / transfer";
  const market = purchase.marketplace || "n/a";

  return [
    `<b>NFT activity detected</b>`,
    ``,
    `<b>Wallet:</b> ${escHtml(describeWallet(purchase.buyer))}`,
    `<b>Collection:</b> ${escHtml(collection)}`,
    `<b>Item:</b> ${escHtml(title)}`,
    `<b>Token ID:</b> <code>${escHtml(purchase.tokenId)}</code>`,
    `<b>Contract:</b> <code>${escHtml(purchase.contract)}</code>`,
    `<b>Paid:</b> ${escHtml(price)}`,
    `<b>Venue:</b> ${escHtml(market)}`,
    `<b>Tx:</b> <a href="https://etherscan.io/tx/${purchase.txHash}">etherscan</a>`,
    ``,
    `<b>Copy:</b> ${escHtml(copy.reason)}`,
  ].join("\n");
}

export function formatStatus(params: {
  trackedCount: number;
  copyEnabled: boolean;
  dryRun: boolean;
  maxBuyEth: number;
  lastBlock: number;
  walletAddress?: string;
  balanceEth?: string;
}): string {
  return [
    `<b>NFT Copy Bot status</b>`,
    ``,
    `Tracked wallets: <b>${params.trackedCount}</b>`,
    `Copy mode: <b>${params.copyEnabled ? "ON" : "OFF"}</b>`,
    `Dry run: <b>${params.dryRun ? "ON" : "OFF"}</b>`,
    `Max buy: <b>${params.maxBuyEth} ETH</b>`,
    `Last block: <code>${params.lastBlock || "—"}</code>`,
    params.walletAddress
      ? `Bot wallet: <code>${escHtml(params.walletAddress)}</code> (${escHtml(params.balanceEth ?? "?")} ETH)`
      : `Bot wallet: <i>not configured</i>`,
  ].join("\n");
}

export function helpText(): string {
  return [
    `<b>Ethereum NFT Copy Bot</b>`,
    ``,
    `Track whale wallets. Get Telegram alerts when they buy NFTs. Optionally evaluate copy trades (dry-run by default).`,
    ``,
    `<b>Commands</b>`,
    `/start — register this chat for alerts`,
    `/help — show this help`,
    `/status — bot + wallet status`,
    `/wallets — list tracked wallets`,
    `/track &lt;address&gt; [label] — track a wallet`,
    `/untrack &lt;address&gt; — stop tracking`,
    `/copy on|off — toggle copy evaluation`,
    `/dryrun on|off — toggle dry-run safety`,
    `/maxbuy &lt;eth&gt; — set max copy price`,
    `/allow &lt;contract|clear&gt; — collection allowlist`,
  ].join("\n");
}
