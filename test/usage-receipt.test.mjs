// v2 client verifier tests: authorship, charge recompute, meter recompute, and
// the full chain. Signs with an ephemeral key (as the broker does). No network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PrivateKey, BSM, Utils } from '@bsv/sdk';
import {
  verifyReceipt, verifyReceiptChain, verifyCharge, verifyMeter,
  computeClaimId, computeChargeSats, meterInputText, messagesToPrompt, estimateTokens, RECEIPT_SCHEMA, METER_ID,
} from '../usage-receipt.js';

const sha = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex');
const CHAN = 'chan-1', FUNDED = 1_000_000, RATE_IN = 500, RATE_OUT = 1500, MIN = 1;

function sign(priv, over = {}) {
  const inTok = over.inputTokens ?? 40, outTok = over.outputTokens ?? 60;
  const b = {
    v: RECEIPT_SCHEMA, channelId: CHAN, seq: 1, model: 'm', meter: METER_ID, pricebookId: 'pb',
    inputTokens: inTok, outputTokens: outTok, inputDigest: 'x', outputDigest: 'y',
    rateInPer1k: RATE_IN, rateOutPer1k: RATE_OUT, webSearchSats: 0, discountPct: 0, minChargeSats: MIN,
    sats: computeChargeSats({ inputTokens: inTok, outputTokens: outTok, rateInPer1k: RATE_IN, rateOutPer1k: RATE_OUT, minChargeSats: MIN }),
    cumTokens: inTok + outTok, cumSats: 0, fundedSats: FUNDED, timestamp: 't', ...over,
  };
  const claimId = computeClaimId(b);
  return { ...b, claimId, signature: BSM.sign(Utils.toArray(claimId, 'utf8'), priv, 'base64'), brokerPubKey: priv.toPublicKey().toString() };
}
function chain(priv, n) {
  const out = []; let cumSats = 0, cumTokens = 0;
  for (let seq = 1; seq <= n; seq++) {
    const sats = computeChargeSats({ inputTokens: 40, outputTokens: 60, rateInPer1k: RATE_IN, rateOutPer1k: RATE_OUT, minChargeSats: MIN });
    cumSats += sats; cumTokens += 100;
    out.push(sign(priv, { seq, sats, cumTokens, cumSats }));
  }
  return out;
}

test('clean chain verifies (signer + charge + continuity)', async () => {
  const priv = PrivateKey.fromRandom();
  const per = computeChargeSats({ inputTokens: 40, outputTokens: 60, rateInPer1k: RATE_IN, rateOutPer1k: RATE_OUT, minChargeSats: MIN });
  const v = await verifyReceiptChain(chain(priv, 4), { expectedSigner: priv.toPublicKey().toString(), channelId: CHAN, fundedSats: FUNDED });
  assert.deepEqual(v, { ok: true, count: 4, cumSats: per * 4, cumTokens: 400 });
});

test('overcharge is caught; undercharge is allowed', async () => {
  const priv = PrivateKey.fromRandom();
  const per = computeChargeSats({ inputTokens: 40, outputTokens: 60, rateInPer1k: RATE_IN, rateOutPer1k: RATE_OUT, minChargeSats: MIN });
  assert.equal((await verifyCharge(sign(priv, { sats: per + 25, cumSats: per + 25 }))).reason, 'overcharge');
  assert.equal((verifyCharge(sign(priv, { sats: per - 5, cumSats: per - 5 }))).ok, true); // undercharge ok
});

test('meter recomputes from the exact bytes', async () => {
  const priv = PrivateKey.fromRandom();
  const system = 'be terse', prompt = 'hi', completion = 'hello there';
  const input = meterInputText(system, prompt);
  const inTok = estimateTokens(input), outTok = estimateTokens(completion);
  const r = sign(priv, { inputTokens: inTok, outputTokens: outTok, inputDigest: sha(input), outputDigest: sha(completion), sats: computeChargeSats({ inputTokens: inTok, outputTokens: outTok, rateInPer1k: RATE_IN, rateOutPer1k: RATE_OUT, minChargeSats: MIN }) });
  assert.deepEqual(verifyMeter(r, { system, prompt, completion }), { ok: true });
  assert.equal(verifyMeter(r, { system, prompt, completion: 'tampered' }).ok, false);
});

test('meter verifies from the flattened OpenAI messages (chat-completions path)', async () => {
  const priv = PrivateKey.fromRandom();
  const messages = [{ role: 'system', content: 'be terse' }, { role: 'user', content: 'hi there' }];
  const flat = messagesToPrompt(messages);
  assert.equal(flat.system, 'be terse');
  assert.equal(flat.prompt, 'User: hi there'); // role-prefixed, as the broker meters it
  const input = meterInputText(flat.system, flat.prompt), completion = 'hello';
  const inTok = estimateTokens(input), outTok = estimateTokens(completion);
  const r = sign(priv, { inputTokens: inTok, outputTokens: outTok, inputDigest: sha(input), outputDigest: sha(completion), sats: computeChargeSats({ inputTokens: inTok, outputTokens: outTok, rateInPer1k: RATE_IN, rateOutPer1k: RATE_OUT, minChargeSats: MIN }) });
  assert.deepEqual(verifyMeter(r, { messages, completion }), { ok: true });
  // the raw recipe (system+prompt without flattening) must NOT match this receipt
  assert.equal(verifyMeter(r, { system: 'be terse', prompt: 'hi there', completion }).ok, false);
});

test('an empty chain proves nothing and is refused', async () => {
  assert.deepEqual(await verifyReceiptChain([]), { ok: false, reason: 'empty_chain', count: 0 });
  assert.equal((await verifyReceiptChain(undefined)).reason, 'empty_chain');
});

test('tamper, wrong signer, replay, gap, bad schema', async () => {
  const priv = PrivateKey.fromRandom(), attacker = PrivateKey.fromRandom();
  const r = chain(priv, 3), signer = priv.toPublicKey().toString();
  assert.equal((await verifyReceipt({ ...r[0], inputTokens: 1 })).reason, 'claimId_mismatch');
  assert.equal((await verifyReceiptChain(chain(attacker, 2), { expectedSigner: signer })).reason, 'signer_not_pinned_broker_key');
  assert.equal((await verifyReceiptChain([r[0], r[1], r[1]], { expectedSigner: signer })).reason, 'replayed_seq');
  assert.equal((await verifyReceiptChain([r[0], r[2]], { expectedSigner: signer })).reason, 'seq_gap');
  assert.equal((await verifyReceipt({ ...r[0], v: 'bsvkey.usage-receipt/1' })).reason.startsWith('bad_schema') || (await verifyReceipt({ ...r[0], v: 'bsvkey.usage-receipt/1' })).reason === 'claimId_mismatch', true);
});
