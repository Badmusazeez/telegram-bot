import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { id } from "ethers";
import {
  MINT_FREE_SELECTOR,
  NBTC_RIGS,
  parseSnipeCommandArgs,
} from "./cadenceSnipe";

describe("mintFree selector", () => {
  it("matches Wrong Bird / nBTC on-chain method 0x8ab53447", () => {
    assert.equal(MINT_FREE_SELECTOR, "0x8ab53447");
    assert.equal(id("mintFree()").slice(0, 10), "0x8ab53447");
  });
});

describe("parseSnipeCommandArgs", () => {
  it("parses wrong-bird collection URL + 10s", () => {
    assert.deepEqual(
      parseSnipeCommandArgs("https://opensea.io/collection/wrong-bird 10"),
      {
        target: "https://opensea.io/collection/wrong-bird",
        intervalSec: 10,
        maxPerWallet: 1,
        walletFilter: "all",
      }
    );
  });

  it("defaults interval to 10", () => {
    assert.deepEqual(parseSnipeCommandArgs("wrong-bird"), {
      target: "wrong-bird",
      intervalSec: 10,
      maxPerWallet: 1,
      walletFilter: "all",
    });
  });

  it("parses contract address", () => {
    const c = "0xeb00d52ef95ea6aef1a7dfdc16337053eeedf5e6";
    assert.deepEqual(parseSnipeCommandArgs(`${c} 10`), {
      target: c,
      intervalSec: 10,
      maxPerWallet: 1,
      walletFilter: "all",
    });
  });

  it("rejects invalid interval", () => {
    assert.equal(parseSnipeCommandArgs("wrong-bird 0"), null);
    assert.equal(parseSnipeCommandArgs(""), null);
  });

  it("nbtc preset: 3s interval, max 3, all wallets", () => {
    assert.deepEqual(parseSnipeCommandArgs("nbtc"), {
      target: NBTC_RIGS.contract,
      intervalSec: 3,
      maxPerWallet: 3,
      walletFilter: "all",
    });
  });

  it("nbtc with single wallet filter", () => {
    const w = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    assert.deepEqual(parseSnipeCommandArgs(`nbtc ${w}`), {
      target: NBTC_RIGS.contract,
      intervalSec: 3,
      maxPerWallet: 3,
      walletFilter: w,
    });
  });

  it("nbtc OpenSea slug alias", () => {
    assert.deepEqual(
      parseSnipeCommandArgs("nbtc-mining-rigs-517198745 all"),
      {
        target: NBTC_RIGS.contract,
        intervalSec: 3,
        maxPerWallet: 3,
        walletFilter: "all",
      }
    );
  });

  it("parses max= and wallet together", () => {
    const w = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    assert.deepEqual(parseSnipeCommandArgs(`wrong-bird 10 max3 ${w}`), {
      target: "wrong-bird",
      intervalSec: 10,
      maxPerWallet: 3,
      walletFilter: w,
    });
  });
});
