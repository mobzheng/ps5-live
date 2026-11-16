/**
 * 构建后台引擎（Node SEA：把 mediamtx、配置、页面全部内嵌成一个可执行文件）。
 *
 * Windows → dist/engine.exe        （GUI 子系统，后台运行不弹黑窗）
 * macOS   → dist/engine            （注入后重新 ad-hoc 签名）
 *
 * 用法：node tools/build-engine.mjs
 * 依赖：本机 node ≥ 20、tools/node_modules/postject、对应平台的 mediamtx
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const arch = process.arch;
const build = path.join(root, 'tools', 'build-engine');
const dist = path.join(root, 'dist');
const out = path.join(dist, process.env.OUT_NAME || (isWin ? 'engine.exe' : 'engine'));
const nodeBin = process.env.NODE_BIN ? path.resolve(root, process.env.NODE_BIN) : process.execPath;

function mtxSource() {
  if (process.env.MEDIAMTX_PATH) return path.resolve(root, process.env.MEDIAMTX_PATH);
  if (isWin) return path.join(root, 'assets', 'mediamtx.exe');
  return path.join(root, 'assets', `mediamtx-darwin-${arch}`);
}

const mtxPath = mtxSource();
if (!fs.existsSync(mtxPath)) throw new Error('缺少 mediamtx: ' + mtxPath);

const assets = {
  'index.html': path.join(root, 'app', 'public', 'index.html'),
  'hls.min.js': path.join(root, 'app', 'public', 'hls.min.js'),
  [isWin ? 'mediamtx.exe' : 'mediamtx']: mtxPath,
  'mediamtx.yml': path.join(root, 'assets', 'mediamtx.yml'),
  'dnsmasq.conf': path.join(root, 'assets', 'dnsmasq.conf'),
  'config.json': path.join(root, 'assets', 'config.json'),
};

const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', cwd: build, ...opts });

fs.rmSync(build, { recursive: true, force: true });
fs.mkdirSync(build, { recursive: true });
fs.mkdirSync(dist, { recursive: true });

for (const [name, src] of Object.entries(assets)) {
  if (!fs.existsSync(src)) throw new Error('缺少资源: ' + src);
  fs.copyFileSync(src, path.join(build, name));
}
fs.copyFileSync(path.join(root, 'app', 'server.js'), path.join(build, 'main.js'));

fs.writeFileSync(path.join(build, 'sea-config.json'), JSON.stringify({
  main: 'main.js',
  output: 'sea-prep.blob',
  disableExperimentalSEAWarning: true,
  assets: Object.fromEntries(Object.keys(assets).map((n) => [n, n])),
}, null, 2), 'utf8');

console.log('[1/4] 生成 SEA blob…');
run(process.execPath, ['--experimental-sea-config', 'sea-config.json']);

console.log('[2/4] 复制 node 运行时…');
fs.rmSync(out, { force: true });
fs.copyFileSync(nodeBin, out);
fs.chmodSync(out, 0o755);

if (isMac) {
  console.log('[2.5/4] 去掉原有签名…');
  run('codesign', ['--remove-signature', out], { cwd: root });
}

console.log('[3/4] 注入 blob…');
const postject = path.join(root, 'tools', 'node_modules', '.bin', isWin ? 'postject.cmd' : 'postject');
if (!fs.existsSync(postject)) throw new Error('缺少 postject：npm i --prefix tools');
const inject = [out, 'NODE_SEA_BLOB', path.join(build, 'sea-prep.blob'), '--sentinel-fuse', FUSE];
if (isMac) inject.push('--macho-segment-name', 'NODE_SEA');
if (isWin) run('cmd', ['/c', postject, ...inject]);
else run(postject, inject, { cwd: root });

console.log('[4/4] 收尾…');
if (isWin) {
  const buf = fs.readFileSync(out);
  const peOff = buf.readUInt32LE(0x3c);
  if (buf.readUInt32LE(peOff) !== 0x00004550) throw new Error('不是有效的 PE 文件');
  const optsOff = peOff + 24;
  const magic = buf.readUInt16LE(optsOff);
  if (magic !== 0x20b && magic !== 0x10b) throw new Error('未知的 PE optional header');
  buf.writeUInt16LE(2, optsOff + 68); // GUI 子系统
  fs.writeFileSync(out, buf);
} else if (isMac) {
  run('codesign', ['--force', '--sign', '-', out], { cwd: root });
  run('codesign', ['--verify', out], { cwd: root });
}

const sha = crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex');
console.log(`\n引擎完成：${out}`);
console.log(`大小：${(fs.statSync(out).size / 1048576).toFixed(1)} MB`);
console.log(`SHA256：${sha}`);
