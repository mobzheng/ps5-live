import AppKit
import WebKit

// PS5 直播小助手 —— macOS 客户端
// 首次运行会把引擎装成 LaunchDaemon（需要管理员授权一次），之后开机自动运行。

let appDir = "/Library/Application Support/PS5Live"
let daemonLabel = "com.ps5live.engine"
let daemonPath = "/Library/LaunchDaemons/\(daemonLabel).plist"
let panelURL = URL(string: "http://127.0.0.1:8088/")!

func engineResource() -> String? {
    return Bundle.main.path(forResource: "engine", ofType: nil)
}

func healthOK() -> Bool {
    var ok = false
    let sem = DispatchSemaphore(value: 0)
    var req = URLRequest(url: URL(string: "http://127.0.0.1:8088/healthz")!)
    req.timeoutInterval = 1.0
    URLSession.shared.dataTask(with: req) { _, resp, _ in
        if let r = resp as? HTTPURLResponse, r.statusCode == 200 { ok = true }
        sem.signal()
    }.resume()
    _ = sem.wait(timeout: .now() + 2.0)
    return ok
}

func waitHealthy(_ seconds: Double) -> Bool {
    let deadline = Date().addingTimeInterval(seconds)
    while Date() < deadline {
        if healthOK() { return true }
        Thread.sleep(forTimeInterval: 0.3)
    }
    return healthOK()
}

func runAdmin(_ shell: String) -> Bool {
    let script = "do shell script \"\(shell.replacingOccurrences(of: "\"", with: "\\\""))\" with administrator privileges"
    guard let apple = NSAppleScript(source: script) else { return false }
    var err: NSDictionary?
    apple.executeAndReturnError(&err)
    return err == nil
}

let plistBody = """
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>\(daemonLabel)</string>
    <key>ProgramArguments</key><array><string>\(appDir)/engine</string></array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>/var/log/ps5live.log</string>
    <key>StandardErrorPath</key><string>/var/log/ps5live.log</string>
</dict>
</plist>
"""

func installDaemon() -> Bool {
    guard let engine = engineResource() else {
        alert("安装包不完整：找不到 engine。")
        return false
    }
    let tmp = NSTemporaryDirectory() + "\(daemonLabel).plist"
    do {
        try plistBody.write(toFile: tmp, atomically: true, encoding: .utf8)
    } catch {
        alert("无法写入临时配置文件。")
        return false
    }
    let cmd = """
    mkdir -p "\(appDir)" && cp "\(engine)" "\(appDir)/engine" && chmod +x "\(appDir)/engine" && cp "\(tmp)" "\(daemonPath)" && chmod 644 "\(daemonPath)" && (launchctl bootout system/\(daemonLabel) 2>/dev/null || true) && launchctl bootstrap system "\(daemonPath)" && launchctl enable system/\(daemonLabel)
    """
    if !runAdmin(cmd) {
        alert("安装后台服务需要管理员授权；已取消。\n可以再运行一次本程序重试。")
        return false
    }
    return waitHealthy(15)
}

func alert(_ text: String) {
    let a = NSAlert()
    a.messageText = "PS5 直播小助手"
    a.informativeText = text
    a.alertStyle = .warning
    a.addButton(withTitle: "好")
    a.runModal()
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var web: WKWebView!

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)

        if !healthOK() {
            if !installDaemon() {
                if !healthOK() {
                    alert("后台服务没能启动。\n日志：/var/log/ps5live.log")
                    NSApp.terminate(nil)
                    return
                }
            }
        }

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1120, height: 860),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "PS5 直播小助手"
        window.center()
        window.setFrameAutosaveName("PS5LiveWindow")
        window.minSize = NSSize(width: 900, height: 640)

        let config = WKWebViewConfiguration()
        web = WKWebView(frame: window.contentView!.bounds, configuration: config)
        web.autoresizingMask = [.width, .height]
        web.load(URLRequest(url: panelURL))
        window.contentView = web
        window.makeKeyAndOrderFront(nil)

        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
