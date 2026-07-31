/** Identity for @porshmints_bot — Ethereum only. Not related to @Nftcopymint_bot (Robinhood). */
export const BOT = {
  /** Telegram @username (display only — token comes from .env). */
  telegramUsername: "porshmints_bot",
  /** Package / process name. */
  name: "porshmints-bot",
  /** Short product title used in Telegram messages. */
  title: "PorshMints",
  /** Human chain label. */
  chainLabel: "Ethereum",
  /** Sibling Robinhood bot — do not share token, state, or keys with it. */
  siblingBot: "Nftcopymint_bot",
} as const;
