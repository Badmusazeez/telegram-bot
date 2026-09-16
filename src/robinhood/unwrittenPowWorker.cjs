/**
 * CJS worker for The Unwritten PoW.
 * keccak256(abi.encode(bytes32 seed, address sender, uint256 nonce)) < target
 */
const { parentPort, workerData } = require("node:worker_threads");
const { keccak256, concat, zeroPadValue, getBytes, toBeHex } = require("ethers");

const { seed, sender, target, start, stride, maxTries } = workerData;
const prefix = concat([getBytes(seed), zeroPadValue(sender, 32)]);
const t = BigInt(target);
let nonce = BigInt(start);
const step = BigInt(stride);
const limit = Number(maxTries || 100_000_000);
let tried = 0;

while (tried < limit) {
  const hash = keccak256(concat([prefix, zeroPadValue(toBeHex(nonce), 32)]));
  tried++;
  if (BigInt(hash) < t) {
    parentPort.postMessage({
      type: "found",
      nonce: nonce.toString(),
      hash,
      tried,
    });
    process.exit(0);
  }
  nonce += step;
  if (tried % 250_000 === 0) {
    parentPort.postMessage({ type: "progress", tried });
  }
}

parentPort.postMessage({ type: "exhausted", tried });
process.exit(0);
