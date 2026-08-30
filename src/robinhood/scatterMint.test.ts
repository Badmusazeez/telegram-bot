import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decodeScatterMintQuantity,
  isScatterMintCalldata,
  pickScatterFreeLists,
} from "./scatterMint";
import { decodeWhaleMintQuantity } from "./multiMint";

const MEOWPOP_DATA =
  "0x4a21a2df" +
  "0000000000000000000000000000000000000000000000000000000000000080" +
  "0000000000000000000000000000000000000000000000000000000000000003" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "00000000000000000000000000000000000000000000000000000000000000e0";

describe("scatter mint detect", () => {
  it("detects Scatter selector and quantity=3", () => {
    assert.equal(isScatterMintCalldata(MEOWPOP_DATA), true);
    assert.equal(decodeScatterMintQuantity(MEOWPOP_DATA), 3);
    assert.equal(decodeWhaleMintQuantity(MEOWPOP_DATA), 3);
  });

  it("picks only 0-price free lists", () => {
    const free = pickScatterFreeLists([
      {
        id: "free",
        name: "FREE",
        token_price: "0",
        start_time: "2020-01-01T00:00:00.000Z",
      },
      {
        id: "paid",
        name: "PUBLIC",
        token_price: "0.000033",
        start_time: "2020-01-01T00:00:00.000Z",
      },
    ]);
    assert.equal(free.length, 1);
    assert.equal(free[0]!.id, "free");
  });
});
