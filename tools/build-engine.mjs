/**
 * 构建后台引擎 dist/engine.exe（Node SEA：把 mediamtx、配置、页面全部内嵌）。
 *
 * 用法：node tools/build-engine.mjs
 * 依赖：本机 node ≥ 20、tools/node_modules/postject、assets/mediamtx.exe
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const build = path.join(root, 'tools', 'build-engine');
const dist = path.join(root, 'dist');
const out = path.join(dist, 'engine.exe');

const assets = {
  'index.html': path.join(root, 'app', 'public', 'index.html'),
  'hls.min.js': path.join(root, 'app', 'public', 'hls.min.js'),
  'mediamtx.exe': path.join(root, 'assets', 'mediamtx.exe'),
  'mediamtx.yml': path.join(root, 'assets', 'mediamtx.yml'),
  'dnsmasq.conf': path.join(root, 'assets', 'dnsmasq.conf'),
  'config.json': path.join(root, 'assets', 'config.json'),
};

const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

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

const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit', cwd: build });

console.log('[1/4] 生成 SEA blob…');
run(process.execPath, ['--experimental-sea-config', 'sea-config.json']);

console.log('[2/4] 复制 node 运行时…');
fs.rmSync(out, { force: true });
fs.copyFileSync(process.execPath, out);

console.log('[3/4] 注入 blob…');
const postject = path.join(root, 'tools', 'node_modules', '.bin', 'postject.cmd');
if (!fs.existsSync(postject)) throw new Error('缺少 postject：npm i --prefix tools');
run('cmd', ['/c', postject, out, 'NODE_SEA_BLOB', path.join(build, 'sea-prep.blob'), '--sentinel-fuse', FUSE]);

console.log('[4/4] 改成 GUI 子系统（后台运行不弹黑窗）…');
const buf = fs.readFileSync(out);
const peOff = buf.readUInt32LE(0x3c);
if (buf.readUInt32LE(peOff) !== 0x00004550) throw new Error('不是有效的 PE 文件');
const optsOff = peOff + 24;
const magic = buf.readUInt16LE(optsOff);
if (magic !== 0x20b && magic !== 0x10b) throw new Error('未知的 PE optional header');
buf.writeUInt16LE(2, optsOff + 68);
fs.writeFileSync(out, buf);

const sha = crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex');
console.log(`\n引擎完成：${out}`);
console.log(`大小：${(fs.statSync(out).size / 1048576).toFixed(1)} MB`);
console.log(`SHA256：${sha}`);
