// Verify BSVKey inference usage receipts (v2), client-side, offline.
//
// The broker returns a signed `usageReceipt` on every settled prepaid-channel
// call. This verifies it with no round-trip and no trust in the broker's word:
//   - verifyReceipt      authorship + integrity (claimId + BSM signature recovery)
//   - verifyCharge       the sats are the published formula over the receipt's
//                        own token counts + pinned rates (overcharge is a dispute;
//                        undercharge, e.g. a channel cap, is allowed)
//   - verifyMeter        the token counts + byte digests recompute from the EXACT
//                        system/prompt/completion you hold, under the pinned
//                        tokenizer (bsvkey-meter/1). This is the 'last inch': the
//                        count is a deterministic function of the bytes exchanged.
//   - verifyReceiptChain the whole channel: pinned broker key, channel binding,
//                        monotonic seq (no gap/replay), reconciling running totals
//                        within the funded amount, and each charge.
//
// Pin the broker key once from GET /v1/receipt-key. Peer dep: @bsv/sdk (v2).
// Spec: https://inference.bsvkey.com/usage-receipts.md

import { createHash } from 'node:crypto';

let _sdk = null;
async function sdk() {
  if (_sdk) return _sdk;
  _sdk = await import('@bsv/sdk');
  return _sdk;
}

export const RECEIPT_SCHEMA = 'bsvkey.usage-receipt/2';
export const METER_ID = 'bsvkey-meter/1';

const CONTENT_FIELDS = [
  'v', 'channelId', 'seq', 'model', 'meter', 'pricebookId',
  'inputTokens', 'outputTokens', 'inputDigest', 'outputDigest',
  'rateInPer1k', 'rateOutPer1k', 'webSearchSats', 'discountPct', 'minChargeSats',
  'sats', 'cumTokens', 'cumSats', 'fundedSats', 'timestamp',
];
const ALLOWED_KEYS = new Set([...CONTENT_FIELDS, 'claimId', 'signature', 'brokerPubKey']);

const sha256hex = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex');

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeysDeep(value[k]);
    return out;
  }
  return value;
}
export function canonicalize(value) { return JSON.stringify(sortKeysDeep(value)); }
function pickContent(obj) {
  const c = {};
  for (const k of CONTENT_FIELDS) if (obj[k] !== undefined) c[k] = obj[k];
  return c;
}
export function computeClaimId(obj) {
  return `0x${createHash('sha256').update(canonicalize(pickContent(obj)), 'utf8').digest('hex')}`;
}

// --- the pinned meter (bsvkey-meter/1): byte-identical to the broker's -------
export function meterInputText(system, prompt) {
  return (system ? String(system) + '\n\n' : '') + String(prompt || '');
}
// The OpenAI-compatible endpoint (/v1/chat/completions) meters the FLATTENED
// chat messages, not the raw fields: system messages are joined with '\n', and
// every other turn becomes "User: <content>" / "Assistant: <content>", joined
// with '\n'. To recompute inputDigest for a chat call, pass the SAME messages
// array you sent (verifyMeter does this for you when given { messages }). This is
// byte-identical to the broker's src/http/openai.js messagesToPrompt.
export function messagesToPrompt(messages) {
  const systemParts = [], turns = [];
  for (const m of (Array.isArray(messages) ? messages : [])) {
    const content = typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content) ? m.content.map((p) => p.text || '').join('') : '';
    if (m.role === 'system') systemParts.push(content);
    else turns.push(`${m.role === 'assistant' ? 'Assistant' : 'User'}: ${content}`);
  }
  return { system: systemParts.join('\n') || undefined, prompt: turns.join('\n') };
}
export function estimateTokens(text) {
  if (!text) return 0;
  const byChars = Math.ceil(text.length / 4);
  const byWords = Math.ceil(text.trim().split(/\s+/).filter(Boolean).length * 1.3);
  return Math.max(byChars, byWords, 1);
}

// --- the frozen, integer-only charge formula (identical to the broker's) ------
export function computeChargeSats({ inputTokens, outputTokens, rateInPer1k, rateOutPer1k, webSearchSats = 0, discountPct = 0, minChargeSats }) {
  const tokenSats = Math.ceil((inputTokens * rateInPer1k + outputTokens * rateOutPer1k) / 1000);
  const gross = tokenSats + webSearchSats;
  const afterDiscount = Math.ceil((gross * (100 - discountPct)) / 100);
  return Math.max(minChargeSats, afterDiscount);
}

// Authorship + integrity: strict shape, claimId content-address, and recover the
// signer from the compact BSM signature. { ok:true, signer } / { ok:false, reason }.
export async function verifyReceipt(receipt) {
  if (receipt === null || typeof receipt !== 'object') return { ok: false, reason: 'not_an_object' };
  for (const k of Object.keys(receipt)) if (!ALLOWED_KEYS.has(k)) return { ok: false, reason: `unknown_field:${k}` };
  if (receipt.v !== RECEIPT_SCHEMA) return { ok: false, reason: `bad_schema:${receipt.v}` };
  if (computeClaimId(receipt).toLowerCase() !== String(receipt.claimId).toLowerCase()) return { ok: false, reason: 'claimId_mismatch' };
  const { BSM, Utils, Signature, BigNumber } = await sdk();
  let raw;
  try { raw = Utils.toArray(receipt.signature, 'base64'); } catch (e) { return { ok: false, reason: `bad_signature_encoding: ${e.message}` }; }
  if (!Array.isArray(raw) || raw.length !== 65 || raw[0] < 27 || raw[0] >= 35) return { ok: false, reason: 'bad_signature_encoding: not a 65-byte BSM compact signature' };
  const recoveryId = (raw[0] - 27) & 3;
  const msg = Utils.toArray(receipt.claimId, 'utf8');
  let recovered;
  try {
    const sig = Signature.fromCompact(receipt.signature, 'base64');
    recovered = sig.RecoverPublicKey(recoveryId, new BigNumber(BSM.magicHash(msg)));
    if (!BSM.verify(msg, sig, recovered)) return { ok: false, reason: 'signature_invalid' };
  } catch (e) { return { ok: false, reason: `signature_recovery_failed: ${e.message}` }; }
  const signer = recovered.toString();
  if (receipt.brokerPubKey !== undefined && receipt.brokerPubKey !== signer) return { ok: false, reason: 'brokerPubKey_does_not_match_recovered' };
  return { ok: true, signer };
}

// The charge is the published formula over the receipt's own fields. You can
// never be charged MORE than that; being charged less is allowed (channel cap).
export function verifyCharge(receipt) {
  const expected = computeChargeSats(receipt);
  if (receipt.sats > expected) return { ok: false, reason: 'overcharge', expected, got: receipt.sats };
  if (receipt.sats < receipt.minChargeSats) return { ok: false, reason: 'below_min_charge', expected: receipt.minChargeSats, got: receipt.sats };
  return receipt.sats === expected ? { ok: true } : { ok: true, note: 'undercharged' };
}

// The meter: recompute token counts + byte digests from the EXACT bytes you hold.
// Pass EITHER the raw { system, prompt } (broker-native /v1/infer) OR the exact
// { messages } array you sent to /v1/chat/completions (the OpenAI shim, which meters
// the flattened messages). If `messages` is given it takes precedence.
export function verifyMeter(receipt, { system, prompt, completion, messages } = {}) {
  if (receipt.meter !== METER_ID) return { ok: false, reason: `unknown_meter:${receipt.meter}` };
  if (messages !== undefined) { const f = messagesToPrompt(messages); system = f.system; prompt = f.prompt; }
  const input = meterInputText(system, prompt);
  const output = String(completion || '');
  if (sha256hex(input) !== receipt.inputDigest) return { ok: false, reason: 'inputDigest_mismatch' };
  if (sha256hex(output) !== receipt.outputDigest) return { ok: false, reason: 'outputDigest_mismatch' };
  if (estimateTokens(input) !== receipt.inputTokens) return { ok: false, reason: 'inputTokens_mismatch' };
  if (estimateTokens(output) !== receipt.outputTokens) return { ok: false, reason: 'outputTokens_mismatch' };
  return { ok: true };
}

// Verify a whole channel's receipt chain offline.
//   opts.expectedSigner : broker key pinned from GET /v1/receipt-key
//   opts.channelId      : your channel
//   opts.fundedSats     : the channel's on-chain funded amount
// Also recomputes each charge. Returns { ok, count, cumSats, cumTokens } or
// { ok:false, reason, seq }.
export async function verifyReceiptChain(receipts, opts = {}) {
  const list = [...receipts].sort((a, b) => (a.seq || 0) - (b.seq || 0));
  let prevSeq = 0, prevCumSats = 0, prevCumTokens = 0;
  for (const r of list) {
    const v = await verifyReceipt(r);
    if (!v.ok) return { ok: false, reason: v.reason, seq: r.seq };
    if (opts.expectedSigner && v.signer !== opts.expectedSigner) return { ok: false, reason: 'signer_not_pinned_broker_key', seq: r.seq };
    const c = verifyCharge(r);
    if (!c.ok) return { ok: false, reason: c.reason, seq: r.seq };
    if (opts.channelId && r.channelId !== opts.channelId) return { ok: false, reason: 'wrong_channel', seq: r.seq };
    if (r.seq !== prevSeq + 1) return { ok: false, reason: prevSeq && r.seq === prevSeq ? 'replayed_seq' : 'seq_gap', seq: r.seq };
    if (r.cumSats !== prevCumSats + r.sats) return { ok: false, reason: 'cumSats_does_not_reconcile', seq: r.seq };
    if (r.cumTokens !== prevCumTokens + r.inputTokens + r.outputTokens) return { ok: false, reason: 'cumTokens_does_not_reconcile', seq: r.seq };
    if (opts.fundedSats !== undefined && r.cumSats > opts.fundedSats) return { ok: false, reason: 'cumSats_exceeds_funded', seq: r.seq };
    prevSeq = r.seq; prevCumSats = r.cumSats; prevCumTokens = r.cumTokens;
  }
  return { ok: true, count: list.length, cumSats: prevCumSats, cumTokens: prevCumTokens };
}
