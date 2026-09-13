import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  hideMenuKeyboard,
  isMenuButton,
  mainMenuKeyboard,
  MenuBtn,
  MENU_BUTTON_LABELS,
} from "./menu";

describe("telegram menu keyboard", () => {
  it("has the 10 screenshot buttons", () => {
    assert.deepEqual(MENU_BUTTON_LABELS, [
      "🛰️ Status",
      "👁️ Watchlist",
      "🖼️ NFTs",
      "📜 Contracts",
      "💰 Balances",
      "🔑 Keys",
      "💰 Offers",
      "🗓️ Scheduled",
      "❓ Help",
      "✖️ Hide",
    ]);
  });

  it("builds a 2-column persistent keyboard", () => {
    const kb = mainMenuKeyboard();
    const built = kb.build();
    assert.equal(built.length, 5);
    assert.deepEqual(
      built.map((row) => row.map((b) => b.text)),
      [
        [MenuBtn.Status, MenuBtn.Watchlist],
        [MenuBtn.Nfts, MenuBtn.Contracts],
        [MenuBtn.Balances, MenuBtn.Keys],
        [MenuBtn.Offers, MenuBtn.Scheduled],
        [MenuBtn.Help, MenuBtn.Hide],
      ]
    );
    assert.equal(kb.resize_keyboard, true);
    assert.equal(kb.is_persistent, true);
  });

  it("hide removes the keyboard", () => {
    assert.deepEqual(hideMenuKeyboard(), { remove_keyboard: true });
  });

  it("isMenuButton matches labels only", () => {
    assert.equal(isMenuButton("🛰️ Status"), true);
    assert.equal(isMenuButton("/status"), false);
  });
});
