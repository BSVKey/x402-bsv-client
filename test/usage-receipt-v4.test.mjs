// v4 (sub-satoshi) client verifier tests. Signs with an ephemeral key, building each
// receipt the way the broker does for a non-custodial channel. No network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PrivateKey, BSM, Utils } from '@bsv/sdk';
import {
  verifyReceipt, verifyReceiptChain, verifyCharge, computeClaimId, computeChargeMicro, closeSatsFromMicro,
  RECEIPT_SCHEMA, RECEIPT_SCHEMA_V4, METER_ID,
} from '../usage-receipt.js';

const priv = PrivateKey.fromRandom();
const signer = priv.toPublicKey().toString();
const rates = { rateInPer1k: 1, rateOutPer1k: 1, webSearchSats: 0, discountPct: 0, minChargeSats: 1 };

function sign(b) {
  const claimId = computeClaimId(b);
  return { ...b, claimId, signature: BSM.sign(Utils.toArray(claimId, 'utf8'), priv, 'base64'), brokerPubKey: signer };
}
// One receipt per charge: inputTokens = the honest millisat price at 1 sat per 1k.
function chain(charges, { tokens = (m) => ({ inputTokens: m, outputTokens: 0 }), extra = {} } = {}) {
  let cumMicro = 0, cumTokens = 0;
  return charges.map((microSats, i) => {
    const t = tokens(microSats);
    const prev = cumMicro;
    cumMicro += microSats; cumTokens += t.inputTokens + t.outputTokens;
    return sign({
      v: RECEIPT_SCHEMA_V4, channelId: 'chan-1', seq: i + 1, model: 'm', meter: METER_ID, pricebookId: 'pb',
      ...rates, ...t, inputDigest: 'x', outputDigest: 'y',
      sats: Math.floor(cumMicro / 1000) - Math.floor(prev / 1000), cumTokens, cumSats: Math.floor(cumMicro / 1000), fundedSats: 50,
      timestamp: 't', k: 1000, microSats, cumMicro, minChargeMicro: 1, ...extra,
    });
  });
}

test('v4: a call can cost less than a satoshi, and the receipt proves it', async () => {
  assert.equal(computeChargeMicro({ inputTokens: 3, outputTokens: 2, ...rates, minChargeMicro: 1 }), 5);
  const [r] = chain([5]);
  assert.deepEqual([r.sats, r.cumSats], [0, 0]);
  assert.deepEqual(await verifyReceipt(r), { ok: true, signer });
  assert.deepEqual(verifyCharge(r), { ok: true });
});

test('v4 chain reconciles in millisats; the close is Q* (half up)', async () => {
  const list = chain([5, 400, 700, 5]);
  const v = await verifyReceiptChain(list, { expectedSigner: signer, channelId: 'chan-1', fundedSats: 50 });
  assert.deepEqual([v.ok, v.cumMicro, v.cumSats], [true, 1110, 1]);
  assert.equal(closeSatsFromMicro(1110, 50), 1);
  assert.equal(closeSatsFromMicro(1500, 50), 2);
  assert.equal(closeSatsFromMicro(1499, 50), 1);
  assert.throws(() => closeSatsFromMicro(50001, 50));
});

test('v4 refuses overcharge, wrong whole-sat totals, gaps and mixed versions', async () => {
  const [over] = chain([7], { tokens: () => ({ inputTokens: 3, outputTokens: 2 }) });
  assert.equal(verifyCharge(over).reason, 'overcharge');

  const [r] = chain([1500]);
  assert.equal((await verifyReceipt(sign({ ...r, claimId: undefined, signature: undefined, brokerPubKey: undefined, cumSats: 2, sats: 2 }))).reason, 'cumSats_not_floor_of_cumMicro');
  assert.equal((await verifyReceipt(sign({ ...r, claimId: undefined, signature: undefined, brokerPubKey: undefined, sats: 0 }))).reason, 'sats_not_whole_sats_crossed');
  assert.equal((await verifyReceipt(sign({ ...r, claimId: undefined, signature: undefined, brokerPubKey: undefined, k: 100 }))).reason, 'bad_k:100');

  const two = chain([5, 5]);
  const bumped = sign({ ...two[1], claimId: undefined, signature: undefined, brokerPubKey: undefined, cumMicro: 11 });
  assert.equal((await verifyReceiptChain([two[0], bumped], { expectedSigner: signer })).reason, 'cumMicro_does_not_reconcile');

  const v2 = sign({
    v: RECEIPT_SCHEMA, channelId: 'chan-1', seq: 2, model: 'm', meter: METER_ID, pricebookId: 'pb', ...rates,
    inputTokens: 5, outputTokens: 0, inputDigest: 'x', outputDigest: 'y', sats: 1, cumTokens: 10, cumSats: 1, fundedSats: 50, timestamp: 't',
  });
  assert.equal((await verifyReceiptChain([two[0], v2], { expectedSigner: signer })).reason, 'mixed_receipt_versions');
  const v2WithMicro = sign({ ...v2, claimId: undefined, signature: undefined, brokerPubKey: undefined, microSats: 5 });
  assert.equal((await verifyReceipt(v2WithMicro)).reason, 'unknown_field:microSats');
});

test('v4 with hidden tokens: all v3 fields or none, billed at the same rates', async () => {
  const hidden = { hiddenInputTokens: 0, hiddenOutputTokens: 4, hiddenSource: 'provider', maxOutputTokens: 100 };
  const [r] = chain([9], { tokens: () => ({ inputTokens: 3, outputTokens: 2 }), extra: hidden });
  assert.equal((await verifyReceipt(r)).ok, true);
  assert.deepEqual(verifyCharge(r), { ok: true });
  const { hiddenSource, ...partial } = r;
  assert.equal((await verifyReceipt(sign({ ...partial, claimId: undefined, signature: undefined, brokerPubKey: undefined }))).ok, false);
});
