# PS5 直播小助手

把 PS5 的老鼠台（Twitch）直播流劫持到这台电脑上，再转成 OBS 能直接用的播放地址。**不用采集卡。**

交付物只有一个文件：Windows 上叫 `PS5直播助手.exe`；从 GitHub Release 下载时会被重命名为 `PS5Live-Windows.exe`（GitHub 会吞掉资源名里的中文），下载后改成什么名字都能跑。

窗口里照做就行：

| 窗口位置 | 内容 |
|---|---|
| 第 1 张卡 | PS5 要填的 DNS（本机 IP），复制后填到 PS5 |
| 第 2 张卡 | OBS 的媒体源地址 `http://<本机IP>:8088/live.m3u8`（固定不变） |
| 实时画面 | 预览，带分辨率/码率/时长 |
| 问一句 | 内置问答（离线可用），知道当前 IP 和直播状态 |

> **从 GitHub 下载的 exe 会被 SmartScreen 拦一次**（未签名）：点「更多信息 → 仍要运行」，或右键 exe → 属性 → 勾选「解除锁定」→ 确定。
## 使用顺序

1. 双击 `PS5直播助手.exe`，点窗口顶部黄条里的 **完成设置**，系统弹窗点“是”（放行防火墙 + 开机自启 + 桌面快捷方式，只一次）。
2. PS5：设置 → 网络 → 设定互联网连接 → 选你的网络 → 选项键 → 详细设定 → **DNS 设置 = 手动**，主 DNS 填窗口第 1 张卡的 IP。
3. PS5 开直播（Share → 直播 → Twitch），窗口变“正在直播”。
4. OBS：来源 → `+` → **媒体源** → 取消「本地文件」→ 粘贴第 2 张卡的地址 → 勾选 **重新连接**。
   - 要 1–2 秒延迟：改用 **VLC 视频源**，填窗口上的 `rtmp://<本机IP>/app/<流名>`。
5. 手机/平板同局域网直接看：`http://<本机IP>:8088/`。

## 结构

```
app/server.js        后台引擎（DNS 劫持 + 接流 + HLS 代理 + 页面 API）
app/public/          页面（窗口里显示的就是它）
client/Client.cs     桌面客户端（WinForms + WebView2，内嵌引擎）
assets/              mediamtx 配置、默认配置、mediamtx.exe（构建时下载）
tools/build-engine.mjs   引擎打包（Node SEA，单文件，含 mediamtx/页面/配置）
tools/build-client.mjs   客户端编译（系统自带 csc + 内嵌引擎）
.github/workflows/   GitHub Actions 自动编译
dist/                构建产物（不入库）
```

## 构建

```bash
npm i --prefix tools                      # 只装 postject
# assets/mediamtx.exe 需自行下载 v1.11.3 windows_amd64 解压得到
node tools/build-engine.mjs               # → dist/engine.exe
node tools/build-client.mjs               # → dist/PS5直播助手.exe
```

运行时目录：`%LOCALAPPDATA%\PS5Live\`（engine.exe、mediamtx.exe、配置、日志）。删掉整个目录 + 卸载项即可完全清除。

命令行（很少需要）：

| 命令 | 作用 |
|---|---|
| `PS5直播助手.exe --install` | 重新做一次设置（防火墙/自启/快捷方式） |
| `PS5直播助手.exe --uninstall` | 取消自启、删防火墙规则和快捷方式 |
| `PS5直播助手.exe --stop` | 停掉后台引擎 |
| `engine.exe --stop` | 同上（引擎单独停） |

## 自动编译（GitHub Actions）

`.github/workflows/build.yml`：打 tag 或手动触发，在 `windows-latest` 上产出 `PS5直播助手.exe` + `SHA256SUMS.txt`，打 tag 时自动发 Release。mediamtx 版本固定并校验 sha256。

首次上传：

```bash
git add -A && git commit -m "init"
git remote add origin git@github.com:<你>/<仓库>.git
git push -u origin main
git tag v1.0.0 && git push origin v1.0.0
```

说明：

- 仓库不提交大二进制（`.gitignore` 排除 `dist/`、`assets/mediamtx.exe`、`tools/cache/`），克隆后由 CI 下载。
- 客户端用系统自带的 .NET Framework 4.8 编译（无需装 SDK），界面用系统 Edge WebView2；Win10 21H2+ / Win11 默认都有。
- 目前只编 Windows x64（防火墙/自启/53 端口都是 Windows 接口）。
- 未签名 exe 首次运行会有 SmartScreen 提示（“更多信息 → 仍要运行”）。

## 出问题

| 现象 | 处理 |
|---|---|
| 窗口显示“还没有开始直播” | PS5 没开播，或 PS5 的 DNS 没指向本机 |
| 顶部黄条一直有 | 点“完成设置”，系统弹窗没点“是” |
| 顶部红字“DNS 服务没起来” | 53 端口被占用（关掉 Windows 移动热点），或点“完成设置”放行防火墙 |
| OBS 没画面 | 先让 PS5 开播，再在 OBS 里点“重新开始”；确认勾了“重新连接” |
| 换网后失效 | 窗口会提示 IP 变了，点“修正 DNS 指向”，PS5 的 DNS 也改成新 IP |
| 想看日志 | `%LOCALAPPDATA%\PS5Live\panel.log` |

## 安全

- 面板没有登录，只监听 `127.0.0.1`，只有本机能开窗口。
- RTMP 1935 允许局域网任意设备推流；只自用时可把 `assets/mediamtx.yml` 的 `paths` 收窄为指定流名。

## macOS

产物：`PS5Live-macos-arm64.zip`（Apple Silicon）/ `PS5Live-macos-x64.zip`（Intel）。

1. 解压，把 `PS5直播小助手.app` 拖进「应用程序」。
2. 第一次打开：右键 → **打开**（未签名，Gatekeeper 会拦一次）。
3. 弹窗要求管理员授权 → 点“好”/输入密码：把引擎装成后台服务并开机自启（`/Library/LaunchDaemons/com.ps5live.engine.plist`）。
4. 窗口出现后用法和 Windows 一样：第 1 张卡的 IP 填进 PS5 的 DNS，第 2 张卡给 OBS。

说明：

- macOS 上 53 端口必须 root 才能监听，所以引擎是 LaunchDaemon；窗口关掉服务仍在跑。
- 日志：`/var/log/ps5live.log`（引擎）、`/Library/Application Support/PS5Live/`（配置与数据）。
- 卸载：`sudo launchctl bootout system/com.ps5live.engine && sudo rm -rf "/Library/Application Support/PS5Live" /Library/LaunchDaemons/com.ps5live.engine.plist`
- 本地构建（需要 Xcode Command Line Tools）：
  ```bash
  npm i --prefix tools
  node tools/build-engine.mjs      # → dist/engine（内含 mediamtx）
  node tools/build-macos.mjs       # → dist/PS5Live-macos-<arch>.zip
  ```

## CI 产物

| 平台 | 产物 | 说明 |
|---|---|---|
| Windows | `PS5直播助手.exe` | 单文件桌面客户端（内嵌引擎） |
| macOS | `PS5Live-macos-arm64.zip` / `-x64.zip` | .app + 内嵌引擎 |

Windows 用 `windows-latest` + 系统自带 .NET Framework/csc；macOS 用 `macos-14`，两个架构的 node 与 mediamtx 都在 CI 里下载并校验 sha256（本机无法运行 macOS，所以 mac 侧只做了编译产物与流程验证）。
