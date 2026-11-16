using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

/// <summary>
/// PS5 直播小助手 —— 桌面客户端
/// 负责：释放并启动引擎、显示窗口、首次设置（防火墙/开机自启/快捷方式）
/// </summary>
class Program
{
    const string TITLE = "PS5 直播小助手";
    const string ENGINE_RES = "engine.exe";
    const string RUN_KEY = @"Software\Microsoft\Windows\CurrentVersion\Run";
    const string RUN_VALUE = "PS5LivePanel";
    static string StateDir;
    static string RuntimeDir;
    static string EnginePath;
    static string StableClient;
    static string PanelUrl = "http://127.0.0.1:8088/";

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr LoadLibrary(string path);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr FindWindow(string cls, string title);

    [DllImport("user32.dll")]
    static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    static extern bool ShowWindow(IntPtr hWnd, int cmd);

    static string SelfPath
    {
        get { return Assembly.GetEntryAssembly().Location; }
    }

    static void Init()
    {
        StateDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PS5Live");
        RuntimeDir = Path.Combine(StateDir, "runtime");
        EnginePath = Path.Combine(RuntimeDir, "engine.exe");
        StableClient = Path.Combine(StateDir, "PS5直播助手.exe");
        Directory.CreateDirectory(RuntimeDir);
        AppDomain.CurrentDomain.AssemblyResolve += ResolveManaged;
        try { LoadLibrary(Path.Combine(RuntimeDir, "WebView2Loader.dll")); } catch (Exception) { }
    }

    static Assembly ResolveManaged(object sender, ResolveEventArgs e)
    {
        try
        {
            string name = new AssemblyName(e.Name).Name + ".dll";
            string p = Path.Combine(RuntimeDir, name);
            if (File.Exists(p)) return Assembly.LoadFrom(p);
        }
        catch (Exception) { }
        return null;
    }

    static void EnsureFile(string resource, string target, bool always)
    {
        using (Stream s = Assembly.GetEntryAssembly().GetManifestResourceStream(resource))
        {
            if (s == null) return;
            bool write = always;
            if (!write)
            {
                try { write = new FileInfo(target).Length != s.Length; }
                catch (Exception) { write = true; }
            }
            if (!write) return;
            string tmp = target + ".tmp";
            if (File.Exists(tmp)) File.Delete(tmp);
            using (FileStream fs = new FileStream(tmp, FileMode.Create, FileAccess.Write))
            {
                s.CopyTo(fs);
            }
            if (File.Exists(target)) File.Delete(target);
            File.Move(tmp, target);
        }
    }

    static void ExtractRuntime()
    {
        EnsureFile(ENGINE_RES, EnginePath, false);
        EnsureFile("Microsoft.Web.WebView2.Core.dll", Path.Combine(RuntimeDir, "Microsoft.Web.WebView2.Core.dll"), false);
        EnsureFile("Microsoft.Web.WebView2.WinForms.dll", Path.Combine(RuntimeDir, "Microsoft.Web.WebView2.WinForms.dll"), false);
        EnsureFile("WebView2Loader.dll", Path.Combine(RuntimeDir, "WebView2Loader.dll"), false);
    }

    static bool EngineAlive()
    {
        try
        {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(PanelUrl + "healthz");
            req.Timeout = 700;
            req.ReadWriteTimeout = 700;
            using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
            {
                return (int)resp.StatusCode == 200;
            }
        }
        catch (Exception) { return false; }
    }

    static void StartEngine()
    {
        ProcessStartInfo psi = new ProcessStartInfo(EnginePath);
        psi.WorkingDirectory = RuntimeDir;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.EnvironmentVariables["PS5LIVE_CLIENT"] = SelfPath;
        Process.Start(psi);
    }

    static bool WaitEngine(int ms)
    {
        int waited = 0;
        while (waited < ms)
        {
            if (EngineAlive()) return true;
            Thread.Sleep(300);
            waited += 300;
        }
        return EngineAlive();
    }

    static void Post(string path)
    {
        try
        {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(PanelUrl.TrimEnd('/') + path);
            req.Method = "POST";
            req.Timeout = 2000;
            req.ContentLength = 0;
            using (req.GetResponse()) { }
        }
        catch (Exception) { }
    }

    static bool IsAdmin()
    {
        try
        {
            System.Security.Principal.WindowsIdentity id = System.Security.Principal.WindowsIdentity.GetCurrent();
            System.Security.Principal.WindowsPrincipal p = new System.Security.Principal.WindowsPrincipal(id);
            return p.IsInRole(System.Security.Principal.WindowsBuiltInRole.Administrator);
        }
        catch (Exception) { return false; }
    }

    static void Elevate(string args)
    {
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo(SelfPath, args);
            psi.Verb = "runas";
            psi.UseShellExecute = true;
            Process.Start(psi);
        }
        catch (Exception) { }
    }

    static void RunHidden(string file, string args)
    {
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo(file, args);
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.WindowStyle = ProcessWindowStyle.Hidden;
            Process.Start(psi);
        }
        catch (Exception) { }
    }

    static string Run(string file, string args)
    {
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo(file, args);
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            using (Process p = Process.Start(psi))
            {
                string output = p.StandardOutput.ReadToEnd();
                p.WaitForExit(15000);
                return output;
            }
        }
        catch (Exception) { return ""; }
    }

    static void CreateShortcut(string target)
    {
        try
        {
            Type shell = Type.GetTypeFromProgID("WScript.Shell");
            object obj = Activator.CreateInstance(shell);
            string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
            string link = Path.Combine(desktop, "PS5 直播小助手.lnk");
            object shortcut = shell.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, obj, new object[] { link });
            Type t = shortcut.GetType();
            t.InvokeMember("TargetPath", BindingFlags.SetProperty, null, shortcut, new object[] { target });
            t.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, shortcut, new object[] { StateDir });
            t.InvokeMember("Description", BindingFlags.SetProperty, null, shortcut, new object[] { TITLE });
            t.InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, new object[] { });
        }
        catch (Exception) { }
    }

    static void WriteMarker()
    {
        try { File.WriteAllText(Path.Combine(StateDir, ".installed"), "1"); }
        catch (Exception) { }
    }

    static void DoUserInstall()
    {
        try
        {
            if (!string.Equals(Path.GetFullPath(SelfPath), Path.GetFullPath(StableClient), StringComparison.OrdinalIgnoreCase))
            {
                if (!File.Exists(StableClient) || new FileInfo(StableClient).Length != new FileInfo(SelfPath).Length)
                {
                    File.Copy(SelfPath, StableClient, true);
                }
            }
        }
        catch (Exception) { }

        string client = File.Exists(StableClient) ? StableClient : SelfPath;
        using (RegistryKey k = Registry.CurrentUser.CreateSubKey(RUN_KEY))
        {
            if (k != null) k.SetValue(RUN_VALUE, "\"" + EnginePath + "\" --hidden");
        }
        CreateShortcut(client);
        WriteMarker();
    }

    static void DoAdminInstall()
    {
        string sc = Run("sc", "query SharedAccess");
        if (sc.IndexOf("RUNNING", StringComparison.OrdinalIgnoreCase) >= 0)
        {
            Run("net", "stop SharedAccess");
        }
        string[][] rules = new string[][]
        {
            new string[] { "PS5Live-DNS", "UDP", "53" },
            new string[] { "PS5Live-RTMP", "TCP", "1935" },
            new string[] { "PS5Live-HLS", "TCP", "8000" },
            new string[] { "PS5Live-Panel", "TCP", "8088" }
        };
        foreach (string[] r in rules)
        {
            Run("netsh", "advfirewall firewall delete rule name=" + r[0]);
            Run("netsh", "advfirewall firewall add rule name=" + r[0] + " dir=in action=allow protocol=" + r[1] + " localport=" + r[2]);
        }
    }

    static void DoUninstall()
    {
        Post("/api/shutdown");
        try
        {
            using (RegistryKey k = Registry.CurrentUser.OpenSubKey(RUN_KEY, true))
            {
                if (k != null) k.DeleteValue(RUN_VALUE, false);
            }
        }
        catch (Exception) { }
        try
        {
            string link = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "PS5 直播小助手.lnk");
            if (File.Exists(link)) File.Delete(link);
        }
        catch (Exception) { }
        try { File.Delete(Path.Combine(StateDir, ".installed")); }
        catch (Exception) { }
        string[][] rules = new string[][]
        {
            new string[] { "PS5Live-DNS" },
            new string[] { "PS5Live-RTMP" },
            new string[] { "PS5Live-HLS" },
            new string[] { "PS5Live-Panel" }
        };
        foreach (string[] r in rules) Run("netsh", "advfirewall firewall delete rule name=" + r[0]);
    }

    static void Msg(string text, bool error)
    {
        MessageBox.Show(text, TITLE, MessageBoxButtons.OK,
            error ? MessageBoxIcon.Warning : MessageBoxIcon.Information);
    }

    [STAThread]
    static void Main(string[] args)
    {
        Init();
        string cmd = args.Length > 0 ? args[0].ToLowerInvariant() : "";

        if (cmd == "--admin-install")
        {
            DoAdminInstall();
            Msg("已放行防火墙端口（53/1935/8000/8088）。", false);
            return;
        }
        if (cmd == "--install")
        {
            DoUserInstall();
            if (!IsAdmin() && Environment.GetEnvironmentVariable("PS5LIVE_NO_ELEVATE") == null)
            {
                Elevate("--admin-install");
            }
            else if (IsAdmin())
            {
                DoAdminInstall();
            }
            return;
        }
        if (cmd == "--uninstall")
        {
            DoUninstall();
            if (!IsAdmin() && Environment.GetEnvironmentVariable("PS5LIVE_NO_ELEVATE") == null)
            {
                Elevate("--admin-uninstall");
            }
            return;
        }
        if (cmd == "--admin-uninstall")
        {
            DoUninstall();
            return;
        }
        if (cmd == "--stop")
        {
            Post("/api/shutdown");
            return;
        }

        // 单实例：已经有窗口就把它叫到前面
        bool created;
        using (Mutex mutex = new Mutex(true, "PS5LiveClientMutex", out created))
        {
            if (!created)
            {
                IntPtr h = FindWindow(null, TITLE);
                if (h != IntPtr.Zero) { ShowWindow(h, 9); SetForegroundWindow(h); }
                return;
            }

            ExtractRuntime();
            if (!WaitEngine(600))
            {
                if (!EngineAlive()) StartEngine();
                if (!WaitEngine(25000))
                {
                    Msg("后台服务启动失败。\n\n可以查看日志：\n" + Path.Combine(StateDir, "panel.log"), true);
                    return;
                }
            }
            RunUi();
            GC.KeepAlive(mutex);
        }
    }

    static void RunUi()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        string ver = null;
        try { ver = Microsoft.Web.WebView2.Core.CoreWebView2Environment.GetAvailableBrowserVersionString(); }
        catch (Exception) { }

        if (ver == null)
        {
            Msg("缺少 Microsoft Edge WebView2 运行库。\n请安装后重试：\nhttps://go.microsoft.com/fwlink/p/?LinkId=2124703", true);
            return;
        }

        Form form = new Form();
        form.Text = TITLE;
        form.ClientSize = new Size(1120, 860);
        form.MinimumSize = new Size(900, 640);
        form.StartPosition = FormStartPosition.CenterScreen;
        form.BackColor = Color.FromArgb(15, 17, 21);
        try { form.Icon = Icon.ExtractAssociatedIcon(SelfPath); }
        catch (Exception) { }

        Microsoft.Web.WebView2.WinForms.WebView2 web = new Microsoft.Web.WebView2.WinForms.WebView2();
        web.Dock = DockStyle.Fill;
        web.DefaultBackgroundColor = Color.FromArgb(15, 17, 21);
        form.Controls.Add(web);

        form.Shown += delegate
        {
            try
            {
                Microsoft.Web.WebView2.Core.CoreWebView2Environment env =
                    Microsoft.Web.WebView2.Core.CoreWebView2Environment.CreateAsync(null, Path.Combine(StateDir, "webview")).Result;
                web.EnsureCoreWebView2Async(env).ContinueWith(delegate
                {
                    try
                    {
                        web.BeginInvoke((MethodInvoker)delegate { web.Source = new Uri(PanelUrl); });
                    }
                    catch (Exception) { }
                });
            }
            catch (Exception)
            {
                web.Source = new Uri(PanelUrl);
            }
        };

        Application.Run(form);
    }
}
