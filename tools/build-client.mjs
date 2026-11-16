/**
 * 构建桌面客户端 dist/PS5直播助手.exe
 * 把 dist/engine.exe 和 WebView2 运行库内嵌进一个 exe，用系统自带的 .NET Framework 4.8 + csc 编译。
 *
 * 用法：node tools/build-client.mjs
 * 依赖：dist/engine.exe、tools/cache/wv2（WebView2 SDK，脚本会自动下载）
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = path.join(root, 'tools', 'cache');
const wv2 = path.join(cache, 'wv2');
const dist = path.join(root, 'dist');
const out = path.join(dist, 'PS5直播助手.exe');
const engine = path.join(dist, 'engine.exe');
const WV2_VERSION = '1.0.2903.40';

const csc = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');

function ensureWebView2() {
  const core = path.join(wv2, 'lib', 'net462', 'Microsoft.Web.WebView2.Core.dll');
  const win = path.join(wv2, 'lib', 'net462', 'Microsoft.Web.WebView2.WinForms.dll');
  const loader = path.join(wv2, 'runtimes', 'win-x64', 'native', 'WebView2Loader.dll');
  if (fs.existsSync(core) && fs.existsSync(win) && fs.existsSync(loader)) return { core, win, loader };
  fs.mkdirSync(cache, { recursive: true });
  const nupkg = path.join(cache, 'wv2.nupkg');
  console.log('下载 WebView2 SDK ' + WV2_VERSION + '…');
  execFileSync('curl', ['-sL', '--max-time', '180', '-o', nupkg,
    `https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/${WV2_VERSION}`], { stdio: 'inherit' });
  fs.rmSync(wv2, { recursive: true, force: true });
  const zip = nupkg + '.zip';
  fs.copyFileSync(nupkg, zip);
  execFileSync('powershell', ['-NoProfile', '-Command',
    `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${wv2}' -Force`], { stdio: 'inherit' });
  if (!fs.existsSync(core)) throw new Error('WebView2 SDK 解压异常');
  return { core, win, loader };
}

if (!fs.existsSync(engine)) throw new Error('先构建引擎：node tools/build-engine.mjs');
if (!fs.existsSync(csc)) throw new Error('找不到 csc.exe：' + csc);

const dll = ensureWebView2();
fs.mkdirSync(dist, { recursive: true });
fs.rmSync(out, { force: true });

const args = [
  '/nologo',
  '/target:winexe',
  '/platform:x64',
  '/optimize+',
  '/out:' + out,
  '/reference:System.dll',
  '/reference:System.Core.dll',
  '/reference:System.Drawing.dll',
  '/reference:System.Windows.Forms.dll',
  '/reference:' + dll.core,
  '/reference:' + dll.win,
  `/resource:${engine},engine.exe`,
  `/resource:${dll.core},Microsoft.Web.WebView2.Core.dll`,
  `/resource:${dll.win},Microsoft.Web.WebView2.WinForms.dll`,
  `/resource:${dll.loader},WebView2Loader.dll`,
  path.join(root, 'client', 'Client.cs'),
];

console.log('[1/2] 编译客户端…');
execFileSync(csc, args, { stdio: 'inherit' });

console.log('[2/2] 完成');
const size = fs.statSync(out).size;
const sha = crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex');
console.log(`\n客户端：${out}`);
console.log(`大小：${(size / 1048576).toFixed(1)} MB`);
console.log(`SHA256：${sha}`);
