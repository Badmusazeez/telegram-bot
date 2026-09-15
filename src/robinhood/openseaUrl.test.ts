import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  normalizeOpenSeaInput,
  parseOpenSeaUrl,
} from "./openseaUrl";

const CONTRACT = "0xdcd9bc67dcd09bb37ef92175267741be973a7dbe";
const COLLECTION_URL = `https://opensea.io/assets/robinhood/${CONTRACT}`;

describe("normalizeOpenSeaInput", () => {
  it("strips trailing period / wrappers", () => {
    assert.equal(normalizeOpenSeaInput(`${COLLECTION_URL}.`), COLLECTION_URL);
    assert.equal(normalizeOpenSeaInput(`<${COLLECTION_URL}>`), COLLECTION_URL);
    assert.equal(normalizeOpenSeaInput(`"${COLLECTION_URL}"`), COLLECTION_URL);
  });
});

describe("parseOpenSeaUrl — contract = collection", () => {
  it("parses contract-only OpenSea asset URL as collection", () => {
    const link = parseOpenSeaUrl(COLLECTION_URL);
    assert.ok(link);
    assert.equal(link!.kind, "contract");
    assert.equal(link!.chain, "robinhood");
    assert.equal(link!.contract, CONTRACT);
    assert.equal(link!.tokenId, undefined);
  });

  it("parses trailing-period paste of user's example URL", () => {
    const link = parseOpenSeaUrl(`${COLLECTION_URL}.`);
    assert.ok(link);
    assert.equal(link!.kind, "contract");
    assert.equal(link!.contract, CONTRACT);
  });

  it("parses bare 0x contract as Robinhood collection", () => {
    const link = parseOpenSeaUrl(CONTRACT);
    assert.ok(link);
    assert.equal(link!.kind, "contract");
    assert.equal(link!.chain, "robinhood");
    assert.equal(link!.contract, CONTRACT);
  });

  it("still parses token asset URLs", () => {
    const link = parseOpenSeaUrl(`${COLLECTION_URL}/7`);
    assert.ok(link);
    assert.equal(link!.kind, "asset");
    assert.equal(link!.tokenId, "7");
  });

  it("rejects incomplete /assets/robinhood", () => {
    assert.equal(parseOpenSeaUrl("https://opensea.io/assets/robinhood"), null);
  });
});
