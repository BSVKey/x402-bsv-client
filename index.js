// @bsvkey/x402-bsv-client — pay an x402 "402 Payment Required" in BSV.
//
// x402 ships EVM (EIP-3009) and Solana payment builders; this is the missing BSV
// one for the `bsv-p2pkh` scheme. It turns an agent's paid API call into one line:
//
//   import { fetchWithX402 } from '@bsvkey/x402-bsv-client';
//   const res = await fetchWithX402('https://inference.bsvkey.com/v1/x402/chat/completions',
//     { method:'POST', headers:{'content-type':'application/json'},
//       body: JSON.stringify({ model:'grok-4.3', messages:[{role:'user',content:'hi'}] }) },
//     { wif: process.env.BSV_WIF });
//   const answer = (await res.json()).choices[0].message.content;
//
// It does the whole handshake: request -> 402 -> build+sign a BSV payment paying the
// quoted amount to payTo -> retry with the X-PAYMENT header -> return the 200 response
// (whose X-PAYMENT-RESPONSE header carries the on-chain settlement txid).
//
// Peer dependency: @bsv/sdk (v1). Node 18+ (global fetch).

import { PrivateKey, P2PKH, Transaction, Utils, Mnemonic, HD } from '@bsv/sdk';

// Accept either a WIF (starts K/L/5) or a 12/24-word BIP-39 recovery phrase
// (derived on BSV path m/44'/236'/0'/0/0 — the same path inference.bsvkey.com uses),
// so a key generated on the site works here directly.
function toPrivateKey(secret) {
  const s = String(secret || '').trim().replace(/\s+/g, ' ');
  if (!s) throw new Error('no key: set BSV_WIF to a WIF or a 12-word recovery phrase');
  if (Mnemonic.isValid(s)) return HD.fromSeed(Mnemonic.fromString(s).toSeed()).derive("m/44'/236'/0'/0/0").privKey;
  try { return PrivateKey.fromWif(s); } catch {}
  throw new Error('BSV_WIF is neither a valid WIF (starts K/L/5) nor a valid recovery phrase — you may have pasted a public address (starts with 1)');
}

const NET = { bsv: 'main', 'bsv-testnet': 'test', 'bsv-dev': 'main' };
const PREFIX = { main: [0x00], test: [0x6f] };

// --- session UTXO tracker: chain each payment off our own change so back-to-back
// paid calls don't double-spend while WhatsOnChain's unspent list catches up. ---
const _sessions = new Map(); // addr -> { spent:Set, change:[{tx,vout,satoshis}] }
function session(addr) {
  let s = _sessions.get(addr);
  if (!s) { s = { spent: new Set(), change: [] }; _sessions.set(addr, s); }
  return s;
}

function pickRequirement(body) {
  const accepts = (body && body.accepts) || [];
  return accepts.find((a) => a.scheme === 'bsv-p2pkh') || accepts[0] || null;
}

// Build the base64 X-PAYMENT header value for a given x402 402 body, paying in BSV.
export async function buildX402Payment(body402, wif, { wocBase } = {}) {
  const req = pickRequirement(body402);
  if (!req) throw new Error('no bsv-p2pkh payment requirement in the 402 response');
  const amount = Number(req.maxAmountRequired || req.amount || 0);
  if (!(amount > 0)) throw new Error('invalid amount in payment requirement');
  const net = NET[req.network] || 'main';
  const prefix = PREFIX[net];
  const base = (wocBase || 'https://api.whatsonchain.com/v1/bsv') + '/' + net;

  const priv = toPrivateKey(wif);
  const pub = priv.toPublicKey();
  const addr = pub.toAddress(prefix);
  const sess = session(addr);

  const tx = new Transaction();
  tx.addOutput({ lockingScript: new P2PKH().lock(Utils.fromBase58Check(req.payTo).data), satoshis: amount });

  const target = amount + 500; // amount + fee headroom
  let got = 0;
  const usedChange = [];

  // spend our own unconfirmed change first
  for (const c of sess.change) {
    tx.addInput({ sourceTransaction: c.tx, sourceOutputIndex: c.vout, unlockingScriptTemplate: new P2PKH().unlock(priv) });
    got += c.satoshis; usedChange.push(c);
    if (got >= target) break;
  }
  // then confirmed UTXOs, skipping anything already spent this session
  if (got < target) {
    const unspent = await (await fetch(`${base}/address/${addr}/unspent`)).json();
    if ((!unspent || !unspent.length) && !usedChange.length) throw new Error('wallet is unfunded: ' + addr);
    for (const u of (unspent || []).sort((a, b) => b.value - a.value)) {
      if (sess.spent.has(u.tx_hash + ':' + u.tx_pos)) continue;
      let src;
      try { const beef = await (await fetch(`${base}/tx/${u.tx_hash}/beef`)).text(); src = Transaction.fromBEEF(Utils.toArray(beef.trim(), 'hex')); }
      catch { const hex = await (await fetch(`${base}/tx/${u.tx_hash}/hex`)).text(); src = Transaction.fromHex(hex.trim()); }
      tx.addInput({ sourceTransaction: src, sourceOutputIndex: u.tx_pos, unlockingScriptTemplate: new P2PKH().unlock(priv) });
      got += u.value; if (got >= target) break;
    }
  }
  if (got < target) throw new Error(`wallet balance too low: have ${got}, need ${target} (${addr})`);

  const changeIndex = tx.outputs.length;
  tx.addOutput({ lockingScript: new P2PKH().lock(pub.toHash()), change: true });
  await tx.fee();
  await tx.sign();

  // commit tracker (the payment is about to be submitted by the resource server)
  for (const inp of tx.inputs) sess.spent.add((inp.sourceTransaction ? inp.sourceTransaction.id('hex') : inp.sourceTXID) + ':' + inp.sourceOutputIndex);
  sess.change = sess.change.filter((c) => !usedChange.includes(c));
  const chg = tx.outputs[changeIndex];
  if (chg && chg.satoshis > 0) sess.change.push({ tx, vout: changeIndex, satoshis: chg.satoshis });

  const envelope = {
    x402Version: body402.x402Version || 1,
    scheme: 'bsv-p2pkh',
    network: req.network,
    payload: { transaction: Utils.toHex(tx.toBEEF()), payer: addr },
  };
  return Buffer.from(JSON.stringify(envelope)).toString('base64');
}

// One-call paid fetch: run the request, auto-pay a 402 in BSV, return the final Response.
// `paymentBuilder` is injectable for testing; defaults to buildX402Payment.
export async function fetchWithX402(url, init = {}, { wif, wocBase, paymentBuilder } = {}) {
  const first = await fetch(url, init);
  if (first.status !== 402) return first;
  if (!wif) throw new Error('402 received but no `wif` provided to pay it');

  const body402 = await first.clone().json().catch(() => null);
  if (!body402) throw new Error('402 response was not JSON x402');
  const build = paymentBuilder || buildX402Payment;
  const xpayment = await build(body402, wif, { wocBase });

  const headers = Object.assign({}, init.headers || {}, { 'X-PAYMENT': xpayment });
  return fetch(url, Object.assign({}, init, { headers }));
}

// Decode the settlement result from a paid 200 response (the on-chain txid, etc.).
export function readSettlement(res) {
  const h = res.headers.get('x-payment-response');
  if (!h) return null;
  try { return JSON.parse(Buffer.from(h, 'base64').toString('utf8')); } catch { return null; }
}
