// Verifies the client-side usage-receipt verifier against receipts it signs
// with an ephemeral key (mirrors how the broker signs). No network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PrivateKey, BSM, Utils } from '@bsv/sdk';
import { verifyReceipt, verifyReceiptChain, computeClaimId, RECEIPT_SCHEMA } from '../usage-receipt.js';

// Sign a receipt body the same way the broker does (compact recoverable BSM).
function sign(priv, body) {
  const full = { v: RECEIPT_SCHEMA, ...body };
  const claimId = computeClaimId(full);
  const signature = BSM.sign(Utils.toArray(claimId, 'utf8'), priv, 'base64');
  return { ...full, claimId, signature, brokerPubKey: priv.toPublicKey().toString() };
}

const CHAN = 'chan-1';
const FUNDED = 10000;
function chain(priv, n, { sats = 100, inTok = 40, outTok = 60 } = {}) {
  const out = [];
  let cumSats = 0, cumTokens = 0;
  for (let seq = 1; seq <= n; seq++) {
    cumSats += sats; cumTokens += inTok + outTok;
    out.push(sign(priv, { channelId: CHAN, seq, model: 'm', inputTokens: inTok, outputTokens: outTok, sats, cumTokens, cumSats, fundedSats: FUNDED, timestamp: 't' }));
  }
  return out;
}

test('a clean chain verifies and pins the broker key', async () => {
  const priv = PrivateKey.fromRandom();
  const r = chain(priv, 4);
  const v = await verifyReceiptChain(r, { expectedSigner: priv.toPublicKey().toString(), channelId: CHAN, fundedSats: FUNDED });
  assert.deepEqual(v, { ok: true, count: 4, cumSats: 400, cumTokens: 400 });
});

test('tamper, wrong signer, replay, gap, non-reconciling totals, over-funded, strict shape', async () => {
  const priv = PrivateKey.fromRandom();
  const attacker = PrivateKey.fromRandom();
  const r = chain(priv, 3);

  assert.equal((await verifyReceipt({ ...r[0], sats: 1 })).reason, 'claimId_mismatch');
  assert.equal((await verifyReceipt({ ...r[0], extra: 'x' })).reason.startsWith('unknown_field:'), true);
  assert.equal((await verifyReceiptChain(chain(attacker, 2), { expectedSigner: priv.toPublicKey().toString() })).reason, 'signer_not_pinned_broker_key');
  assert.equal((await verifyReceiptChain([r[0], r[1], r[1]], { expectedSigner: priv.toPublicKey().toString() })).reason, 'replayed_seq');
  assert.equal((await verifyReceiptChain([r[0], r[2]], { expectedSigner: priv.toPublicKey().toString() })).reason, 'seq_gap');
  assert.equal((await verifyReceiptChain(chain(priv, 200), { fundedSats: FUNDED })).reason, 'cumSats_exceeds_funded');

  const a = sign(priv, { channelId: CHAN, seq: 1, model: 'm', inputTokens: 10, outputTokens: 10, sats: 100, cumTokens: 20, cumSats: 100, fundedSats: FUNDED, timestamp: 't' });
  const b = sign(priv, { channelId: CHAN, seq: 2, model: 'm', inputTokens: 10, outputTokens: 10, sats: 100, cumTokens: 40, cumSats: 150, fundedSats: FUNDED, timestamp: 't' });
  assert.equal((await verifyReceiptChain([a, b], {})).reason, 'cumSats_does_not_reconcile');
});
