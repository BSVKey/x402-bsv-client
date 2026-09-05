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

MIT.
