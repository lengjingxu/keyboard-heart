#!/usr/bin/env node
/**
 * CDP capture of WebHID traffic from the MCHOSE web console.
 * Launches a dedicated Chrome, injects a sendReport logger before page load,
 * polls window.__hidLog and appends everything to hid-capture.txt.
 *
 * Usage: node capture.js [chromePath]
 * Stop with Ctrl+C — the log file keeps everything.
 */
const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = 9333;
const USER_DIR = '/tmp/mchose-chrome-profile';
const URL_TARGET = 'https://www.mchose.com.cn/#/keyboard?deviceName=Ace+68+Air+2&isGoUpgradePage=false';
const LOG = '/tmp/hid-capture.txt';

const HOOK = `
(() => {
  window.__hidLog = window.__hidLog || [];
  const hex = (d) => {
    const u = (d instanceof ArrayBuffer) ? new Uint8Array(d) : new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
    return Array.from(u).map(b => b.toString(16).padStart(2, '0')).join(' ');
  };
  const stamp = () => (performance.now() / 1000).toFixed(2);
  if (window.HIDDevice) {
    const po = HIDDevice.prototype.sendReport;
    HIDDevice.prototype.sendReport = async function (reportId, data) {
      const line = 'TX ' + stamp() + ' id=' + reportId + ' [' + hex(data) + ']';
      window.__hidLog.push(line);
      return po.call(this, reportId, data);
    };
    const pf = HIDDevice.prototype.sendFeatureReport;
    if (pf) HIDDevice.prototype.sendFeatureReport = async function (reportId, data) {
      const line = 'FX ' + stamp() + ' id=' + reportId + ' [' + hex(data) + ']';
      window.__hidLog.push(line);
      return pf.call(this, reportId, data);
    };
    const pr = HIDDevice.prototype.open;
    HIDDevice.prototype.open = async function () {
      console.log('[capture] HID open:', this.productName, 'vendorId=' + this.vendorId, 'productId=' + this.productId);
      return pr.call(this);
    };
  } else {
    console.log('[capture] window.HIDDevice missing — WebHID unavailable');
  }
})();`;

function httpGet(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path }, res => {
      let b = '';
      res.on('data', c => { b += c; });
      res.on('end', () => resolve(JSON.parse(b)));
    }).on('error', reject);
  });
}

function httpPut(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path, method: 'PUT' }, res => {
      let b = '';
      res.on('data', c => { b += c; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(b); } });
    });
    req.on('error', reject);
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const chromePath = process.argv[2] || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  fs.writeFileSync(LOG, `capture started ${new Date().toISOString()}\n`);
  console.log('launching Chrome…');
  const chrome = spawn(chromePath, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${USER_DIR}`,
    '--no-first-run', '--no-default-browser-check', '--start-maximized',
    'about:blank',
  ], { stdio: 'ignore' });
  chrome.on('exit', c => console.log('chrome exited', c));

  // wait for devtools endpoint
  let ver = null;
  for (let i = 0; i < 40 && !ver; i++) {
    await sleep(500);
    try { ver = await httpGet('/json/version'); } catch {}
  }
  if (!ver) throw new Error('devtools endpoint never came up');
  console.log('devtools up:', ver.Browser);

  // fresh tab
  const target = await httpPut('/json/new?about:blank');
  const wsUrl = target.webSocketDebuggerUrl;
  console.log('tab created:', target.id);

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });

  let mid = 0;
  const pending = new Map();
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++mid;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  ws.on('message', raw => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  });

  await call('Page.enable');
  await call('Runtime.enable');
  await call('Page.addScriptToEvaluateOnNewDocument', { source: HOOK });

  // log the app's own console output (it logs every HID command it sends)
  const appLogs = [];
  ws.on('message', raw => {
    const msg = JSON.parse(raw);
    if (msg.method === 'Runtime.consoleAPICalled' && ['log', 'info', 'warning', 'error'].includes(msg.params.type)) {
      const text = msg.params.args.map(a => a.value !== undefined ? String(a.value) : (a.description || '')).join(' ');
      if (text && !/^\[capture\]/.test(text)) appLogs.push(`APP ${msg.params.timestamp % 100000} ${text}`);
    }
  });

  console.log('hook installed, navigating…');
  await call('Page.navigate', { url: URL_TARGET });

  const FRAME_PATCH = `
    (() => {
      let patched = 0;
      document.querySelectorAll('iframe').forEach(f => {
        try {
          const w = f.contentWindow;
          if (!w || !w.HIDDevice || w.__hidPatched) return;
          w.__hidPatched = true; patched++;
          const hex = (d) => {
            const u = (d instanceof ArrayBuffer) ? new Uint8Array(d) : new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
            return Array.from(u).map(b => b.toString(16).padStart(2, '0')).join(' ');
          };
          const po = w.HIDDevice.prototype.sendReport;
          w.HIDDevice.prototype.sendReport = function (id, data) {
            window.__hidLog.push('IF-TX ' + (performance.now() / 1000).toFixed(2) + ' id=' + id + ' [' + hex(data) + ']');
            return po.call(this, id, data);
          };
        } catch (e) {}
      });
      return patched;
    })()`;

  let cursor = 0;
  let logCursor = 0;
  const flush = async () => {
    try {
      await call('Runtime.evaluate', { expression: FRAME_PATCH, returnByValue: true });
    } catch {}
    const r = await call('Runtime.evaluate', {
      expression: 'JSON.stringify(window.__hidLog || [])',
      returnByValue: true,
    });
    const arr = JSON.parse(r.result.value);
    if (arr.length > cursor) {
      const fresh = arr.slice(cursor);
      cursor = arr.length;
      fs.appendFileSync(LOG, fresh.join('\n') + '\n');
      console.log(`+${fresh.length} reports (total ${cursor})`);
      if (cursor <= 30) fresh.forEach(l => console.log('   ', l.slice(0, 200)));
    }
    if (appLogs.length > logCursor) {
      const freshLogs = appLogs.slice(logCursor);
      logCursor = appLogs.length;
      fs.appendFileSync(LOG, freshLogs.map(l => l.replace(/\n/g, ' ')).join('\n') + '\n');
      const interesting = freshLogs.filter(l => /set|light|Light|cmd|send|Commands|mode|Mode|亮|灯/.test(l));
      interesting.slice(0, 8).forEach(l => console.log('   APP:', l.slice(0, 160)));
    }
  };

  console.log('\n>>> 现在请在 Chrome 窗口里：连接键盘 → 打开灯效设置 → 切到自定义/DIY → 涂两三个键 → 应用/保存');
  console.log('>>> 我在实时抓包，完成后回来告诉我即可\n');

  const poll = setInterval(flush, 1500);
  const shutdown = async () => {
    clearInterval(poll);
    try { await flush(); } catch {}
    try { await call('Runtime.evaluate', { expression: '1' }); } catch {}
    ws.close();
    chrome.kill();
    console.log('capture saved to', LOG);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  // keep flushing indefinitely
}

main().catch(e => { console.error('ERROR:', e); process.exit(1); });
