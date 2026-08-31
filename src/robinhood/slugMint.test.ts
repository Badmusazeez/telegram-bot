import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseSlugMintCommandArgs,
  resolveSlugInput,
} from "./slugMint";

describe("resolveSlugInput", () => {
  it("accepts collection URL and bare slug", () => {
    assert.deepEqual(
      resolveSlugInput("https://opensea.io/collection/cool-cats"),
      { kind: "url", value: "https://opensea.io/collection/cool-cats" }
    );
    assert.deepEqual(resolveSlugInput("cool-cats"), {
      kind: "slug",
      value: "cool-cats",
    });
  });

  it("accepts full Robinhood asset URL", () => {
    const url =
      "https://opensea.io/assets/robinhood/0x1111111111111111111111111111111111111111/1";
    assert.equal(resolveSlugInput(url)?.kind, "url");
  });

  it("rejects incomplete /assets/robinhood", () => {
    assert.equal(resolveSlugInput("https://opensea.io/assets/robinhood"), null);
  });
});

describe("parseSlugMintCommandArgs", () => {
  it("parses target + interval seconds", () => {
    assert.deepEqual(
      parseSlugMintCommandArgs("https://opensea.io/collection/foo 10"),
      { target: "https://opensea.io/collection/foo", intervalSec: 10 }
    );
    assert.deepEqual(parseSlugMintCommandArgs("my-drop 10s"), {
      target: "my-drop",
      intervalSec: 10,
    });
  });

  it("parses contract-only collection URL + interval", () => {
    const url =
      "https://opensea.io/assets/robinhood/0xdcd9bc67dcd09bb37ef92175267741be973a7dbe";
    assert.deepEqual(parseSlugMintCommandArgs(`${url} 10`), {
      target: url,
      intervalSec: 10,
    });
    assert.deepEqual(parseSlugMintCommandArgs(`${url}. 10`), {
      target: url,
      intervalSec: 10,
    });
  });

  it("parses bare contract + interval", () => {
    const c = "0xdcd9bc67dcd09bb37ef92175267741be973a7dbe";
    assert.deepEqual(parseSlugMintCommandArgs(`${c} 10`), {
      target: `https://opensea.io/assets/robinhood/${c}`,
      intervalSec: 10,
    });
  });

  it("parses target without interval", () => {
    assert.deepEqual(parseSlugMintCommandArgs("my-drop"), {
      target: "my-drop",
    });
  });

  it("keeps tokenId on asset URL when interval follows", () => {
    const url =
      "https://opensea.io/assets/robinhood/0x1111111111111111111111111111111111111111/7";
    assert.deepEqual(parseSlugMintCommandArgs(`${url} 10`), {
      target: url,
      intervalSec: 10,
    });
  });

  it("rejects incomplete assets/robinhood even with interval", () => {
    assert.equal(
      parseSlugMintCommandArgs("https://opensea.io/assets/robinhood 10"),
      null
    );
  });

  it("rejects empty / oversized interval", () => {
    assert.equal(parseSlugMintCommandArgs(""), null);
    assert.equal(parseSlugMintCommandArgs("my-drop 99999"), null);
  });
});
