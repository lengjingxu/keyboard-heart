#!/usr/bin/env node
/**
 * keyboard-heart service: local HTTP + WebSocket control for keyboard RGB.
 *
 *   node server.js            # listens on 127.0.0.1:8791
 *   KB_PORT=9000 node server.js
 *
 * REST:  POST /fx/:name   POST /keys   POST /side   POST /clear   POST /off
 *        GET  /state      GET  /health
 * WS:    ws://127.0.0.1:8791/stream — push {op:"frame", keys|all|grid|side} JSON frames
 */
const http = require('http');
const { WebSocketServer } = require('ws');
const { Scheduler } = require('./lib/scheduler');

const PORT = parseInt(process.env.KB_PORT || '8791');
const HOST = process.env.KB_HOST || '127.0.0.1';

const scheduler = new Scheduler({
  onStateChange: (state, profile) => console.log(`[device] ${state}${profile ? ' ' + profile.name : ''}`),
});
scheduler.start();

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      return res.end();
    }

    if (req.method === 'GET' && (path === '/health' || path === '/')) return send(res, 200, scheduler.health());
    if (req.method === 'GET' && path === '/state') {
      return send(res, 200, { ...scheduler.health(), staticKeysHint: 'POST /keys to change; WS /stream for raw frames' });
    }

    if (req.method === 'POST' && path.startsWith('/fx/')) {
      const name = path.slice(4);
      const body = await readBody(req).catch(() => ({}));
      const result = scheduler.play(name, body);
      return send(res, result.ok ? 200 : 400, result);
    }

    if (req.method === 'POST' && path === '/keys') {
      const body = await readBody(req);
      const result = scheduler.setKeys(body);
      return send(res, result.ok ? 200 : 400, result);
    }

    if (req.method === 'POST' && path === '/side') {
      const body = await readBody(req);
      const result = scheduler.setSide(body);
      return send(res, result.ok ? 200 : 400, result);
    }

    if (req.method === 'POST' && path === '/clear') {
      scheduler.stopAnimation();
      return send(res, 200, scheduler.clearKeys());
    }

    if (req.method === 'POST' && path === '/off') {
      scheduler.stopAnimation();
      scheduler.clearKeys();
      const r = scheduler.setSide({ color: '#000000', brightness: 0 });
      return send(res, r.ok ? 200 : 400, { ok: true, note: 'keys off, side off' });
    }

    send(res, 404, { ok: false, error: `no route: ${req.method} ${path}` });
  } catch (e) {
    send(res, 400, { ok: false, error: e.message });
  }
});

// WS raw-frame channel: clients push frames at their own pace; they merge
// into the static buffer so the 20fps scheduler keeps the picture alive.
const wss = new WebSocketServer({ server, path: '/stream' });
wss.on('connection', (ws, req) => {
  // localhost only
  const addr = req.socket.remoteAddress;
  if (addr !== '127.0.0.1' && addr !== '::1' && addr !== '::ffff:127.0.0.1') {
    ws.close(1008, 'local only');
    return;
  }
  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return ws.send(JSON.stringify({ ok: false, error: 'bad json' })); }
    try {
      if (msg.op === 'frame' || msg.op === 'keys') {
        const r = scheduler.setKeys(msg);
        ws.send(JSON.stringify(r));
      } else if (msg.op === 'side') {
        ws.send(JSON.stringify(scheduler.setSide(msg)));
      } else if (msg.op === 'clear') {
        scheduler.stopAnimation();
        ws.send(JSON.stringify(scheduler.clearKeys()));
      } else if (msg.op === 'fx') {
        ws.send(JSON.stringify(scheduler.play(msg.name)));
      } else if (msg.op === 'health') {
        ws.send(JSON.stringify(scheduler.health()));
      } else {
        ws.send(JSON.stringify({ ok: false, error: `unknown op: ${msg.op}` }));
      }
    } catch (e) {
      ws.send(JSON.stringify({ ok: false, error: e.message }));
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`keyboard-heart listening on http://${HOST}:${PORT}`);
  console.log(`  REST : POST /fx/success /fx/failure /fx/needInput /fx/notify /fx/processing /fx/heartbeat`);
  console.log(`         POST /keys /side /clear /off   GET /health /state`);
  console.log(`  WS   : ws://${HOST}:${PORT}/stream`);
});
