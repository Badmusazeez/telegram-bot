/**
 * Rich mint failure / revert classifier for sniper diagnostics.
 * Does not invent reasons — maps common revert text to stable codes.
 */

export type MintFailKind =
  | "NOT_ELIGIBLE"
  | "PAYMENT_REQUIRED"
  | "MINT_NOT_STARTED"
  | "MINT_ENDED"
  | "SOLD_OUT"
  | "QUANTITY_INVALID"
  | "ALREADY_MINTED"
  | "PROOF_REQUIRED"
  | "APPROVAL_REQUIRED"
  | "WRONG_CALLDATA"
  | "GAS_ERROR"
  | "NONCE_ERROR"
  | "LOST_RACE"
  | "RPC_ERROR"
  | "UNKNOWN";

export type MintFailClass = {
  kind: MintFailKind;
  reason: string;
  /** Legacy slot-race buckets */
  slotKind: "LOST_RACE" | "TOO_EARLY" | "SOLD_OUT" | "OTHER";
};

export function analyzeMintFailure(error: string): MintFailClass {
  const raw = (error || "").trim();
  const lower = raw.toLowerCase();
  const reason = raw.slice(0, 200) || "unknown";

  if (/nonce has already been used|nonce too low|already known|replacement transaction/i.test(lower)) {
    return { kind: "NONCE_ERROR", reason, slotKind: "OTHER" };
  }
  if (/gas|intrinsic gas|max.?mint.?gas|out of gas|exceeds MAX_MINT/i.test(lower)) {
    return { kind: "GAS_ERROR", reason, slotKind: "OTHER" };
  }
  if (/rps|rate limit|429|try_again|timeout|econn|502|503|504/i.test(lower)) {
    return { kind: "RPC_ERROR", reason, slotKind: "OTHER" };
  }
  if (
    /insufficient (funds|payment|value)|must pay|payment required|price > 0|not free|msg\.value/i.test(
      lower
    )
  ) {
    return { kind: "PAYMENT_REQUIRED", reason, slotKind: "OTHER" };
  }
  if (
    /allowlist|not.?eligible|not on (the )?list|unauthorized|access control|only.?whitelist|not whitelisted/i.test(
      lower
    )
  ) {
    return { kind: "NOT_ELIGIBLE", reason, slotKind: "OTHER" };
  }
  if (
    /invalid.?proof|merkle|proof required|signature|missing proof|bad proof/i.test(lower)
  ) {
    return { kind: "PROOF_REQUIRED", reason, slotKind: "OTHER" };
  }
  if (/approval|not approved|allowance|operator/i.test(lower)) {
    return { kind: "APPROVAL_REQUIRED", reason, slotKind: "OTHER" };
  }
  if (
    /too early|not started|not live|before start|wait until|nextfreeat|next mint|cooldown|not yet|mint not (yet )?live/i.test(
      lower
    )
  ) {
    return { kind: "MINT_NOT_STARTED", reason, slotKind: "TOO_EARLY" };
  }
  if (/ended|sale (has )?ended|mint (has )?ended|after end|closed/i.test(lower)) {
    return { kind: "MINT_ENDED", reason, slotKind: "OTHER" };
  }
  if (
    /sold out|fully minted|exceeds max supply|max supply|no tokens left|insufficient supply/i.test(
      lower
    )
  ) {
    return { kind: "SOLD_OUT", reason, slotKind: "SOLD_OUT" };
  }
  if (
    /already (claimed|minted)|claimed already|already owns|max per wallet|wallet limit/i.test(
      lower
    )
  ) {
    return {
      kind: "ALREADY_MINTED",
      reason,
      slotKind: "LOST_RACE",
    };
  }
  if (
    /invalid (quantity|amount)|qty|quantity (too|must)|cannot mint 0|max mint/i.test(
      lower
    )
  ) {
    return { kind: "QUANTITY_INVALID", reason, slotKind: "OTHER" };
  }
  if (/selector|fallback|no function|unable to decode|bad data|wrong function/i.test(lower)) {
    return { kind: "WRONG_CALLDATA", reason, slotKind: "OTHER" };
  }
  if (
    /not your (turn|slot)|slot (taken|consumed)|someone else|lost.?race|cannot claim/i.test(
      lower
    ) ||
    (/reverted/.test(lower) && /slot|freeat|cooldown|occupied/.test(lower))
  ) {
    return {
      kind: "LOST_RACE",
      reason: "another transaction consumed the slot",
      slotKind: "LOST_RACE",
    };
  }
  // Bare revert after a competitive window — treat as lost race for slot recovery,
  // but keep kind distinct when message is empty "reverted".
  if (/^reverted$|execution reverted|rpc-coalesce\/revert/i.test(lower)) {
    return {
      kind: "LOST_RACE",
      reason: "another transaction consumed the slot (or stage rejected)",
      slotKind: "LOST_RACE",
    };
  }

  return { kind: "UNKNOWN", reason, slotKind: "OTHER" };
}

/** Back-compat wrapper used by slot race / copy recovery. */
export function classifyMintFailure(error: string): {
  kind: "LOST_RACE" | "TOO_EARLY" | "SOLD_OUT" | "OTHER";
  reason: string;
  detail?: MintFailClass;
} {
  const detail = analyzeMintFailure(error);
  // Preserve historical LOST_RACE wording used by Telegram / tests.
  if (detail.slotKind === "LOST_RACE") {
    return {
      kind: "LOST_RACE",
      reason:
        detail.kind === "LOST_RACE" && /or stage rejected/i.test(detail.reason)
          ? detail.reason
          : "another transaction consumed the slot",
      detail,
    };
  }
  return { kind: detail.slotKind, reason: detail.reason, detail };
}
