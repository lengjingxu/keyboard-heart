#!/usr/bin/env node
/**
 * kbctl — CLI client for the keyboard-heart service.
 *
 *   kbctl health | state
 *   kbctl fx <name>                 # success failure needInput notify processing heartbeat
 *   kbctl key Q=ff0000 A=00ff00 …   # set static per-key colors
 *   kbctl all 202020                # whole board one color
 *   kbctl side 00ff88 [brightness]  # side-bar color (+ optional 0-100)
 *   kbctl clear | off
 *   kbctl doctor                    # no server needed: probe HID directly
 */
const os = require('node:os');

const HOST = process.env.KB_HOST || '127.0.0.1';
const PORT = process.env.KB_PORT || '8791';
const BASE = `http://${HOST}:${PORT}`;

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || out.ok === false) {
    console.error(`✖ ${out.error || res.statusText}`);
    process.exit(1);
  }
  return out;
}

async function doctor() {
  const HID = require('node-hid');
  const { PROFILES } = require('../lib/grid');
  const known = Object.values(PROFILES);
  const list = HID.devices().filter(d =>
    known.some(p => p.vendorId === d.vendorId && p.productId === d.productId && p.interface === d.interface));
  if (!list.length) {
    console.error('✖ no supported keyboard found. Supported:');
    for (const p of known) console.error(`   ${p.name}  USB ${p.vendorId.toString(16)}:${p.productId.toString(16)} (HID interface ${p.interface})`);
    console.error('   Plug the board in via USB cable and retry. Note: 2.4G/BT dongles are not supported.');
    process.exit(1);
  }
  for (const d of list) {
    const p = known.find(p => p.vendorId === d.vendorId && p.productId === d.productId);
    console.log(`✔ ${p.name} found: ${d.product || '?'}  interface ${d.interface}  path ${d.path}`);
  }
  console.log('✔ node-hid OK, protocol lib loaded');
  console.log('Next: npm start  →  then kbctl fx success');
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'doctor') return doctor();
  if (!cmd) return console.error('usage: kbctl <fx|key|all|side|clear|off|state|health|doctor> [args]\n  KB_HOST/KB_PORT env to point at a remote service');
  switch (cmd) {
    case 'health': console.log(JSON.stringify(await call('GET', '/health'), null, 2)); break;
    case 'state': console.log(JSON.stringify(await call('GET', '/state'), null, 2)); break;
    case 'fx': {
      if (!args[0]) return console.error('usage: kbctl fx <success|failure|needInput|notify|processing|heartbeat>');
      // interactive CLI always takes over whatever is playing
      console.log(JSON.stringify(await call('POST', `/fx/${args[0]}`, { force: true })));
      break;
    }
    case 'key': {
      if (!args.length) return console.error('usage: kbctl key Q=ff0000 A=00ff00 …');
      const keys = {};
      for (const pair of args) {
        const [k, v] = pair.split('=');
        if (!k || !v) return console.error(`bad pair: ${pair} (expected Key=RRGGBB)`);
        keys[k] = v;
      }
      console.log(JSON.stringify(await call('POST', '/keys', { keys })));
      break;
    }
    case 'all': {
      if (!args[0]) return console.error('usage: kbctl all RRGGBB');
      console.log(JSON.stringify(await call('POST', '/keys', { all: args[0] })));
      break;
    }
    case 'side': {
      if (!args[0]) return console.error('usage: kbctl side RRGGBB [brightness0-100]');
      console.log(JSON.stringify(await call('POST', '/side', { color: args[0], brightness: args[1] ? Number(args[1]) : undefined })));
      break;
    }
    case 'clear': console.log(JSON.stringify(await call('POST', '/clear'))); break;
    case 'off': console.log(JSON.stringify(await call('POST', '/off'))); break;
    default:
      console.error(`unknown command: ${cmd}`);
      process.exit(1);
  }
}

main().catch(e => {
  if (e.cause && (e.cause.code === 'ECONNREFUSED')) {
    console.error(`✖ service not reachable at ${BASE} — run: npm start`);
  } else {
    console.error('✖', e.message);
  }
  process.exit(1);
});
