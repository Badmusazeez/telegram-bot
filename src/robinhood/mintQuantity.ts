import { config } from "../config";

/** Absolute ceiling for free-mint quantity probes / API requests. */
export function hardMaxMintQuantity(): number {
  const n = Number(config.maxMintQuantity);
  if (!Number.isFinite(n) || n < 1) return 50;
  return Math.min(Math.floor(n), 100);
}

/**
 * Quantity ladder: always try MAX first, then step down.
 * Whale qty is only a hint — never caps us below max.
 */
export function maxMintQuantityLadder(whaleQuantity?: number): number[] {
  const hardMax = hardMaxMintQuantity();
  const whale = Math.max(1, Math.min(Number(whaleQuantity) || 1, hardMax));
  const steps = [
    hardMax,
    Math.min(hardMax, 40),
    Math.min(hardMax, 30),
    Math.min(hardMax, 25),
    Math.min(hardMax, 20),
    Math.min(hardMax, 15),
    Math.min(hardMax, 10),
    Math.min(hardMax, Math.max(whale * 2, whale)),
    whale,
    5,
    3,
    2,
    1,
  ];
  return [...new Set(steps.filter((q) => q >= 1 && q <= hardMax))].sort(
    (a, b) => b - a
  );
}

/** Clamp a known per-wallet limit to our hard max (still "max allowed"). */
export function clampMaxPerWallet(limit: number | string | null | undefined): number {
  const n = Number(limit ?? 1);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.floor(n), hardMaxMintQuantity());
}
