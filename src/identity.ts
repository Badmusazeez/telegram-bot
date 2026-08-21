/**
 * Identity for @porshmints_bot — Ethereum only.
 * Entirely separate from @Nftcopymint_bot (Robinhood): different folder, token,
 * .env, keys, state files, and systemd unit. They never share runtime.
 */
export const BOT = {
  /** Telegram @username — enforced at startup via getMe(). */
  telegramUsername: "porshmints_bot",
  /** Package / process / systemd-related name. */
  name: "porshmints-bot",
  /** Required VPS directory basename (install refuses telegram-bot/). */
  requiredDirName: "porshmints-bot",
  /** Short product title used in Telegram messages. */
  title: "PorshMints",
  /** Human chain label. */
  chainLabel: "Ethereum",
  /** Sibling Robinhood bot — never share token, state, keys, or folder. */
  siblingBot: "Nftcopymint_bot",
} as const;
