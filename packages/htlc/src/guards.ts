/**
 * Checks the buyer's tool runs before it signs a claim. A claim publishes the secret, and the
 * secret also unlocks the stablecoin, so the claim must not go out unless it can still win.
 */

/** Funding confirmations required before the secret is revealed, when the server does not say. */
export const DEFAULT_MIN_CONFIRMATIONS = 6;
/** Blocks the claim gets to confirm before the seller's refund leaf opens. */
export const DEFAULT_CLAIM_MARGIN_BLOCKS = 6;

export interface ClaimCheck {
  /** Confirmations of the HTLC funding output. */
  lockConfirmations: number;
  minConfirmations: number;
  /** Current BTQ tip height. */
  tipHeight: number;
  /** CLTV height of the refund leaf. */
  refundLocktime: number;
  marginBlocks: number;
}

/**
 * Returns why the claim must not be signed, or null when it is safe to proceed.
 *
 * CLTV lets a refund with nLockTime = L into block L + 1, so the claim has to confirm by block L.
 * A claim broadcast at tip T lands in T + 1 at the earliest; we ask for `marginBlocks` of room.
 */
export function claimRefusal(c: ClaimCheck): string | null {
  if (!Number.isInteger(c.tipHeight) || c.tipHeight <= 0) {
    return 'the BTQ tip height is unknown; pass --rpc to your own node and try again';
  }
  if (!Number.isSafeInteger(c.lockConfirmations) || c.lockConfirmations < 0 ||
      !Number.isSafeInteger(c.minConfirmations) || c.minConfirmations < 1 ||
      !Number.isSafeInteger(c.marginBlocks) || c.marginBlocks < 1 ||
      !Number.isSafeInteger(c.refundLocktime) || c.refundLocktime <= 0) {
    return 'invalid confirmation or refund-height safety parameters; do not claim';
  }
  if (c.lockConfirmations < c.minConfirmations) {
    return `the BTQ lock has ${c.lockConfirmations} of ${c.minConfirmations} confirmations; claiming now would reveal your secret against funding that can still be replaced`;
  }
  if (c.tipHeight + c.marginBlocks > c.refundLocktime) {
    return `the seller's refund opens at BTQ height ${c.refundLocktime} and the tip is ${c.tipHeight}; ` +
      `a claim now (needing ${c.marginBlocks} blocks of room) could lose the race and still reveal your secret. Do not claim; refund your stablecoin after its deadline`;
  }
  return null;
}
