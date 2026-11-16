/**
 * 打包 macOS 客户端：编译 Swift 界面 + 组装 .app + 压缩为 zip。
 *
 * 用法（在 macOS 上）：node tools/build-macos.mjs
 * 依赖：swiftc（Xcode Command Line Tools）、dist/engine
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const engine = process.env.ENGINE ? path.resolve(root, process.env.ENGINE) : path.join(dist, 'engine');
const arch = process.env.TARGET_ARCH || process.arch;
const appName = 'PS5直播小助手.app';
const appDir = path.join(dist, appName);
const zipPath = path.join(dist, `PS5Live-macos-${arch}.zip`);

if (!fs.existsSync(engine)) throw new Error('先构建引擎：node tools/build-engine.mjs');

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', cwd: root, ...opts });

fs.rmSync(appDir, { recursive: true, force: true });
fs.mkdirSync(path.join(appDir, 'Contents', 'MacOS'), { recursive: true });
fs.mkdirSync(path.join(appDir, 'Contents', 'Resources'), { recursive: true });

console.log('[1/3] 编译 Swift 界面…');
run('swiftc', ['-O', '-target', arch === 'arm64' ? 'arm64-apple-macos11' : 'x86_64-apple-macos11',
  'client-macos/main.swift', '-o', path.join(appDir, 'Contents', 'MacOS', 'PS5Live'),
  '-framework', 'AppKit', '-framework', 'WebKit']);

console.log('[2/3] 组装 .app…');
fs.copyFileSync(path.join(root, 'client-macos', 'Info.plist'), path.join(appDir, 'Contents', 'Info.plist'));
fs.copyFileSync(engine, path.join(appDir, 'Contents', 'Resources', 'engine'));
fs.chmodSync(path.join(appDir, 'Contents', 'Resources', 'engine'), 0o755);
fs.chmodSync(path.join(appDir, 'Contents', 'MacOS', 'PS5Live'), 0o755);
try { run('codesign', ['--force', '--deep', '--sign', '-', appDir]); } catch (_) { /* 没签名也能跑，只是首次要右键打开 */ }

console.log('[3/3] 压缩…');
fs.rmSync(zipPath, { force: true });
run('ditto', ['-c', '-k', '--keepParent', appDir, zipPath]);

const sha = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex');
console.log(`\n客户端：${zipPath}`);
console.log(`大小：${(fs.statSync(zipPath).size / 1048576).toFixed(1)} MB`);
console.log(`SHA256：${sha}`);
