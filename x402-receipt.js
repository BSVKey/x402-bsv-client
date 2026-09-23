// Verify BSVKey per-call x402 DELIVERED receipts (x402-receipt/1), client-side,
// offline. The channel usage receipt (./usage-receipt.js) audits a funded
// channel's meter and running balances; a per-call x402 payment has no channel,
// so its receipt binds the delivered bytes to a single on-chain settlement.
//
// This module exists because the usage-receipt verifier rejects an x402 receipt
// with `unknown_field:rail`: they are two schemas. Use verifyAnyReceipt() as the
// one entry point that routes on the receipt's own `v` tag, so a caller never has
// to hand-roll the x402 check from the spec.
//
//   verifyX402Receipt   authorship + integrity (claimId + BSM signature recovery)
//   bindX402Receipt     ties the receipt to the payment YOU made (settlementRef,
//                       and optionally payTo/amountAtomic/payer) — the acceptance
//                       rule stays with the verifier, so an UNBOUND check refuses
//                       rather than passing. This is what stops a receipt being a
//                       bearer object anyone who holds it can verify as theirs.
//   verifyX402Delivery  the outputDigest (and inputDigest) recompute from the EXACT
//                       response you hold, under the pinned meter (bsvkey-meter/1)
//   verifyX402ReceiptFull  all of the above in one call
//   verifyAnyReceipt    schema-dispatch: x402-receipt/1 OR usage-receipt/2 or /3
//
// Pin the broker key once from GET /v1/receipt-key. Peer dep: @bsv/sdk (v2).
// The txid and your payer address come from readSettlement(res) (index.js), which
// decodes the X-PAYMENT-RESPONSE header of the paid 200.

import { createHash } from 'node:crypto';
import {
  canonicalize, meterInputText, messagesToPrompt, RECEIPT_SCHEMA as USAGE_RECEIPT_SCHEMA, RECEIPT_SCHEMA_V3 as USAGE_RECEIPT_SCHEMA_V3,
  verifyReceipt as verifyUsageReceipt,
} from './usage-receipt.js';

let _sdk = null;
async function sdk() { if (_sdk) return _sdk; _sdk = await import('@bsv/sdk'); return _sdk; }

export const X402_RECEIPT_SCHEMA = 'bsvkey.x402-receipt/1';
export const METER_ID = 'bsvkey-meter/1';

const sha256hex = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex');

// `payer` is an OPTIONAL signed content field: the address that funded
// settlementRef. It is omitted from the hash when absent (pickContent), so a
// receipt issued without it hashes exactly as before. When present it lets a
// verifier refuse a receipt paid from an address other than its own.
const CONTENT_FIELDS = [
  'v', 'rail', 'network', 'settlementRef', 'payTo', 'asset', 'amountAtomic', 'priceUsd',
  'payer',
  'model', 'meter', 'inputTokens', 'outputTokens', 'inputDigest', 'outputDigest', 'timestamp',
];
const ALLOWED_KEYS = new Set([...CONTENT_FIELDS, 'claimId', 'signature', 'brokerPubKey']);

function pickContent(obj) {
  const c = {};
  for (const k of CONTENT_FIELDS) if (obj[k] !== undefined) c[k] = obj[k];
  return c;
}
export function computeClaimId(obj) {
  return `0x${createHash('sha256').update(canonicalize(pickContent(obj)), 'utf8').digest('hex')}`;
}

// Authorship + integrity: strict shape, claimId content-address, recover the
// signer from the compact BSM signature. { ok:true, signer } / { ok:false, reason }.
// The caller pins `signer` against the broker's GET /v1/receipt-key.
export async function verifyX402Receipt(receipt) {
  if (receipt === null || typeof receipt !== 'object') return { ok: false, reason: 'not_an_object' };
  for (const k of Object.keys(receipt)) if (!ALLOWED_KEYS.has(k)) return { ok: false, reason: `unknown_field:${k}` };
  if (receipt.v !== X402_RECEIPT_SCHEMA) return { ok: false, reason: `bad_schema:${receipt.v}` };
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

// Bind a receipt to the payment YOU made. A signed, delivery-checked receipt is
// still a bearer object: it verifies for whoever holds it, because nothing above
// ties it to a payer. It is yours only when you check its settlementRef against
// the txid you actually paid (readSettlement(res).txid) — and, if present, its
// payer against the address you paid from (readSettlement(res).payer). The
// expected values MUST come from your own context, never be read back out of the
// receipt, so an absent expected.settlementRef is a REFUSAL, not a skip.
export function bindX402Receipt(receipt, expected = {}) {
  if (!expected || typeof expected !== 'object' || !expected.settlementRef) {
    return { ok: false, reason: 'unbound: verifier must supply the settlementRef it paid' };
  }
  const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  if (!eq(receipt.settlementRef, expected.settlementRef)) return { ok: false, reason: 'settlementRef_not_mine' };
  if (expected.payTo !== undefined && !eq(receipt.payTo, expected.payTo)) return { ok: false, reason: 'payTo_mismatch' };
  if (expected.amountAtomic !== undefined && Number(receipt.amountAtomic) !== Number(expected.amountAtomic)) return { ok: false, reason: 'amount_mismatch' };
  if (expected.payer !== undefined && receipt.payer !== undefined && !eq(receipt.payer, expected.payer)) return { ok: false, reason: 'payer_not_mine' };
  if (expected.payer !== undefined && receipt.payer === undefined && expected.requirePayer) return { ok: false, reason: 'receipt_has_no_payer_to_bind' };
  return { ok: true };
}

// The delivered check: recompute the digests from the EXACT response you hold,
// under the pinned meter. Pass EITHER { system, prompt } (broker-native) OR the
// { messages } array you sent to /v1/chat/completions (the OpenAI shim meters the
// flattened messages). If `messages` is given it takes precedence.
export function verifyX402Delivery(receipt, { system, prompt, completion, messages } = {}) {
  if (receipt.meter !== undefined && receipt.meter !== METER_ID) return { ok: false, reason: `unknown_meter:${receipt.meter}` };
  if (messages !== undefined) { const f = messagesToPrompt(messages); system = f.system; prompt = f.prompt; }
  const output = String(completion || '');
  if (sha256hex(output) !== receipt.outputDigest) return { ok: false, reason: 'outputDigest_mismatch' };
  if (system !== undefined || prompt !== undefined || messages !== undefined) {
    if (sha256hex(meterInputText(system, prompt)) !== receipt.inputDigest) return { ok: false, reason: 'inputDigest_mismatch' };
  }
  return { ok: true };
}

// All four checks a caller must pass before treating a receipt as proof of its
// OWN paid call: internally consistent + signer recovered, signer is the pinned
// broker key, bound to the payment you made (never skippable), delivered bytes
// match the response you hold. Omit expectedSigner or the delivery inputs to run
// a subset; the settlement binding is always required.
export async function verifyX402ReceiptFull(receipt, {
  expectedSigner, settlementRef, payTo, amountAtomic, payer, requirePayer,
  system, prompt, completion, messages,
} = {}) {
  const v = await verifyX402Receipt(receipt);
  if (!v.ok) return v;
  if (expectedSigner && v.signer !== expectedSigner) return { ok: false, reason: 'signer_not_pinned_broker_key' };
  const b = bindX402Receipt(receipt, { settlementRef, payTo, amountAtomic, payer, requirePayer });
  if (!b.ok) return b;
  if (completion !== undefined || system !== undefined || prompt !== undefined || messages !== undefined) {
    const d = verifyX402Delivery(receipt, { system, prompt, completion, messages });
    if (!d.ok) return d;
  }
  return { ok: true, signer: v.signer };
}

// One entry point for either receipt schema: route on the receipt's own `v` tag.
// This is the fix for the version skew — a caller pinned to the usage-receipt
// verifier rejects an x402 receipt with `unknown_field:rail`. Each schema keeps
// its own strict field set; this only chooses which strict verifier runs.
export async function verifyAnyReceipt(receipt) {
  if (receipt === null || typeof receipt !== 'object') return { ok: false, reason: 'not_an_object' };
  switch (receipt.v) {
    case X402_RECEIPT_SCHEMA:   return verifyX402Receipt(receipt);
    case USAGE_RECEIPT_SCHEMA:  return verifyUsageReceipt(receipt);
    case USAGE_RECEIPT_SCHEMA_V3: return verifyUsageReceipt(receipt);
    default:                    return { ok: false, reason: `unknown_schema:${receipt.v}` };
  }
}
