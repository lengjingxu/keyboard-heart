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

function issueDraft(HID) {
  // one-command GitHub issue draft for requesting/adding a device profile
  const { PROFILES, PROFILE_CANDIDATES } = require('../lib/grid');
  const skip = /apple|trackpad|mouse|receiver|sensor|hub|headset/i;
  const devices = HID.devices().filter(d =>
    d.product && !skip.test(d.product) && d.vendorId !== 0 && d.interface >= 0);
  const seen = new Set();
  const rows = devices
    .filter(d => { const k = `${d.vendorId}:${d.productId}:${d.interface}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .map(d => `| ${d.product} | \`${d.vendorId.toString(16)}:${d.productId.toString(16)}\` | ${d.interface} |`)
    .join('\n');
  const cands = Object.values(PROFILE_CANDIDATES)
    .map(c => `- ${c.name} (\`${c.id}\`)`)
    .join('\n');
  console.log(`
---- GitHub issue 草稿（复制到 https://github.com/lengjingxu/keyboard-heart/issues/new，选 Device support）----

### 设备支持请求 / Device support request

**键盘型号**：<!-- 填写，如 MCHOSE Ace 68 Pro -->
**连接方式**：USB 有线
**想贡献**：<!-- 拥有该键盘，愿意校准 | 只是请求，没有设备 -->

<details><summary>本机 HID 设备列表（kbctl doctor --issue 自动生成）</summary>

| product | VID:PID | HID interface |
|---|---|---|
${rows}

</details>

**候选 profile 认领**（如有你的型号，直接说"认领 <id>"并按指南校准）：
${cands || '- （暂无候选）'}

**已尝试**：
- [ ] \`npm run doctor\` 输出粘贴在上方
- [ ] \`node heart.js rainbow\` 彩虹校准照片（贡献 table 时必须）

参考：docs/CONTRIBUTING-PROFILES.md
---- 草稿结束 ----`);
}

async function doctor(issueFlag = false) {
  const HID = require('node-hid');
  const { PROFILES } = require('../lib/grid');
  const known = Object.values(PROFILES);
  const list = HID.devices().filter(d =>
    known.some(p => p.vendorId === d.vendorId && p.productId === d.productId && p.interface === d.interface));
  if (!list.length) {
    console.error('✖ no supported keyboard found. Supported:');
    for (const p of known) console.error(`   ${p.name}  USB ${p.vendorId.toString(16)}:${p.productId.toString(16)} (HID interface ${p.interface})`);
    console.error('   Plug the board in via USB cable and retry. Note: 2.4G/BT dongles are not supported.');
    if (issueFlag) issueDraft(HID);
    process.exit(1);
  }
  for (const d of list) {
    const p = known.find(p => p.vendorId === d.vendorId && p.productId === d.productId);
    const badge = p.verified ? '' : '  [unverified profile]';
    console.log(`✔ ${p.name}${badge} found: ${d.product || '?'}  interface ${d.interface}`);
  }
  const { PROFILE_CANDIDATES } = require('../lib/grid');
  const cands = Object.values(PROFILE_CANDIDATES);
  if (cands.length) {
    console.log(`ℹ ${cands.length} candidate profiles await real-device confirmation:`);
    for (const c of cands) console.log(`   · ${c.name} (${c.id}) — needs PID + calibration`);
    console.log('   see docs/CONTRIBUTING-PROFILES.md to adopt one');
  }
  console.log('✔ node-hid OK, protocol lib loaded');
  console.log('Next: npm start  →  then kbctl fx success');
  if (issueFlag) issueDraft(HID);
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'doctor') return doctor(process.argv.includes('--issue'));
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
