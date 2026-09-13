import type { JsonRpcProvider } from "ethers";

/**
 * Per-wallet nonce lock — prevents colliding sends when the same mint wallet
 * fires in a multi-wallet burst. Cross-wallet blasts stay fully parallel.
 */

type QueueTail = Promise<unknown>;

const queues = new Map<string, QueueTail>();
const localNonce = new Map<string, number>();

function addrKey(address: string): string {
  return address.toLowerCase();
}

/**
 * Run `fn` exclusively for this wallet address, with a reserved nonce.
 * On success advances local nonce; on failure refreshes from chain next time.
 */
export async function withWalletNonce<T>(params: {
  address: string;
  provider: JsonRpcProvider;
  fn: (nonce: number) => Promise<T>;
}): Promise<T> {
  const key = addrKey(params.address);
  const prev = queues.get(key) ?? Promise.resolve();

  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  queues.set(
    key,
    prev.then(() => gate).catch(() => gate)
  );

  await prev.catch(() => undefined);

  try {
    let nonce = localNonce.get(key);
    if (nonce == null) {
      nonce = await params.provider.getTransactionCount(
        params.address,
        "pending"
      );
      localNonce.set(key, nonce);
    }
    const used = nonce;
    try {
      const result = await params.fn(used);
      localNonce.set(key, used + 1);
      return result;
    } catch (err) {
      localNonce.delete(key);
      throw err;
    }
  } finally {
    release();
  }
}

/** Clear cached nonce (e.g. after "nonce too low" / "already used"). */
export function invalidateWalletNonce(address: string): void {
  localNonce.delete(addrKey(address));
}

/** Prefetch pending nonce during pre-arm so fire path skips eth_getTransactionCount. */
export async function warmWalletNonce(
  address: string,
  provider: JsonRpcProvider
): Promise<number> {
  const key = addrKey(address);
  const nonce = await provider.getTransactionCount(address, "pending");
  localNonce.set(key, nonce);
  return nonce;
}

export function peekCachedNonce(address: string): number | undefined {
  return localNonce.get(addrKey(address));
}

/** Test helper */
export function resetNonceManager(): void {
  queues.clear();
  localNonce.clear();
}
