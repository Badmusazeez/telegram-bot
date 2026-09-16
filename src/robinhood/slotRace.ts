import type { Wallet } from "ethers";
import { config } from "../config";
import { getState } from "../store/state";
import {
  getAllMintWallets,
  getMintProvider,
} from "./provider";
import { resolveMintGasLimit, mintSelectorLabel } from "./mintGas";
import { withWalletNonce, invalidateWalletNonce } from "./nonceManager";
import { checkMintWalletReadiness } from "./walletReady";
import {
  classifyMintFailure,
  probeMintSlot,
  type SlotProbeResult,
} from "./slotProbe";
import { analyzeMintFailure } from "./failureAnalyze";
import { pickFastestMintRpc } from "./mintRpcPick";
import { Interface } from "ethers";
import {
  buildSeaDropMintPublicTx,
  isSeaDropMintPublic,
} from "./seaDrop";
import { maxMintQuantityLadder } from "./mintQuantity";
import { decodeWhaleMintQuantity } from "./multiMint";

export type SlotRacePhase =
  | "NEXT_SLOT"
  | "ARMED"
  | "WINDOW_OPEN"
  | "BURST"
  | "SUCCESS"
  | "LOST_RACE";

export type SlotRaceEvent = {
  phase: SlotRacePhase;
  contract: string;
  slotSource?: string;
  opensAtMs?: number | null;
  wallet?: string;
  strategy?: string;
  txHash?: string;
  reason?: string;
  walletsArmed?: number;
  detail?: string;
  gasLimit?: string;
  rpcLabel?: string;
  mintType?: string;
  failKind?: string;
  latencyMs?: number;
};

export type SlotRaceHandler = (event: SlotRaceEvent) => Promise<void>;

export type ArmedWalletTx = {
  wallet: Wallet;
  to: string;
  data: string;
  valueWei: bigint;
  gasLimit: bigint;
  strategy: string;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  gasPrice?: bigint;
};

type ActiveRace = {
  id: string;
  contract: string;
  abort: AbortController;
};

const activeByContract = new Map<string, ActiveRace>();
let eventHandler: SlotRaceHandler | null = null;

export function setSlotRaceHandler(handler: SlotRaceHandler | null): void {
  eventHandler = handler;
}

async function emit(event: SlotRaceEvent): Promise<void> {
  console.log(
    `[slot] ${event.phase} contract=${event.contract.slice(0, 12)}… ` +
      `${event.wallet ? `wallet=${event.wallet.slice(0, 8)}… ` : ""}` +
      `${event.reason || event.detail || ""}`
  );
  if (eventHandler) {
    try {
      await eventHandler(event);
    } catch (err) {
      console.warn(
        `[slot] handler failed: ${err instanceof Error ? err.message : err}`
      );
    }
  }
}

const ERC721_BAL = new Interface([
  "function balanceOf(address owner) view returns (uint256)",
  "function numberMinted(address minter) view returns (uint256)",
]);

async function walletAlreadyMinted(
  provider: import("ethers").JsonRpcProvider,
  nftContract: string,
  wallet: string
): Promise<boolean> {
  try {
    const data = ERC721_BAL.encodeFunctionData("numberMinted", [wallet]);
    const ret = await provider.call({ to: nftContract, data });
    if (ret && ret !== "0x") {
      const n = ERC721_BAL.decodeFunctionResult("numberMinted", ret)[0] as bigint;
      if (n > 0n) return true;
    }
  } catch {
    // ignore
  }
  try {
    const data = ERC721_BAL.encodeFunctionData("balanceOf", [wallet]);
    const ret = await provider.call({ to: nftContract, data });
    if (ret && ret !== "0x") {
      const n = ERC721_BAL.decodeFunctionResult("balanceOf", ret)[0] as bigint;
      if (n > 0n) return true;
    }
  } catch {
    // ignore
  }
  return false;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true }
    );
  });
}

/** Wait until opensAtMs with coarse then fine sleep (armed countdown). */
async function waitUntilOpen(
  opensAtMs: number,
  signal: AbortSignal
): Promise<void> {
  for (;;) {
    if (signal.aborted) throw new Error("aborted");
    const left = opensAtMs - Date.now();
    if (left <= 0) return;
    // Coarse wait until ~150ms before open, then fine-poll.
    const wait = left > 200 ? Math.min(left - 150, 2_000) : Math.min(left, 25);
    await sleep(Math.max(5, wait), signal);
  }
}

async function prepareOneArmedTx(params: {
  wallet: Wallet;
  to: string;
  data: string;
  whaleData: string;
  quantityHint?: number;
  provider: import("ethers").JsonRpcProvider;
  dryRun: boolean;
  qtys: number[];
}): Promise<ArmedWalletTx | null> {
  const { wallet, provider, dryRun, qtys } = params;

  // Soft eligibility: skip wallets that already hold / minted this NFT (when readable).
  const nft =
    isSeaDropMintPublic(params.whaleData)
      ? (() => {
          const b = buildSeaDropMintPublicTx({
            whaleData: params.whaleData,
            minter: wallet.address,
            quantity: 1,
          });
          return b?.nftContract || params.to;
        })()
      : params.to;
  if (await walletAlreadyMinted(provider, nft, wallet.address)) {
    console.log(
      `[slot] skip ${wallet.address.slice(0, 8)}… — already minted/holds NFT`
    );
    return null;
  }

  if (dryRun) {
    return {
      wallet,
      to: params.to,
      data: params.data,
      valueWei: 0n,
      gasLimit: 300_000n,
      strategy: "dry-run",
    };
  }

  // Prefer SeaDrop rebuild per-wallet when applicable; else whale calldata.
  let to = params.to;
  let data = params.data;
  let strategy = `replay:${mintSelectorLabel(params.data)}`;

  if (isSeaDropMintPublic(params.whaleData)) {
    let built = null as ReturnType<typeof buildSeaDropMintPublicTx>;
    for (const q of qtys) {
      built = buildSeaDropMintPublicTx({
        whaleData: params.whaleData,
        minter: wallet.address,
        quantity: q,
      });
      if (built) {
        strategy = `SeaDrop.mintPublic(x${q})`;
        break;
      }
    }
    if (built) {
      to = built.to;
      data = built.data;
    }
  }

  try {
    const estimated = await provider.estimateGas({
      from: wallet.address,
      to,
      data,
      value: 0n,
    });
    const resolved = resolveMintGasLimit({
      estimated,
      ceiling: config.maxMintGasLimit,
      marginPct: 20,
    });
    if (!resolved.ok) {
      console.warn(
        `[slot] skip arm ${wallet.address.slice(0, 8)}… gas: ${resolved.reason}`
      );
      return null;
    }
    const fee = await provider.getFeeData();
    return {
      wallet,
      to,
      data,
      valueWei: 0n,
      gasLimit: resolved.gasLimit,
      strategy,
      maxFeePerGas:
        fee.maxFeePerGas != null
          ? (fee.maxFeePerGas * 125n) / 100n
          : undefined,
      maxPriorityFeePerGas:
        fee.maxPriorityFeePerGas != null
          ? (fee.maxPriorityFeePerGas * 125n) / 100n
          : undefined,
      gasPrice:
        fee.maxFeePerGas == null && fee.gasPrice != null
          ? (fee.gasPrice * 125n) / 100n
          : undefined,
    };
  } catch (err) {
    // Too-early simulate is expected before window — still arm with safe gas ceiling fraction.
    const msg = err instanceof Error ? err.message : String(err);
    const cls = classifyMintFailure(msg);
    if (cls.kind === "TOO_EARLY" || cls.kind === "LOST_RACE") {
      const gasLimit = BigInt(
        Math.min(Math.floor(config.maxMintGasLimit * 0.4), 800_000)
      );
      const fee = await provider.getFeeData().catch(() => null);
      return {
        wallet,
        to,
        data,
        valueWei: 0n,
        gasLimit,
        strategy: `${strategy} (pre-window)`,
        maxFeePerGas:
          fee?.maxFeePerGas != null
            ? (fee.maxFeePerGas * 125n) / 100n
            : undefined,
        maxPriorityFeePerGas:
          fee?.maxPriorityFeePerGas != null
            ? (fee.maxPriorityFeePerGas * 125n) / 100n
            : undefined,
        gasPrice:
          fee && fee.maxFeePerGas == null && fee.gasPrice != null
            ? (fee.gasPrice * 125n) / 100n
            : undefined,
      };
    }
    console.warn(
      `[slot] prepare failed ${wallet.address.slice(0, 8)}… ${msg.slice(0, 120)}`
    );
    return null;
  }
}

async function prepareArmedTxs(params: {
  wallets: Wallet[];
  to: string;
  data: string;
  whaleData: string;
  quantityHint?: number;
}): Promise<ArmedWalletTx[]> {
  const provider = getMintProvider();
  const state = getState();
  const qtys = maxMintQuantityLadder(params.quantityHint || 1);

  // Parallel prep across wallets; submission stays nonce-serialized per wallet.
  const results = await Promise.all(
    params.wallets.map((wallet) =>
      prepareOneArmedTx({
        wallet,
        to: params.to,
        data: params.data,
        whaleData: params.whaleData,
        quantityHint: params.quantityHint,
        provider,
        dryRun: state.dryRun,
        qtys,
      })
    )
  );
  return results.filter((r): r is ArmedWalletTx => r != null);
}

async function burstArmed(
  armed: ArmedWalletTx[],
  signal: AbortSignal,
  nftContract: string
): Promise<{
  successes: Array<{ address: string; txHash: string }>;
  lost: Array<{ address: string; reason: string }>;
  other: Array<{ address: string; reason: string }>;
}> {
  const rpc = await pickFastestMintRpc();
  const provider = rpc.provider;
  const successes: Array<{ address: string; txHash: string }> = [];
  const lost: Array<{ address: string; reason: string }> = [];
  const other: Array<{ address: string; reason: string }> = [];
  const burstStarted = Date.now();

  // One SUBMITTED summary (avoid 21 Telegram spam); per-wallet stays in logs.
  if (armed[0]) {
    await emit({
      phase: "BURST",
      contract: nftContract,
      wallet: armed[0].wallet.address.toLowerCase(),
      strategy: armed[0].strategy,
      gasLimit: armed[0].gasLimit.toString(),
      rpcLabel: `${rpc.label} ${rpc.latencyMs}ms`,
      detail: `submitting ${armed.length} wallet(s)`,
      walletsArmed: armed.length,
    });
  }

  await Promise.all(
    armed.map(async (a, index) => {
      if (signal.aborted) return;
      if (index > 0) await sleep(Math.min(index * 15, 300), signal).catch(() => undefined);
      const address = a.wallet.address.toLowerCase();
      console.log(
        `[slot] SUBMIT wallet=${address.slice(0, 8)}… strategy=${a.strategy} gas=${a.gasLimit} rpc=${rpc.label}`
      );
      try {
        const connected = a.wallet.connect(provider);
        const sent = await withWalletNonce({
          address,
          provider,
          fn: async (nonce) =>
            connected.sendTransaction({
              to: a.to,
              data: a.data,
              value: a.valueWei,
              gasLimit: a.gasLimit,
              nonce,
              chainId: Number(config.chain.chainId),
              maxFeePerGas: a.maxFeePerGas,
              maxPriorityFeePerGas: a.maxPriorityFeePerGas,
              gasPrice: a.gasPrice,
            }),
        });
        void sent.wait().catch(() => undefined);
        successes.push({ address, txHash: sent.hash });
        await emit({
          phase: "SUCCESS",
          contract: nftContract,
          wallet: address,
          strategy: a.strategy,
          txHash: sent.hash,
          rpcLabel: rpc.label,
          latencyMs: Date.now() - burstStarted,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/nonce/i.test(msg)) invalidateWalletNonce(address);
        const detail = analyzeMintFailure(msg);
        const cls = classifyMintFailure(msg);
        if (cls.kind === "LOST_RACE" || cls.kind === "SOLD_OUT" || detail.kind === "ALREADY_MINTED") {
          lost.push({ address, reason: `${detail.kind}: ${cls.reason}` });
          await emit({
            phase: "LOST_RACE",
            contract: nftContract,
            wallet: address,
            strategy: a.strategy,
            reason: cls.reason,
            failKind: detail.kind,
          });
        } else {
          other.push({ address, reason: `${detail.kind}: ${detail.reason}` });
        }
      }
    })
  );

  return { successes, lost, other };
}

export type SlotRaceRequest = {
  contract: string;
  /** Whale / template calldata for rebuilds. */
  whaleData: string;
  /** Destination for replay (SeaDrop or NFT). */
  to: string;
  buyer?: string;
  quantityHint?: number;
  /** Optional pre-probed slot; will re-probe if missing. */
  slot?: SlotProbeResult;
  /** Max automatic next-slot recoveries. */
  maxRecoveries?: number;
};

/**
 * Arm wallets for a future (or immediate) mint slot, burst at open, recover next slot on LOST_RACE.
 * No-ops cleanly when the contract has no timing views (caller should use normal mint path).
 */
export async function runSlotRace(
  req: SlotRaceRequest
): Promise<{
  attempted: boolean;
  armed: boolean;
  success: boolean;
  reason: string;
}> {
  const state = getState();
  if (!state.copyEnabled) {
    return {
      attempted: false,
      armed: false,
      success: false,
      reason: "Auto-mint disabled",
    };
  }

  const contract = req.contract.toLowerCase();
  const provider = getMintProvider();

  // Cancel prior race on same contract.
  const prev = activeByContract.get(contract);
  if (prev) {
    prev.abort.abort();
    activeByContract.delete(contract);
  }

  let slot = req.slot ?? (await probeMintSlot(provider, contract));
  if (!slot.hasTiming) {
    return {
      attempted: false,
      armed: false,
      success: false,
      reason: "no timing mechanism — use immediate mint path",
    };
  }

  const abort = new AbortController();
  const id = `slot_${Date.now().toString(36)}`;
  activeByContract.set(contract, { id, contract, abort });

  const wallets = getAllMintWallets();
  if (wallets.length === 0) {
    activeByContract.delete(contract);
    return {
      attempted: false,
      armed: false,
      success: false,
      reason: "no mint wallets",
    };
  }

  const readiness = await checkMintWalletReadiness(wallets);
  const useWallets =
    readiness.ready.length > 0 ? readiness.ready : wallets;

  let recoveries = 0;
  const maxRecoveries = req.maxRecoveries ?? 3;
  const qty =
    req.quantityHint ||
    decodeWhaleMintQuantity(req.whaleData) ||
    1;

  try {
    while (recoveries <= maxRecoveries) {
      if (!slot.opensAtMs) {
        return {
          attempted: true,
          armed: false,
          success: false,
          reason: "timing probe missing opensAt",
        };
      }

      await emit({
        phase: "NEXT_SLOT",
        contract,
        slotSource: slot.source,
        opensAtMs: slot.opensAtMs,
        detail: slot.detail,
      });

      // Prepare BEFORE open (detect → analyze → calldata/gas/nonce → simulate).
      const prepStarted = Date.now();
      const armed = await prepareArmedTxs({
        wallets: useWallets,
        to: req.to,
        data: req.whaleData,
        whaleData: req.whaleData,
        quantityHint: qty,
      });
      const prepMs = Date.now() - prepStarted;

      if (armed.length === 0) {
        return {
          attempted: true,
          armed: false,
          success: false,
          reason: "could not prepare any wallet txs (gas/eligibility)",
        };
      }

      await emit({
        phase: "ARMED",
        contract,
        slotSource: slot.source,
        opensAtMs: slot.opensAtMs,
        walletsArmed: armed.length,
        mintType: isSeaDropMintPublic(req.whaleData) ? "SeaDrop/free" : "public/contract",
        latencyMs: prepMs,
        detail: `strategy prep done · opens ${new Date(slot.opensAtMs).toISOString()}`,
      });

      if (state.dryRun) {
        return {
          attempted: true,
          armed: true,
          success: true,
          reason: `DRY RUN — armed ${armed.length} wallet(s) for ${new Date(slot.opensAtMs).toISOString()}`,
        };
      }

      await waitUntilOpen(slot.opensAtMs, abort.signal);

      await emit({
        phase: "WINDOW_OPEN",
        contract,
        slotSource: slot.source,
        opensAtMs: slot.opensAtMs,
        walletsArmed: armed.length,
        mintType: isSeaDropMintPublic(req.whaleData) ? "SeaDrop/free" : "public/contract",
      });

      const result = await burstArmed(armed, abort.signal, contract);
      if (result.successes.length > 0) {
        return {
          attempted: true,
          armed: true,
          success: true,
          reason: `Slot race SUCCESS on ${result.successes.length}/${armed.length} wallet(s)`,
        };
      }

      // Lost race / failure → probe next slot.
      recoveries += 1;
      const next = await probeMintSlot(provider, contract);
      if (
        next.hasTiming &&
        next.opensAtMs &&
        next.opensAtMs > Date.now() + 500
      ) {
        slot = next;
        await emit({
          phase: "NEXT_SLOT",
          contract,
          slotSource: next.source,
          opensAtMs: next.opensAtMs,
          detail: `recovery ${recoveries}/${maxRecoveries} · ${next.detail}`,
        });
        continue;
      }

      return {
        attempted: true,
        armed: true,
        success: false,
        reason:
          result.lost.length > 0
            ? `LOST_RACE on ${result.lost.length} wallet(s); no future slot`
            : `slot burst failed; no future slot`,
      };
    }

    return {
      attempted: true,
      armed: true,
      success: false,
      reason: `exhausted ${maxRecoveries} slot recoveries`,
    };
  } catch (err) {
    if (err instanceof Error && err.message === "aborted") {
      return {
        attempted: true,
        armed: true,
        success: false,
        reason: "slot race aborted (superseded)",
      };
    }
    return {
      attempted: true,
      armed: true,
      success: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  } finally {
    const cur = activeByContract.get(contract);
    if (cur?.id === id) activeByContract.delete(contract);
  }
}

/** Cancel any armed race for a contract. */
export function cancelSlotRace(contract: string): boolean {
  const cur = activeByContract.get(contract.toLowerCase());
  if (!cur) return false;
  cur.abort.abort();
  activeByContract.delete(contract.toLowerCase());
  return true;
}

export function activeSlotRaceCount(): number {
  return activeByContract.size;
}
