'use strict';
/**
 * PS5 直播小助手 —— 本地引擎（无界面）
 *
 * 由客户端 exe 启动，负责四件事：
 *   1) 内置 DNS：把老鼠台的推流域名劫持到本机
 *   2) 管理 mediamtx：接收 PS5 的 RTMP 推流并转 HLS
 *   3) 把 HLS 代理成固定地址 /live.m3u8（流名每次随机也不影响观看端）
 *   4) 给客户端提供 HTTP API 和页面（状态、播放地址、问答助手）
 *
 * 打包成单文件时，mediamtx.exe / 配置 / 页面都内嵌在 exe 里，
 * 运行时释放到 %LOCALAPPDATA%\PS5Live。
 */
const http = require('http');
const fs = require('fs');
const net = require('net');
const dgram = require('dgram');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const osDns = require('dns');
const { spawn, execFile } = require('child_process');

/* -------------------------------- 运行环境 -------------------------------- */
const sea = (() => { try { return require('node:sea'); } catch (_) { return null; } })();
const IS_SEA = !!(sea && typeof sea.isSea === 'function' && sea.isSea());
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

function defaultStateDir() {
  if (!IS_SEA) return path.resolve(__dirname, '..');
  if (IS_WIN) return path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'PS5Live');
  // macOS：安装后后台守护进程以 root 运行，状态放系统目录；直接运行时退回用户目录
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  if (IS_MAC && isRoot) return '/Library/Application Support/PS5Live';
  return path.join(os.homedir(), 'Library', 'Application Support', 'PS5Live');
}
const STATE_DIR = process.env.PS5LIVE_HOME || defaultStateDir();

function seaAssetText(name) {
  return Buffer.from(sea.getAsset(name)).toString('utf8');
}

function sameBytes(buf, p) {
  const a = crypto.createHash('sha256').update(buf).digest('hex');
  const b = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  return a === b;
}

/** 单文件版：把内嵌资源释放到可写目录；配置只在缺失时写入，保留用户改动 */
function extractRuntime() {
  if (!IS_SEA) return;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const mtx = path.join(STATE_DIR, IS_WIN ? 'mediamtx.exe' : 'mediamtx');
  const want = Buffer.from(sea.getAsset(IS_WIN ? 'mediamtx.exe' : 'mediamtx'));
  let need = true;
  try { need = !sameBytes(want, mtx); } catch (_) { need = true; }
  if (need) {
    const tmp = mtx + '.tmp';
    fs.writeFileSync(tmp, want);
    try { fs.unlinkSync(mtx); } catch (_) { /* ignore */ }
    fs.renameSync(tmp, mtx);
    if (!IS_WIN) { try { fs.chmodSync(mtx, 0o755); } catch (_) { /* ignore */ } }
  }
  for (const name of ['mediamtx.yml', 'config.json', 'dnsmasq.conf']) {
    const p = path.join(STATE_DIR, name);
    try { fs.accessSync(p); } catch (_) { fs.writeFileSync(p, seaAssetText(name)); }
  }
}
extractRuntime();

/* --------------------------------- 配置 ----------------------------------- */
let FILE_CFG = {};
try {
  FILE_CFG = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'config.json'), 'utf8'));
} catch (_) { FILE_CFG = {}; }

function cfgStr(name, dflt) {
  const env = process.env[name];
  if (env !== undefined && env !== '') return String(env);
  const v = FILE_CFG[name];
  if (v !== undefined && v !== null && v !== '') return String(v);
  return dflt;
}
function cfgInt(name, dflt) {
  const n = parseInt(cfgStr(name, ''), 10);
  return Number.isFinite(n) ? n : dflt;
}
const cfgPath = (name, dflt) => {
  const v = cfgStr(name, dflt);
  if (!v) return '';
  return path.isAbsolute(v) ? v : path.resolve(STATE_DIR, v);
};

const PORT = cfgInt('PORT', 8088);
const CONF = cfgPath('DNSMASQ_CONF', path.join(STATE_DIR, 'dnsmasq.conf'));
const LOG_FILE = cfgPath('LOG_FILE', path.join(STATE_DIR, 'panel.log'));
const STAT_URL = cfgStr('STAT_URL', 'http://127.0.0.1:9997/v3/paths/list');
const HLS_PLAYLIST = cfgStr('HLS_PLAYLIST', 'http://127.0.0.1:8000/{path}/index.m3u8');
const RTMP_PORT = cfgInt('RTMP_PORT', 1935);
const DNS_PORT = cfgInt('DNS_PORT', 53);
const LOCAL_IP_DETECT = /^(1|true|yes|on)$/i.test(cfgStr('LOCAL_IP_DETECT', '1'));
const MEDIAMTX_EXE = cfgPath('MEDIAMTX_EXE', path.join(STATE_DIR, IS_WIN ? 'mediamtx.exe' : 'mediamtx'));
const MEDIAMTX_CONF = cfgPath('MEDIAMTX_CONF', path.join(STATE_DIR, 'mediamtx.yml'));
const CLIENT_EXE = (process.env.PS5LIVE_CLIENT || '').trim();
const AI_KEY = (process.env.OPENAI_API_KEY || '').trim();
const AI_BASE = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
const AI_MODEL = cfgStr('OPENAI_MODEL', 'gpt-4o-mini');
const DEFAULT_DOMAINS = ['contribute.live-video.net', 'live-video.net'];

// Twitch 控制面（API/登录）走本机 443 → Clash 代理，PS5 上不用填代理
let PROXY_ENABLE = cfgStr('PROXY_ENABLE', 'auto'); // auto | 1 | 0
let PROXY_ADDR_CFG = cfgStr('PROXY_ADDR', '');
const PROXY_CANDIDATES = ['127.0.0.1:7897', '127.0.0.1:7890', '127.0.0.1:7891', '127.0.0.1:1080', '127.0.0.1:10808'];
let PROXY_ADDR = PROXY_ADDR_CFG;
const PROXY_PORT = cfgInt('PROXY_PORT', 443);
const PROXY_SUFFIXES = cfgStr('PROXY_SUFFIXES', '.twitch.tv,twitch.tv')
  .split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);

try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); } catch (_) { /* ignore */ }

function log(msg) {
  const line = `[engine] ${new Date().toISOString()} ${msg}\n`;
  try { process.stdout.write(line); } catch (_) { /* ignore */ }
  try { fs.appendFileSync(LOG_FILE, line); } catch (_) { /* ignore */ }
}

/* ------------------------------ 劫持配置 ---------------------------------- */
function readConf() {
  try { return fs.readFileSync(CONF, 'utf8'); } catch (_) { return ''; }
}
function confIp() {
  const m = readConf().match(/^\s*address=\/[^/]+\/(\d{1,3}(?:\.\d{1,3}){3})/m);
  return m ? m[1] : '';
}
function confDomains() {
  const ds = [...readConf().matchAll(/^\s*address=\/([^/]+)\//gm)].map((m) => m[1]);
  return ds.length ? ds : DEFAULT_DOMAINS;
}
function writeConfIp(ip) {
  const txt = readConf();
  if (!/^\s*address=\//m.test(txt)) throw new Error('配置里没有 address= 劫持规则');
  fs.writeFileSync(CONF, txt.replace(/^(\s*address=\/[^/]+\/)\d{1,3}(?:\.\d{1,3}){3}/gm, (_, p) => p + ip), 'utf8');
}

const isLanIp = (ip) =>
  /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);

function localIps() {
  const out = [];
  const ifaces = os.networkInterfaces() || {};
  for (const name of Object.keys(ifaces)) {
    for (const a of ifaces[name] || []) {
      if (a && !a.internal && a.family === 'IPv4') out.push({ name, ip: a.address });
    }
  }
  return out;
}

let netCache = { at: 0, ip: '', gw: '' };
let netPending = false;
function refreshNet() {
  if (!LOCAL_IP_DETECT || netPending) return;
  if (netCache.at && Date.now() - netCache.at < 4 * 60000) return;
  netPending = true;
  if (IS_MAC) {
    const script = [
      'ifc=$(route -n get default 2>/dev/null | awk \'/interface:/{print $2}\')',
      'gw=$(route -n get default 2>/dev/null | awk \'/gateway:/{print $2}\')',
      'ip=$(ipconfig getifaddr "$ifc" 2>/dev/null)',
      'printf "%s|%s\\n" "$ip" "$gw"',
    ].join('; ');
    execFile('/bin/sh', ['-c', script], { encoding: 'utf8', timeout: 20000 }, (err, stdout) => {
      netPending = false;
      netCache.at = Date.now();
      if (err || !stdout) return;
      const parts = String(stdout).trim().split('|');
      const ip = (parts[0] || '').trim();
      const gw = (parts[1] || '').trim();
      if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) netCache.ip = ip;
      if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(gw)) netCache.gw = gw;
    });
    return;
  }
  const ps = [
    '$r = Get-NetRoute -DestinationPrefix 0.0.0.0/0 -ErrorAction SilentlyContinue | Sort-Object RouteMetric | Select-Object -First 1;',
    'if ($r) { $a = (Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $r.InterfaceIndex -ErrorAction SilentlyContinue | Select-Object -First 1).IPAddress;',
    'Write-Output ($a + "|" + $r.NextHop) }',
  ].join(' ');
  execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf8',
    timeout: 20000,
    windowsHide: true,
  }, (err, stdout) => {
    netPending = false;
    netCache.at = Date.now();
    if (err || !stdout) return;
    const parts = String(stdout).trim().split('|');
    const ip = (parts[0] || '').trim();
    const gw = (parts[1] || '').trim();
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) netCache.ip = ip;
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(gw)) netCache.gw = gw;
  });
}

function netInfo() {
  refreshNet();
  return netCache;
}

/** 优先用「有默认网关那块网卡」的 IP，其次按网关网段挑，最后取第一个私有地址 */
function detectIp() {
  if (!LOCAL_IP_DETECT) return '';
  const net = netInfo();
  if (net.ip && isLanIp(net.ip)) return net.ip;
  const ips = localIps();
  if (!ips.length) return '';
  const sub = (net.gw || confUpstream()).split('.').slice(0, 3).join('.') + '.';
  const same = ips.find((x) => x.ip.startsWith(sub));
  if (same) return same.ip;
  const priv = ips.filter((x) => isLanIp(x.ip));
  return (priv[0] || ips[0]).ip;
}

function confUpstream() {
  const m = readConf().match(/^\s*server=(\d{1,3}(?:\.\d{1,3}){3})/m);
  if (m) return m[1];
  const sys = osDns.getServers().map((x) => String(x).replace(/^::ffff:/, '')).find((x) => isLanIp(x));
  if (sys) return sys;
  return netInfo().gw || '223.5.5.5';
}

function requestIp() {
  const det = detectIp();
  if (det) return det;
  return confIp() || '127.0.0.1';
}

/* -------------------------------- 流状态 --------------------------------- */
function emptyStream() {
  return { live: false, name: '', path: '', time: 0, clients: 0, bwIn: 0, video: null, audio: null };
}

const bwSamples = new Map();
let hlsProbe = { name: '', width: 0, height: 0, fps: null, at: 0 };

function parseMediamtxStream(json) {
  let items = [];
  try { items = (JSON.parse(json).items || []); } catch (_) { return emptyStream(); }
  const online = (i) => i && (i.online === true || i.ready === true);
  const it = items.find((i) => online(i) && (!i.source || i.source.type === 'rtmpConn'));
  if (!it) { bwSamples.clear(); return emptyStream(); }
  const p = String(it.name || '');
  const name = p.split('/').pop();
  const tracks2 = it.tracks2 || [];
  const v = tracks2.find((t) => /H264|H265|HEVC|AV1|VP9/i.test(t.codec || ''));
  const a = tracks2.find((t) => /Audio|AAC|Opus|MPEG/i.test(t.codec || ''));
  const bytes = Number(it.inboundBytes || it.bytesReceived || 0);
  const now = Date.now();
  const prev = bwSamples.get(p);
  bwSamples.set(p, { bytes, at: now });
  const bw = prev && now > prev.at ? Math.max(0, Math.round((bytes - prev.bytes) / ((now - prev.at) / 1000))) : 0;
  let video = null;
  if (v && v.codecProps && v.codecProps.width) {
    video = { width: v.codecProps.width, height: v.codecProps.height, fps: null, codec: v.codec };
  } else if (hlsProbe.name === p && hlsProbe.width) {
    video = { width: hlsProbe.width, height: hlsProbe.height, fps: hlsProbe.fps, codec: 'H264' };
  }
  return {
    live: true,
    name,
    path: p,
    time: it.onlineTime ? Math.max(0, Math.round((now - Date.parse(it.onlineTime)) / 1000)) : 0,
    clients: (it.readers || []).filter((r) => r && r.type !== 'hlsMuxer').length,
    bwIn: bw,
    video,
    audio: a ? { codec: a.codec } : null,
  };
}

/* ------------------------------- DNS 服务 --------------------------------- */
function readName(buf, off) {
  const labels = [];
  let jumped = false;
  let end = off;
  let guard = 0;
  while (off < buf.length && guard++ < 64) {
    const len = buf[off];
    if (len === 0) { if (!jumped) end = off + 1; return { name: labels.join('.'), end }; }
    if ((len & 0xc0) === 0xc0) {
      if (!jumped) end = off + 2;
      off = ((len & 0x3f) << 8) | buf[off + 1];
      jumped = true;
      continue;
    }
    labels.push(buf.slice(off + 1, off + 1 + len).toString('latin1'));
    off += 1 + len;
  }
  return { name: labels.join('.'), end };
}

function dnsPacket(name) {
  const labels = name.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l, 'latin1')]));
  return Buffer.concat([
    Buffer.from([0x12, 0x34, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    ...labels,
    Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01]),
  ]);
}

function parseAnswers(buf) {
  if (buf.length < 12) return [];
  const count = buf.readUInt16BE(6);
  let off = 12;
  const skip = () => { off = readName(buf, off).end; };
  skip();
  off += 4;
  const ips = [];
  for (let i = 0; i < count && off + 10 <= buf.length; i++) {
    skip();
    if (off + 10 > buf.length) break;
    const type = buf.readUInt16BE(off);
    const rdlen = buf.readUInt16BE(off + 8);
    off += 10;
    if (type === 1 && rdlen === 4 && off + 4 <= buf.length) {
      ips.push(`${buf[off]}.${buf[off + 1]}.${buf[off + 2]}.${buf[off + 3]}`);
    }
    off += rdlen;
  }
  return ips;
}

function udpQuery(host, port, packet, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    const timer = setTimeout(() => { try { sock.close(); } catch (_) {} reject(new Error('DNS 超时')); }, timeoutMs);
    sock.on('error', (e) => { clearTimeout(timer); try { sock.close(); } catch (_) {} reject(e); });
    sock.on('message', (msg) => { clearTimeout(timer); try { sock.close(); } catch (_) {} resolve(msg); });
    sock.send(packet, port, host);
  });
}

async function dnsCheck(expectIp) {
  if (!expectIp) return { ok: false, ips: [], error: '没有配置劫持 IP' };
  const name = confDomains()[0];
  try {
    const res = await udpQuery('127.0.0.1', DNS_PORT, dnsPacket(name));
    const ips = parseAnswers(res);
    return { ok: ips.includes(expectIp), ips, error: ips.length ? '' : '无 A 记录' };
  } catch (e) {
    return { ok: false, ips: [], error: String(e.message || e) };
  }
}

function buildReply(query, qType, qEnd, ip) {
  const question = query.slice(12, qEnd);
  const answer = ip && qType === 1
    ? Buffer.concat([
      Buffer.from([0xc0, 0x0c]),
      Buffer.from([0x00, 0x01, 0x00, 0x01]),
      Buffer.from([0x00, 0x00, 0x00, 0x1e]),
      Buffer.from([0x00, 0x04]),
      Buffer.from(ip.split('.').map(Number)),
    ])
    : Buffer.alloc(0);
  return Buffer.concat([
    query.slice(0, 2),
    Buffer.from([0x81, 0x80]),
    Buffer.from([0x00, 0x01]),
    Buffer.from([0x00, answer.length ? 0x01 : 0x00]),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
    question,
    answer,
  ]);
}

let dnsBindError = '';
let dnsBound = false;

function startEmbeddedDns() {
  const sock = dgram.createSocket('udp4');
  sock.on('error', (e) => {
    dnsBound = false;
    dnsBindError = e.code === 'EADDRINUSE'
      ? (IS_MAC
        ? `端口 ${DNS_PORT} 被占用（macOS 需要以 root 运行才能监听 53；请用安装程序装成后台服务）`
        : `端口 ${DNS_PORT} 被占用（常见原因：Windows「网络共享/移动热点」占着 53）`)
      : String(e.message || e);
    log('DNS 监听失败: ' + dnsBindError + '，5 秒后重试');
    try { sock.close(); } catch (_) { /* ignore */ }
    setTimeout(startEmbeddedDns, 5000);
  });
  sock.on('message', async (msg, rinfo) => {
    if (msg.length < 12) return;
    const q = readName(msg, 12);
    const qType = msg.readUInt16BE(q.end);
    const qClass = msg.readUInt16BE(q.end + 2);
    const qEnd = q.end + 4;
    const name = q.name.toLowerCase();
    const hijack = confIp();
    const hit = hijack && qClass === 1
      && (confDomains().some((d) => name === d.toLowerCase() || name.endsWith('.' + d.toLowerCase()))
        || proxyHit(name));
    try {
      if (hit) {
        sock.send(buildReply(msg, qType, qEnd, hijack), rinfo.port, rinfo.address);
      } else {
        const resp = await udpQuery(confUpstream(), 53, msg, 2500);
        sock.send(resp, rinfo.port, rinfo.address);
      }
    } catch (_) { /* 上游超时就静默，让客户端重试 */ }
  });
  sock.bind(DNS_PORT, '0.0.0.0', () => {
    dnsBound = true;
    dnsBindError = '';
    log(`DNS 已启动 :${DNS_PORT}，上游 ${confUpstream()}`);
  });
}

/* ------------------------- Twitch 控制面代理 ------------------------------ */
let proxyEnabled = false;
let proxyServer = null;
let proxyError = '';

function proxyHit(name) {
  if (!proxyEnabled) return false;
  const n = String(name || '').toLowerCase();
  return PROXY_SUFFIXES.some((sfx) => (sfx.startsWith('.') ? n.endsWith(sfx) : n === sfx));
}

function tcpProbe(host, port, ms = 800) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(ms, () => done(false));
    sock.on('connect', () => done(true));
    sock.on('error', () => done(false));
  });
}

/** 从 TLS ClientHello 里取 SNI */
function parseSni(buf) {
  try {
    if (buf.length < 6 || buf[0] !== 0x16 || buf[5] !== 0x01) return '';
    let p = 9; // record(5) + handshake type(1) + length(3)
    if (p + 2 + 32 > buf.length) return '';
    p += 2 + 32;
    const sid = buf[p]; p += 1 + sid;
    if (p + 2 > buf.length) return '';
    const cs = buf.readUInt16BE(p); p += 2 + cs;
    if (p + 1 > buf.length) return '';
    const cm = buf[p]; p += 1 + cm;
    if (p + 2 > buf.length) return '';
    const extTotal = buf.readUInt16BE(p); p += 2;
    const end = Math.min(p + extTotal, buf.length);
    while (p + 4 <= end) {
      const type = buf.readUInt16BE(p);
      const len = buf.readUInt16BE(p + 2);
      p += 4;
      if (type === 0 && p + 5 <= buf.length) {
        let q = p + 2; // server_name_list 长度
        const nameType = buf[q]; q += 1;
        if (nameType === 0) {
          const nlen = buf.readUInt16BE(q); q += 2;
          if (q + nlen <= buf.length) return buf.slice(q, q + nlen).toString('latin1');
        }
      }
      p += len;
    }
  } catch (_) { /* ignore */ }
  return '';
}

function openTunnel(client, initial, sni) {
  const idx = PROXY_ADDR.lastIndexOf(':');
  const host = PROXY_ADDR.slice(0, idx) || '127.0.0.1';
  const port = parseInt(PROXY_ADDR.slice(idx + 1), 10) || 7890;
  const up = net.connect({ host, port });
  const kill = () => {
    try { up.destroy(); } catch (_) { /* ignore */ }
    try { client.destroy(); } catch (_) { /* ignore */ }
  };
  up.setTimeout(10000, kill);
  up.on('error', kill);
  up.on('connect', () => up.write(`CONNECT ${sni}:443 HTTP/1.1\r\nHost: ${sni}:443\r\nProxy-Connection: keep-alive\r\n\r\n`));
  let head = Buffer.alloc(0);
  const onHead = (chunk) => {
    head = Buffer.concat([head, chunk]);
    const sep = head.indexOf('\r\n\r\n');
    if (sep < 0) { if (head.length > 8192) kill(); return; }
    up.removeListener('data', onHead);
    const status = head.slice(0, sep).toString('latin1').split('\r\n')[0];
    if (!/\s200\s/.test(status)) {
      log(`Twitch 代理拒绝：${sni} ${status}`);
      return kill();
    }
    up.setTimeout(0);
    up.write(initial);
    const rest = head.slice(sep + 4);
    if (rest.length) client.write(rest);
    client.setTimeout(0);
    client.pipe(up);
    up.pipe(client);
  };
  up.on('data', onHead);
}

function handleProxyConn(client) {
  let buf = Buffer.alloc(0);
  const fail = () => {
    try { client.destroy(); } catch (_) { /* ignore */ }
  };
  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (buf.length > 16384) return fail();
    const sni = parseSni(buf);
    if (!sni) {
      if (buf.length >= 6 && buf[0] === 0x16 && buf[5] === 0x01) return; // 还没收全
      return fail();
    }
    client.removeListener('data', onData);
    client.setTimeout(0);
    log(`Twitch 代理转发：${sni}`);
    openTunnel(client, buf, sni);
  };
  client.on('error', fail);
  client.setTimeout(10000, fail);
  client.on('data', onData);
}

function startProxyServer() {
  if (proxyServer) return;
  proxyServer = net.createServer(handleProxyConn);
  proxyServer.on('error', (e) => {
    proxyError = e.code === 'EADDRINUSE' ? '本机 443 端口被占用' : String(e.message || e);
    log('Twitch 代理监听失败: ' + proxyError);
    proxyServer = null;
  });
  proxyServer.listen(PROXY_PORT, '0.0.0.0', () => { proxyError = ''; log(`Twitch 代理已启动 :${PROXY_PORT} → ${PROXY_ADDR}`); });
}

function saveProxyCfg(addr, enable) {
  const p = path.join(STATE_DIR, 'config.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { /* 新建 */ }
  cfg.PROXY_ADDR = addr;
  cfg.PROXY_ENABLE = enable;
  try { fs.writeFileSync(p, JSON.stringify(cfg, null, 2)); } catch (e) { log('保存代理配置失败: ' + e.message); }
}

async function applyProxy(addr, enable) {
  PROXY_ENABLE = enable;
  PROXY_ADDR_CFG = addr;
  PROXY_ADDR = addr;
  if (proxyServer) { try { proxyServer.close(); } catch (_) { /* ignore */ } proxyServer = null; }
  proxyEnabled = false;
  proxyError = '';
  if (enable === '0') return { enabled: false, addr: '', error: '' };
  await ensureProxy();
  return { enabled: proxyEnabled, addr: PROXY_ADDR, error: proxyError };
}

async function ensureProxy() {
  if (PROXY_ENABLE === '0') return;
  if (proxyEnabled) return;
  const cands = PROXY_ADDR_CFG ? [PROXY_ADDR_CFG] : PROXY_CANDIDATES;
  for (const addr of cands) {
    const idx = addr.lastIndexOf(':');
    const host = addr.slice(0, idx) || '127.0.0.1';
    const port = parseInt(addr.slice(idx + 1), 10) || 7890;
    if (await tcpProbe(host, port)) {
      PROXY_ADDR = addr;
      proxyEnabled = true;
      startProxyServer();
      log('检测到本地代理 ' + addr + '，Twitch 访问走本机代理');
      return;
    }
  }
}

/* ------------------------------ mediamtx --------------------------------- */
let media = null;
function startMedia() {
  if (!MEDIAMTX_EXE) return;
  try {
    media = spawn(MEDIAMTX_EXE, [MEDIAMTX_CONF], { windowsHide: true, stdio: 'ignore' });
  } catch (e) {
    log('mediamtx 启动失败: ' + e.message);
    return;
  }
  media.on('error', (e) => {
    media = null;
    log('mediamtx 启动失败: ' + (e && e.message ? e.message : e));
  });
  media.on('exit', (code) => {
    media = null;
    log(`mediamtx 退出 (code=${code})，2 秒后重启`);
    if (!fs.existsSync(MEDIAMTX_EXE)) return; // 二进制都不在，别无限重试
    setTimeout(startMedia, 2000);
  });
}
function stopMedia() {
  if (media) { try { media.kill(); } catch (_) { /* ignore */ } media = null; }
}

/* -------------------------------- 状态 ------------------------------------ */
let cache = { at: 0, value: null };
let liveSince = 0;
let lastLiveAt = 0;

async function getStatus() {
  if (cache.value && Date.now() - cache.at < 1000) return cache.value;
  const configuredIp = confIp();
  let body = '';
  let statError = '';
  try {
    const r = await fetch(STAT_URL, { signal: AbortSignal.timeout(2500) });
    body = await r.text();
  } catch (e) {
    statError = String(e.message || e);
  }
  const stream = parseMediamtxStream(body);
  if (stream.live) {
    if (!liveSince) liveSince = Date.now();
    lastLiveAt = Date.now();
  } else {
    liveSince = 0;
  }
  if (stream.live && !stream.time && liveSince) stream.time = Math.round((Date.now() - liveSince) / 1000);
  const [rtmpOk, dns] = await Promise.all([tcpCheck('127.0.0.1', RTMP_PORT), dnsCheck(configuredIp)]);
  const value = { configuredIp, domains: confDomains(), stream, rtmpOk, dns, statError, liveSince, lastLiveAt };
  cache = { at: Date.now(), value };
  return value;
}

function tcpCheck(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeoutMs, () => done(false));
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
}

function fillTemplate(tpl, vars) {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => (vars[k] === undefined ? '' : String(vars[k])));
}

function urls(ip, stream) {
  const name = stream && stream.live ? stream.name : '';
  return {
    hls: `http://${ip}:${PORT}/live.m3u8`,
    rtmp: name ? `rtmp://${ip}${RTMP_PORT === 1935 ? '' : ':' + RTMP_PORT}/app/${name}` : '',
    player: `http://${ip}:${PORT}/`,
  };
}

/* --------------------------------- 助手 ----------------------------------- */
function localAnswer(q, ctx) {
  const s = ctx.stream;
  const ip = ctx.ip;
  const liveLine = s.live
    ? `现在 PS5 正在推流：${s.video ? `${s.video.width}×${s.video.height}` : '画面'}，已经播了 ${Math.floor(s.time / 60)} 分 ${s.time % 60} 秒。`
    : '现在还没有检测到 PS5 的直播流（先让 PS5 开始直播，再来看）。';
  const host = `OBS 用这个地址：${ctx.urls.hls}（媒体源 → 输入 → 填这个网址，勾"重新连接"）。`;
  const dnsLine = `PS5 → 设置 → 网络 → 设定互联网连接 → 选你的 Wi-Fi → 详细设定 → DNS 设置 → 手动 → 主 DNS 填 ${ip}（备用可以留空或填 114.114.114.114）。`;

  const sets = [
    { k: ['dns', '域名', '劫持', '解析'], a: `主 DNS 填 ${ip}。\n${dnsLine}\n填完在 PS5 里"测试互联网连接"，能连上就行。改完记得保存，然后重开一次 PS5 的直播。` },
    { k: ['没画面', '黑屏', '无信号', '看不到', '不出图', '连不上', '打不开'], a: `按顺序排查：\n1. ${liveLine}\n2. ${host}\n3. OBS 里媒体源的"重新连接"要勾上，不然 PS5 一开播它不会自己接。\n4. 看窗口底部的自检：DNS 劫持、RTMP 端口两项都要正常。` },
    { k: ['obs', '观看', '媒体源', 'vlc', '推流地址'], a: `${host}\n\n要更低延迟（约 1-2 秒）可以用 VLC 源：${s.live ? `rtmp://${ip}/app/${s.name}` : '需要 PS5 先开播，界面会自动填出完整地址'}。\nHLS 地址固定不变，PS5 每次的流名变化都不影响。` },
    { k: ['卡顿', '延迟', '缓冲', '花屏', '掉帧'], a: `HLS 天生有 5-10 秒延迟，这是正常的。想更跟手：\n1. OBS 用 VLC 源 + rtmp 地址（约 1-2 秒）。\n2. PS5 和这台电脑最好都插网线，Wi-Fi 掉帧最明显。\n3. ${liveLine}` },
    { k: ['ip', '变了', '换网', '路由器'], a: `现在应该填的 IP 是 ${ip}，配置里写的是 ${ctx.configuredIp}。\n不一致时点界面上的"修正 DNS 指向"，然后 PS5 里 DNS 也要改成 ${ip}。\n一劳永逸：在路由器里给这台电脑绑定固定 IP。` },
    { k: ['开始', '开播', '怎么直播'], a: `顺序：\n1. PS5 把 DNS 设成 ${ip}。\n2. PS5 打开要直播的游戏，按 Share → 直播 → Twitch，按它自己的流程开播。\n3. 本窗口状态变成"正在直播"就说明接住了。\n4. OBS 里加媒体源：${ctx.urls.hls}。\n不需要采集卡。` },
    { k: ['原理', '为什么', '是什么', '怎么工作'], a: `链路：PS5 推流到老鼠台域名（contribute.live-video.net）→ 被本机 DNS 劫持到 ${ip} → 本机接流并转成 HLS → OBS / 浏览器播放。\n所以 PS5 的 DNS 必须指向这台电脑。` },
    { k: ['手机', '平板', '电视', '浏览器'], a: `同一局域网里，浏览器打开 ${ctx.urls.player} 就能看。\n要给外人看要另做内网穿透，现在只在内网。` },
    { k: ['声音', '音频'], a: `声音跟着流一起走，HLS 里有 AAC 音轨。预览窗口点喇叭图标打开声音（自动播放默认静音）。OBS 媒体源会带声音。` },
    { k: ['状态', '现在', '检测', '正常'], a: `${liveLine}\nDNS 劫持：${ctx.dns.ok ? '正常' : `异常（${ctx.dns.error || '解析结果不对'}）`}\nRTMP 端口：${ctx.rtmpOk ? '通' : '不通'}\n给 PS5 的 DNS：${ip}` },
  ];
  const text = String(q || '').toLowerCase();
  for (const item of sets) {
    if (item.k.some((k) => text.includes(k))) return { text: item.a, source: 'local' };
  }
  return {
    text: `我能回答：\n· PS5 的 DNS 怎么填\n· OBS 怎么加播放地址\n· 没画面 / 黑屏排查\n· 卡顿、延迟、声音\n· IP 变了怎么办\n\n当前：${liveLine}\n给 PS5 的 DNS：${ip}\nOBS 地址：${ctx.urls.hls}`,
    source: 'local',
  };
}

async function aiAnswer(q, ctx) {
  const s = ctx.stream;
  const sys = [
    '你是一个给完全不懂电脑的人用的直播助手，回答必须极简、分步骤、说人话。',
    `当前环境：本机局域网 IP=${ctx.ip}；PS5 需要填的 DNS=${ctx.configuredIp}；`,
    `PS5 是否正在推流=${s.live ? '是，流名 ' + s.name : '否'}；`,
    `OBS 播放地址=${ctx.urls.hls}；低延迟 RTMP=${ctx.urls.rtmp || '（需先开播）'}；`,
    '不要编造不存在的按钮。不要输出 Markdown 表格，最多用数字列表。',
  ].join('');
  const r = await fetch(`${AI_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AI_KEY}` },
    body: JSON.stringify({
      model: AI_MODEL,
      temperature: 0.2,
      messages: [{ role: 'system', content: sys }, { role: 'user', content: String(q) }],
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`AI 接口 ${r.status}`);
  const j = await r.json();
  const text = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (!text) throw new Error('AI 返回为空');
  return { text: text.trim(), source: 'ai' };
}

/* --------------------------------- HTTP ----------------------------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function serveStatic(res, rel) {
  const send = (buf) => {
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(rel)] || 'application/octet-stream',
      'Cache-Control': rel === 'index.html' ? 'no-store' : 'public, max-age=3600',
    });
    res.end(buf);
  };
  if (IS_SEA) {
    try { return send(Buffer.from(sea.getAsset(rel))); } catch (_) { /* 落到磁盘 */ }
  }
  const file = path.join(__dirname, 'public', rel);
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('not found'); }
    send(buf);
  });
}

const hlsState = { name: '', dir: '', child: '' };

function proxiedPlaylist(text, dirUrl, streamName) {
  if (hlsState.name !== streamName) {
    hlsState.name = streamName;
    hlsState.dir = '';
    hlsState.child = '';
  }
  const res = text.match(/RESOLUTION=(\d+)x(\d+)/);
  const fr = text.match(/FRAME-RATE=([\d.]+)/);
  if (res) hlsProbe = { name: streamName, width: +res[1], height: +res[2], fps: fr ? +fr[1] : null, at: Date.now() };
  hlsState.dir = dirUrl;
  return text.split('\n').map((line) => {
    const l = line.trim();
    if (!l || l.startsWith('#')) return line;
    let u;
    try { u = new URL(l, dirUrl); } catch (_) { return line; }
    if (/\.m3u8(\?|$)/i.test(u.pathname + u.search)) {
      hlsState.child = u.href;
      return '/live/v.m3u8';
    }
    return '/live/s/' + encodeURIComponent(u.pathname.split('/').pop());
  }).join('\n');
}

async function fetchText(urlStr, timeout = 3000) {
  const r = await fetch(urlStr, { signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw new Error('mediamtx ' + r.status);
  return r.text();
}

async function handlePlaylist(res) {
  const st = await getStatus();
  const s = st.stream;
  if (!s.live) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end('PS5 还没有开始直播');
  }
  try {
    const plUrl = fillTemplate(HLS_PLAYLIST, { ip: requestIp(), name: s.name, path: s.path || s.name });
    const text = await fetchText(plUrl);
    const out = proxiedPlaylist(text, new URL('.', plUrl).href, s.path || s.name);
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
    res.end(out);
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('切片还没生成，稍等 2 秒再刷新：' + String(e.message || e));
  }
}

async function handleVariant(res) {
  const st = await getStatus();
  const s = st.stream;
  if (!s.live || !hlsState.child) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('播放列表还没准备好');
  }
  try {
    const text = await fetchText(hlsState.child);
    const out = proxiedPlaylist(text, new URL('.', hlsState.child).href, s.path || s.name);
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
    res.end(out);
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(String(e.message || e));
  }
}

async function handleSegment(res, name) {
  if (!hlsState.dir || !name || name.includes('/') || name.includes('..')) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('还没有切片');
  }
  try {
    const r = await fetch(hlsState.dir + encodeURIComponent(name), { signal: AbortSignal.timeout(8000) });
    if (!r.ok) { res.writeHead(502); return res.end('切片不存在'); }
    const type = r.headers.get('content-type') || (/\.ts$/i.test(name) ? 'video/mp2t' : 'application/octet-stream');
    const buf = Buffer.from(await r.arrayBuffer());
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(buf);
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(String(e.message || e));
  }
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(data));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (p === '/api/status') {
      const st = await getStatus();
      const ip = requestIp();
      return sendJson(res, 200, {
        ok: true,
        ip,
        configuredIp: st.configuredIp,
        ipMismatch: st.configuredIp !== ip,
        urls: urls(ip, st.stream),
        stream: st.stream,
        rtmpOk: st.rtmpOk,
        dns: st.dns,
        dnsBound,
        dnsBindError,
        proxy: { enabled: proxyEnabled, addr: PROXY_ADDR, port: PROXY_PORT, error: proxyError },
        installed: fs.existsSync(path.join(STATE_DIR, '.installed')),
        liveSince: st.liveSince,
        lastLiveAt: st.lastLiveAt,
        ai: !!AI_KEY,
      });
    }

    if (p === '/api/proxy' && req.method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        enabled: proxyEnabled,
        addr: PROXY_ADDR,
        auto: !PROXY_ADDR_CFG,
        error: proxyError,
        candidates: PROXY_CANDIDATES,
      });
    }

    if (p === '/api/proxy' && req.method === 'POST') {
      const body = await readBody(req);
      let addr = '';
      let enable = 'auto';
      try {
        const j = JSON.parse(body || '{}');
        addr = String(j.addr || '').trim();
        if (j.enable === false) enable = '0';
        else if (j.enable === true) enable = '1';
      } catch (_) { /* ignore */ }
      if (addr && !/^[^\s:]+:\d{1,5}$/.test(addr)) {
        return sendJson(res, 400, { ok: false, error: '格式应为 IP:端口，例如 127.0.0.1:7897' });
      }
      const r = await applyProxy(addr, enable);
      saveProxyCfg(addr, enable);
      log(`Twitch 代理设置为 ${addr || '自动'}，结果 ${r.enabled ? '已连接 ' + r.addr : '未连上'}`);
      return sendJson(res, 200, { ok: true, enabled: r.enabled, addr: r.addr, error: r.error, auto: !addr });
    }

    if (p === '/api/dns-ip' && req.method === 'POST') {
      const body = await readBody(req);
      let ip = '';
      try { ip = String(JSON.parse(body || '{}').ip || '').trim(); } catch (_) { /* ignore */ }
      if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip) || ip.split('.').some((n) => +n > 255)) {
        return sendJson(res, 400, { ok: false, error: 'IP 格式不对' });
      }
      writeConfIp(ip);
      cache = { at: 0, value: null };
      log('劫持 IP 改为 ' + ip);
      return sendJson(res, 200, { ok: true, ip, configuredIp: confIp() });
    }

    if (p === '/api/ask' && req.method === 'POST') {
      const body = await readBody(req);
      let q = '';
      try { q = String(JSON.parse(body || '{}').q || ''); } catch (_) { /* ignore */ }
      const st = await getStatus();
      const ip = requestIp();
      const ctx = { ip, configuredIp: st.configuredIp, urls: urls(ip, st.stream), stream: st.stream, dns: st.dns, rtmpOk: st.rtmpOk };
      let out;
      if (AI_KEY) {
        try { out = await aiAnswer(q, ctx); } catch (e) { out = localAnswer(q, ctx); out.note = 'AI 不可用，已用内置回答：' + String(e.message || e); }
      } else {
        out = localAnswer(q, ctx);
      }
      return sendJson(res, 200, { ok: true, ...out });
    }

    if (p === '/api/install' && req.method === 'POST') {
      if (!CLIENT_EXE) return sendJson(res, 400, { ok: false, error: '没有客户端程序' });
      try {
        spawn(CLIENT_EXE, ['--install'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: String(e.message || e) });
      }
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/shutdown' && req.method === 'POST') {
      sendJson(res, 200, { ok: true });
      setTimeout(() => { stopMedia(); process.exit(0); }, 200);
      return;
    }

    if (p === '/live.m3u8') return handlePlaylist(res);
    if (p === '/live/v.m3u8') return handleVariant(res);
    if (p.startsWith('/live/s/')) return handleSegment(res, decodeURIComponent(p.slice('/live/s/'.length)));

    if (p === '/healthz') {
      const st = await getStatus();
      return sendJson(res, 200, { ok: true, live: st.stream.live, ip: requestIp() });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    return serveStatic(res, p === '/' ? 'index.html' : p.replace(/^\/+/, ''));
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: String((e && e.message) || e) });
  }
});

/* --------------------------------- 启动 ----------------------------------- */
async function main() {
  if (process.argv.slice(2).some((a) => String(a).toLowerCase() === '--stop')) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/shutdown`, { method: 'POST', signal: AbortSignal.timeout(2000) });
      if (r.ok) return;
    } catch (_) { /* 没在跑 */ }
    try {
      const pid = parseInt(fs.readFileSync(path.join(STATE_DIR, '.pid'), 'utf8'), 10);
      if (pid > 0) execFile('taskkill', ['/F', '/PID', String(pid)], { windowsHide: true });
    } catch (_) { /* ignore */ }
    return;
  }

  startEmbeddedDns();
  startMedia();
  ensureProxy();
  setInterval(ensureProxy, 10000);
  server.listen(PORT, '127.0.0.1', () => {
    log(`listening :${PORT} dns=:${DNS_PORT} rtmp=:${RTMP_PORT} mode=${IS_SEA ? 'exe' : 'dir'}`);
    try { fs.writeFileSync(path.join(STATE_DIR, '.pid'), String(process.pid)); } catch (_) { /* ignore */ }
  });
}

main().catch((e) => log('启动失败: ' + ((e && e.message) || e)));
process.on('exit', stopMedia);
process.on('SIGINT', () => { stopMedia(); process.exit(0); });
process.on('SIGTERM', () => { stopMedia(); process.exit(0); });
