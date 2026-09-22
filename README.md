# @bsvkey/x402-bsv-client

[![npm version](https://img.shields.io/npm/v/@bsvkey/x402-bsv-client.svg)](https://www.npmjs.com/package/@bsvkey/x402-bsv-client)
[![license: MIT](https://img.shields.io/npm/l/@bsvkey/x402-bsv-client.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/@bsvkey/x402-bsv-client.svg)](https://nodejs.org)

Pay an [x402](https://x402.org) `402 Payment Required` **in BSV**, in one line.

**Live gateway:** [inference.bsvkey.com/#x402](https://inference.bsvkey.com/#x402) · discovery at [`/v1/x402`](https://inference.bsvkey.com/v1/x402)

x402 ships payment builders for EVM (EIP-3009) and Solana. This is the missing
one for the **`bsv-p2pkh`** scheme — so an AI agent can pay a BSV-settled x402
endpoint (like `inference.bsvkey.com`) with true sub-cent, per-call micropayments.

```bash
npm i @bsvkey/x402-bsv-client @bsv/sdk
```

## Use it

```js
import { fetchWithX402, readSettlement } from '@bsvkey/x402-bsv-client';

const res = await fetchWithX402(
  'https://inference.bsvkey.com/v1/x402/chat/completions',
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'grok-4.3', messages: [{ role: 'user', content: 'Say hi in 3 words' }] }),
  },
  { wif: process.env.BSV_WIF } // a funded BSV private key (WIF)
);

const data = await res.json();
console.log(data.choices[0].message.content);        // the answer
console.log(readSettlement(res));                     // { success, transaction (on-chain txid), network, ... }
```

That's the whole x402 handshake, handled for you:

1. `POST` the request → server replies **402** with the quoted price.
2. This lib builds + signs a BSV tx paying the quoted amount to the server's `payTo`.
3. Retries with the `X-PAYMENT` header → server settles on-chain and returns **200** + the answer.

## Lower level

```js
import { buildX402Payment } from '@bsvkey/x402-bsv-client';

// Given an x402 402 response body, produce the base64 X-PAYMENT header value:
const xPayment = await buildX402Payment(body402, wif);
```

## Notes

- **Key format:** `wif` accepts either a **WIF** (starts `K`/`L`/`5`) or a **12/24-word
  recovery phrase** (derived on the BSV path `m/44'/236'/0'/0/0`, the same one
  inference.bsvkey.com uses) — so a wallet generated on the site works here directly.
- **Funding:** the key's address must hold enough BSV to cover the quoted amount + a
  small fee. Fund it like any BSV address (the `payTo`/QR flow on inference.bsvkey.com works).
- **Back-to-back calls are safe:** the client chains each payment off its own change,
  so a loop of paid calls won't double-spend while the mempool catches up.
- **Non-custodial:** your key never leaves the process; the signed transaction pays the
  server's address directly.
- **Networks:** `bsv` (mainnet) and `bsv-testnet`. Testnet lets you dry-run for free.

## Verify usage receipts

If you use the BSVKey inference broker over a **prepaid channel**, every settled
call returns a signed `usageReceipt`. This package verifies them offline, so you
can audit the broker's meter without trusting its word and without a round-trip.

```js
import { verifyReceiptChain } from '@bsvkey/x402-bsv-client/usage-receipt';

// Pin the broker key once (GET https://inference.bsvkey.com/v1/receipt-key).
const { receiptPubKey } = await (await fetch('https://inference.bsvkey.com/v1/receipt-key')).json();

// `receipts` = the usageReceipt from each call on your channel.
const audit = await verifyReceiptChain(receipts, {
  expectedSigner: receiptPubKey,
  channelId: myChannelId,
  fundedSats: myChannelFundedSats,
});
// { ok: true, count, cumSats, cumTokens }  — or { ok: false, reason, seq }
```

`verifyReceiptChain` checks, across the whole chain, that: each signature
recovers to the pinned broker key, every receipt is for your channel, the
sequence has no gap or replay, the running totals reconcile
(`cumSats`/`cumTokens`), spending never exceeds the funded amount, and each
**charge** recomputes from the published formula (you can be charged less, never
more). An **empty chain is refused** (`reason: 'empty_chain'`) — it proves
nothing, so a client that lost its receipts fails the check rather than passing
vacuously.

Two things worth pinning down as an unattended client:

- **`fundedSats` is yours to supply.** The receipt carries a `fundedSats`, but
  that is the broker's own signed assertion, not proof of the funding
  transaction. For "spending never exceeds what the channel actually paid" to
  mean the on-chain amount, pass `opts.fundedSats` set to the amount **you**
  funded. When you do, a receipt that claims **more** funding than you supplied
  is rejected (`funded_mismatch`), so the broker can't widen the cap by signing a
  larger number, and `cumSats` is bounded by each receipt's own `fundedSats`.
  **Top-ups are supported:** `fundedSats` may rise across the chain (a drop is
  rejected as `funded_decreased`), so after you top a channel up, pass your new
  **current total** and the whole chain — the receipts before and after the
  top-up — verifies in one call. Omit `opts.fundedSats` and the check falls back
  to the broker-asserted number.
- **Pass `opts.channelId`.** The "my channel and no other" check only runs when
  you pass the channel you funded; without it a receipt for a different channel
  is not rejected.
- **The receipt is the ledger; the balance endpoint is a cache.** The broker's
  `GET /v1/channels/:id` can lag the signed receipt by ~20s. Trust the receipt's
  `cumSats`/`balanceSatsAfter`; treat the endpoint as eventually-consistent.

Single-receipt helpers: `verifyReceipt(receipt)` → `{ ok, signer }`,
`verifyCharge(receipt)`, and `verifyMeter(receipt, { messages, completion })` (or
`{ system, prompt, completion }` on the raw `/v1/infer` path — see below).

### Verify the meter (the token count itself)

The v2 receipt binds the exact bytes and is metered by a pinned, deterministic
tokenizer, so you recompute the token count from what you sent and received.

**On the OpenAI-compatible `/v1/chat/completions` path, pass the same `messages`
array you sent** — that endpoint meters the *flattened* messages (system joined
with `\n`; every other turn rendered as `User: …` / `Assistant: …`, joined with
`\n`), so `verifyMeter` needs the messages to reproduce that transform for you:

```js
import { verifyMeter } from '@bsvkey/x402-bsv-client/usage-receipt';
const m = verifyMeter(receipt, { messages, completion }); // { ok } / { ok:false, reason }
```

On the broker-native `/v1/infer` path (raw fields), pass `{ system, prompt, completion }`
instead. (`messagesToPrompt(messages)` is exported if you want the flattened
`{ system, prompt }` yourself.)

**What this proves:** the broker signed these exact numbers (non-repudiable), the
token count is the published function of the exact bytes you exchanged, the charge
is the published function of those tokens, none were double-counted, and the
totals stay within what you funded. **What it does not prove:** that
`bsvkey-meter/1` equals a model provider's internal token count (it is BSVKey's
own published unit). Spec: https://inference.bsvkey.com/usage-receipts.md

## Verify per-call x402 receipts

The prepaid-channel path returns a `usageReceipt` (above). The **per-call** paths
(`/v1/x402/chat/completions`, `/v1/x402/base/chat/completions`) return a per-call
**delivered receipt** instead: schema `bsvkey.x402-receipt/1`, no channel or
balances, binding one response to one on-chain settlement. Its verifier is a
separate schema, so the channel verifier rejects it with `unknown_field:rail`. Use
`verifyAnyReceipt` (routes on the receipt's own `v`) or the x402-specific helpers:

```js
import { readSettlement, verifyX402ReceiptFull } from '@bsvkey/x402-bsv-client';

const res = await fetchWithX402(url, init, { wif });
const receipt = (await res.clone().json()).receipt;   // the delivered receipt
const paid = readSettlement(res);                     // { txid, payer, ... } YOU paid

const { receiptPubKey } = await (await fetch('https://inference.bsvkey.com/v1/receipt-key')).json();
const v = await verifyX402ReceiptFull(receipt, {
  expectedSigner: receiptPubKey,       // signer is the pinned broker key
  settlementRef: paid.txid,            // REQUIRED — the tx you paid, from your context
  payer: paid.payer,                   // optional — the address you paid from
  messages, completion,                // the response you hold
}); // { ok:true, signer } / { ok:false, reason }
```

**Bind it to your own payment.** A receipt is a *bearer object*: recomputing its
id, recovering its signer, and matching the delivered bytes are all true for
whoever holds it. It is **yours** only when you check its `settlementRef` against
the txid you actually paid — which is why `settlementRef` is **required** and an
unbound check *refuses* rather than passing. Pass it from `readSettlement(res)`,
never read it back out of the receipt. Lower-level pieces if you want them:
`verifyX402Receipt` (authorship), `bindX402Receipt(receipt, { settlementRef, payTo, amountAtomic, payer })`
(the binding), `verifyX402Delivery(receipt, { messages, completion })` (the bytes).

**What this proves:** the broker signed that this exact response was delivered for
that settlement, and — once bound — for **your** settlement. **What it does not
prove:** that the compute was correct.

MIT.
