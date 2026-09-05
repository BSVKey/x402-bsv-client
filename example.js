// Runnable example: pay for one inference in BSV via x402.
//   BSV_WIF=<funded WIF> node example.js "your prompt here"
//
// Needs @bsv/sdk installed and a funded mainnet key. Without BSV_WIF it stops at
// the 402 and just prints the quote (safe, no payment).

import { fetchWithX402, buildX402Payment, readSettlement } from './index.js';

const URL = process.env.X402_URL || 'https://inference.bsvkey.com/v1/x402/chat/completions';
const prompt = process.argv[2] || 'In one sentence, why do AI agents want per-token billing?';
const wif = process.env.BSV_WIF;

const init = {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: process.env.X402_MODEL || 'grok-4.3', messages: [{ role: 'user', content: prompt }], max_tokens: 256 }),
};

if (!wif) {
  // No key: just fetch the 402 quote so you can see the price without paying.
  const r = await fetch(URL, init);
  const body = await r.json();
  const req = (body.accepts || [])[0];
  console.log(`Quote: ${req?.maxAmountRequired} sat to ${req?.payTo} on ${req?.network} (model ${req?.extra?.model}).`);
  console.log('Set BSV_WIF=<funded key> to actually pay and get the answer.');
} else {
  console.log('Paying and running…');
  const res = await fetchWithX402(URL, init, { wif });
  if (!res.ok) {
    console.error('failed:', res.status, await res.text());
  } else {
    const data = await res.json();
    console.log('\nAnswer:\n' + (data.choices?.[0]?.message?.content || '(none)'));
    console.log('\nSettlement:', readSettlement(res));
    console.log('Paid:', data.x_bsv?.paidSats, 'sat →', data.x_bsv?.payTo);
  }
}
