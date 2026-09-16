import { Keyboard } from "grammy";

/** Reply-keyboard labels — must match Telegram button text exactly. */
export const MenuBtn = {
  Status: "🛰️ Status",
  Watchlist: "👁️ Watchlist",
  Nfts: "🖼️ NFTs",
  Contracts: "📜 Contracts",
  Balances: "💰 Balances",
  Keys: "🔑 Keys",
  Offers: "💰 Offers",
  Scheduled: "🗓️ Scheduled",
  Help: "❓ Help",
  Hide: "✖️ Hide",
} as const;

export type MenuButtonLabel = (typeof MenuBtn)[keyof typeof MenuBtn];

/** All menu button texts (for hears matching). */
export const MENU_BUTTON_LABELS: MenuButtonLabel[] = Object.values(MenuBtn);

/**
 * Main bot menu — 2 columns × 5 rows (matches the Telegram reply keyboard layout).
 */
export function mainMenuKeyboard(): Keyboard {
  return new Keyboard()
    .text(MenuBtn.Status)
    .text(MenuBtn.Watchlist)
    .row()
    .text(MenuBtn.Nfts)
    .text(MenuBtn.Contracts)
    .row()
    .text(MenuBtn.Balances)
    .text(MenuBtn.Keys)
    .row()
    .text(MenuBtn.Offers)
    .text(MenuBtn.Scheduled)
    .row()
    .text(MenuBtn.Help)
    .text(MenuBtn.Hide)
    .resized()
    .persistent();
}

/** Hide the custom keyboard (Telegram ReplyKeyboardRemove). */
export function hideMenuKeyboard(): { remove_keyboard: true } {
  return { remove_keyboard: true };
}

export function isMenuButton(text: string): text is MenuButtonLabel {
  return (MENU_BUTTON_LABELS as string[]).includes(text);
}
