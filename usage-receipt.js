// Verify BSVKey inference usage receipts, client-side, offline.
//
// The BSVKey inference broker returns a signed `usageReceipt` on every settled
// prepaid-channel call. This module lets an agent audit the broker's meter
// WITHOUT trusting its word and WITHOUT a round-trip: it recovers the signer
// from the signature, and checks channel binding, a monotonic sequence (no
// replay/gap), and running totals bounded by the funded amount.
//
// Pin the broker's key once from GET /v1/receipt-key, then pass it as
// `expectedSigner` to verifyReceiptChain. Spec:
// https://inference.bsvkey.com/usage-receipts.md
//
// Peer dependency: @bsv/sdk (v2), the same one this package already needs to
// build payments. `verifyReceipt` / `verifyReceiptChain` are async.
//
// What it proves: the broker signed these exact numbers (non-repudiable), none
// were double-counted, and the totals reconcile and stay within what you funded.
// What it does NOT prove: that the token counts equal the model's true usage.
// That last inch is still the broker's meter.

import { createHash } from 'node:crypto';

let _sdk = null;
async function sdk() {
  if (_sdk) return _sdk;
  _sdk = await import('@bsv/sdk');
  return _sdk;
}

export const RECEIPT_SCHEMA = 'bsvkey.usage-receipt/1';

const CONTENT_FIELDS = [
  'v', 'channelId', 'seq', 'model',
  'inputTokens', 'outputTokens', 'sats',
  'cumTokens', 'cumSats', 'fundedSats', 'timestamp',
];
const ALLOWED_KEYS = new Set([...CONTENT_FIELDS, 'claimId', 'signature', 'brokerPubKey']);

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeysDeep(value[k]);
    return out;
  }
  return value;
}
export function canonicalize(value) {
  return JSON.stringify(sortKeysDeep(value));
}
function pickContent(obj) {
  const c = {};
  for (const k of CONTENT_FIELDS) if (obj[k] !== undefined) c[k] = obj[k];
  return c;
}
export function computeClaimId(obj) {
  const hash = createHash('sha256').update(canonicalize(pickContent(obj)), 'utf8').digest('hex');
  return `0x${hash}`;
}

// Verify ONE receipt is internally consistent and recover its signer.
// Returns { ok:true, signer } (signer = recovered pubkey hex) or { ok:false, reason }.
export async function verifyReceipt(receipt) {
  if (receipt === null || typeof receipt !== 'object') return { ok: false, reason: 'not_an_object' };
  for (const k of Object.keys(receipt)) {
    if (!ALLOWED_KEYS.has(k)) return { ok: false, reason: `unknown_field:${k}` };
  }
  if (receipt.v !== RECEIPT_SCHEMA) return { ok: false, reason: `bad_schema:${receipt.v}` };
  const expected = computeClaimId(receipt);
  if (expected.toLowerCase() !== String(receipt.claimId).toLowerCase()) {
    return { ok: false, reason: 'claimId_mismatch' };
  }
  const { BSM, Utils, Signature, BigNumber } = await sdk();
  let raw;
  try { raw = Utils.toArray(receipt.signature, 'base64'); } catch (e) { return { ok: false, reason: `bad_signature_encoding: ${e.message}` }; }
  if (!Array.isArray(raw) || raw.length !== 65 || raw[0] < 27 || raw[0] >= 35) {
    return { ok: false, reason: 'bad_signature_encoding: not a 65-byte BSM compact signature' };
  }
  const recoveryId = (raw[0] - 27) & 3;
  const msg = Utils.toArray(receipt.claimId, 'utf8');
  let recovered;
  try {
    const sig = Signature.fromCompact(receipt.signature, 'base64');
    recovered = sig.RecoverPublicKey(recoveryId, new BigNumber(BSM.magicHash(msg)));
    if (!BSM.verify(msg, sig, recovered)) return { ok: false, reason: 'signature_invalid' };
  } catch (e) {
    return { ok: false, reason: `signature_recovery_failed: ${e.message}` };
  }
  const signer = recovered.toString();
  if (receipt.brokerPubKey !== undefined && receipt.brokerPubKey !== signer) {
    return { ok: false, reason: 'brokerPubKey_does_not_match_recovered' };
  }
  return { ok: true, signer };
}

// Verify a whole channel's receipt chain offline (the agent audit).
//   opts.expectedSigner : the broker key pinned from GET /v1/receipt-key
//   opts.channelId      : your channel (all receipts must match)
//   opts.fundedSats     : the channel's on-chain funded amount (conservation cap)
// Returns { ok, count, cumSats, cumTokens } or { ok:false, reason, seq }.
export async function verifyReceiptChain(receipts, opts = {}) {
  const list = [...receipts].sort((a, b) => (a.seq || 0) - (b.seq || 0));
  let prevSeq = 0, prevCumSats = 0, prevCumTokens = 0;
  for (const r of list) {
    const v = await verifyReceipt(r);
    if (!v.ok) return { ok: false, reason: v.reason, seq: r.seq };
    if (opts.expectedSigner && v.signer !== opts.expectedSigner) return { ok: false, reason: 'signer_not_pinned_broker_key', seq: r.seq };
    if (opts.channelId && r.channelId !== opts.channelId) return { ok: false, reason: 'wrong_channel', seq: r.seq };
    if (r.seq !== prevSeq + 1) return { ok: false, reason: prevSeq && r.seq === prevSeq ? 'replayed_seq' : 'seq_gap', seq: r.seq };
    if (r.cumSats !== prevCumSats + r.sats) return { ok: false, reason: 'cumSats_does_not_reconcile', seq: r.seq };
    if (r.cumTokens !== prevCumTokens + r.inputTokens + r.outputTokens) return { ok: false, reason: 'cumTokens_does_not_reconcile', seq: r.seq };
    if (opts.fundedSats !== undefined && r.cumSats > opts.fundedSats) return { ok: false, reason: 'cumSats_exceeds_funded', seq: r.seq };
    prevSeq = r.seq; prevCumSats = r.cumSats; prevCumTokens = r.cumTokens;
  }
  return { ok: true, count: list.length, cumSats: prevCumSats, cumTokens: prevCumTokens };
}
