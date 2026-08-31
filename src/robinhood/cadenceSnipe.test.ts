import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { id } from "ethers";
import {
  MINT_FREE_SELECTOR,
  parseSnipeCommandArgs,
} from "./cadenceSnipe";

describe("mintFree selector", () => {
  it("matches Wrong Bird on-chain method 0x8ab53447", () => {
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
      }
    );
  });

  it("defaults interval to 10", () => {
    assert.deepEqual(parseSnipeCommandArgs("wrong-bird"), {
      target: "wrong-bird",
      intervalSec: 10,
    });
  });

  it("parses contract address", () => {
    const c = "0xeb00d52ef95ea6aef1a7dfdc16337053eeedf5e6";
    assert.deepEqual(parseSnipeCommandArgs(`${c} 10`), {
      target: c,
      intervalSec: 10,
    });
  });

  it("rejects invalid interval", () => {
    assert.equal(parseSnipeCommandArgs("wrong-bird 0"), null);
    assert.equal(parseSnipeCommandArgs(""), null);
  });
});
