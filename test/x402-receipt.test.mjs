// Offline test for the client-side per-call x402 receipt verifier. Signs a
// receipt inline with a throwaway key (the package is verify-only), then checks
// verify + bind + delivery + schema-dispatch. No network. Peer dep: @bsv/sdk.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PrivateKey, BSM, Utils } from '@bsv/sdk';
import {
  computeClaimId, verifyX402Receipt, bindX402Receipt, verifyX402Delivery,
  verifyX402ReceiptFull, verifyAnyReceipt, X402_RECEIPT_SCHEMA,
} from '../x402-receipt.js';
import { computeClaimId as usageClaimId, meterInputText, RECEIPT_SCHEMA as USAGE_SCHEMA } from '../usage-receipt.js';

const sha = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex');
const priv = PrivateKey.fromRandom();
const pub = priv.toPublicKey().toString();

const system = null, prompt = 'Reply with exactly: hi', completion = 'hi';
const settlementRef = '77030c6192c6e86b808f1d7afa210b874bad86ed6a6b4ef69a8ccebc51ec83c6';

function signX402(body) {
  const claimId = computeClaimId(body);
  const signature = BSM.sign(Utils.toArray(claimId, 'utf8'), priv, 'base64');
  return { ...body, claimId, signature, brokerPubKey: pub };
}

const receipt = signX402({
  v: X402_RECEIPT_SCHEMA, rail: 'bsv', network: 'bsv', settlementRef,
  payTo: '1LdqUbdZ6GY71KxThU6aKfuKXxgmTn82cv', amountAtomic: 5942, priceUsd: 0.001,
  payer: '1ErDfgzGWe6kDSHWWZPUSpVRRvfQo7rDdZ',
  model: 'grok-4.3', meter: 'bsvkey-meter/1',
  inputTokens: 5, outputTokens: 1,
  inputDigest: sha(meterInputText(system, prompt)), outputDigest: sha(String(completion)),
  timestamp: '2026-09-05T14:40:00.000Z',
});

test('verifies and recovers the signer', async () => {
  const v = await verifyX402Receipt(receipt);
  assert.equal(v.ok, true);
  assert.equal(v.signer, pub);
});

test('binds to the caller\'s own payment, refuses a different one and refuses unbound', () => {
  assert.equal(bindX402Receipt(receipt, { settlementRef }).ok, true);
  assert.equal(bindX402Receipt(receipt, { settlementRef: '0'.repeat(64) }).reason, 'settlementRef_not_mine');
  assert.match(bindX402Receipt(receipt, {}).reason, /^unbound/);
  assert.equal(bindX402Receipt(receipt, { settlementRef, payer: '1SomeoneElsexxxxxxxxxxxxxxxxxxxxxx' }).reason, 'payer_not_mine');
});

test('delivery binds the held response and rejects a changed one', () => {
  assert.equal(verifyX402Delivery(receipt, { system, prompt, completion }).ok, true);
  assert.equal(verifyX402Delivery(receipt, { system, prompt, completion: completion + '!' }).reason, 'outputDigest_mismatch');
});

test('full check: passes for the payer, refuses the replay (holder who did not pay)', async () => {
  assert.equal((await verifyX402ReceiptFull(receipt, { expectedSigner: pub, settlementRef, system, prompt, completion })).ok, true);
  assert.equal((await verifyX402ReceiptFull(receipt, { expectedSigner: pub, settlementRef: '0'.repeat(64), system, prompt, completion })).reason, 'settlementRef_not_mine');
  assert.match((await verifyX402ReceiptFull(receipt, { expectedSigner: pub, system, prompt, completion })).reason, /^unbound/);
});

test('schema dispatch: one entry point for both schemas, no unknown_field:rail', async () => {
  assert.equal((await verifyAnyReceipt(receipt)).ok, true);
  // a usage-receipt/2 object, signed with the same key, routes to the usage verifier
  const ub = {
    v: USAGE_SCHEMA, channelId: 'c1', seq: 1, model: 'grok-4.3', meter: 'bsvkey-meter/1', pricebookId: 'pb/1',
    inputTokens: 1, outputTokens: 1, inputDigest: 'a'.repeat(64), outputDigest: 'b'.repeat(64),
    rateInPer1k: 1, rateOutPer1k: 1, webSearchSats: 0, discountPct: 0, minChargeSats: 1,
    sats: 1, cumTokens: 2, cumSats: 1, fundedSats: 10, timestamp: '2026-09-05T14:40:00.000Z',
  };
  const claimId = usageClaimId(ub);
  const usage = { ...ub, claimId, signature: BSM.sign(Utils.toArray(claimId, 'utf8'), priv, 'base64'), brokerPubKey: pub };
  const r = await verifyAnyReceipt(usage);
  assert.equal(r.ok, true);
  assert.notEqual(r.reason, 'unknown_field:rail');
  assert.match((await verifyAnyReceipt({ v: 'bsvkey.nope/1' })).reason, /^unknown_schema/);
});

test('the signer pin is required: a throwaway-key copy is refused, not passed (Sunnie)', async () => {
  // Sunnie's case: re-sign a genuine receipt's body with a throwaway key, same
  // settlementRef and digests, brokerPubKey dropped.
  const throwaway = PrivateKey.fromRandom();
  const { claimId, signature, brokerPubKey, ...body } = receipt;
  const cid = computeClaimId(body);
  const forged = { ...body, claimId: cid, signature: BSM.sign(Utils.toArray(cid, 'utf8'), throwaway, 'base64') };
  assert.equal((await verifyX402ReceiptFull(forged, { expectedSigner: pub, settlementRef, system, prompt, completion })).reason, 'signer_not_pinned_broker_key');
  assert.match((await verifyX402ReceiptFull(forged, { settlementRef, system, prompt, completion })).reason, /^unpinned/);
  assert.match((await verifyX402ReceiptFull(receipt, { settlementRef, system, prompt, completion })).reason, /^unpinned/, 'even the genuine receipt needs the pin');
  // verifyAnyReceipt is the integrity primitive: it hands back the signer for YOU to pin.
  const any = await verifyAnyReceipt(forged);
  assert.equal(any.ok, true);
  assert.notEqual(any.signer, pub);
});

test('binding compares Base58 addresses exactly, hex in any case', () => {
  const flip = (s) => [...s].map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join('');
  const payTo = receipt.payTo, payer = receipt.payer;
  assert.equal(bindX402Receipt(receipt, { settlementRef, payTo }).ok, true);
  assert.equal(bindX402Receipt(receipt, { settlementRef, payTo: flip(payTo) }).reason, 'payTo_mismatch');
  if (payer) assert.equal(bindX402Receipt(receipt, { settlementRef, payer: flip(payer) }).reason, 'payer_not_mine');
  assert.equal(bindX402Receipt(receipt, { settlementRef: settlementRef.toUpperCase() }).ok, true, 'a hex txid matches in any case');
});
