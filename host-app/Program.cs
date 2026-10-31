using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text.RegularExpressions;
using System.Windows.Forms;

namespace DndHost
{
    public class HostForm : Form
    {
        TextBox codeBox, inviteBox, logBox;
        Button startStopBtn, copyCodeBtn, copyInviteBtn;
        Label statusLbl;
        Process proc;
        readonly Regex codeRe = new Regex(@"Party code:\s*([A-Z0-9]{5})", RegexOptions.IgnoreCase);
        readonly Regex inviteRe = new Regex(@"(https?://\S+#s=\S+&c=\S+)", RegexOptions.IgnoreCase);

        public HostForm()
        {
            Text = "D&D Companion Host";
            Width = 640;
            Height = 520;
            MinimumSize = new Size(480, 360);
            StartPosition = FormStartPosition.CenterScreen;
            Font = new Font("Segoe UI", 9F);

            var top = new TableLayoutPanel { Dock = DockStyle.Top, Height = 110, ColumnCount = 3, Padding = new Padding(10) };
            top.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            top.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            top.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));

            top.Controls.Add(new Label { Text = "Party code:", AutoSize = true, Anchor = AnchorStyles.Left, TextAlign = ContentAlignment.MiddleLeft }, 0, 0);
            codeBox = new TextBox { ReadOnly = true, Dock = DockStyle.Fill, Font = new Font("Consolas", 12F, FontStyle.Bold) };
            top.Controls.Add(codeBox, 1, 0);
            copyCodeBtn = new Button { Text = "Copy", AutoSize = true };
            copyCodeBtn.Click += (s, e) => CopyIfAny(codeBox);
            top.Controls.Add(copyCodeBtn, 2, 0);

            top.Controls.Add(new Label { Text = "Invite link:", AutoSize = true, Anchor = AnchorStyles.Left, TextAlign = ContentAlignment.MiddleLeft }, 0, 1);
            inviteBox = new TextBox { ReadOnly = true, Dock = DockStyle.Fill };
            top.Controls.Add(inviteBox, 1, 1);
            copyInviteBtn = new Button { Text = "Copy", AutoSize = true };
            copyInviteBtn.Click += (s, e) => CopyIfAny(inviteBox);
            top.Controls.Add(copyInviteBtn, 2, 1);

            startStopBtn = new Button { Text = "Stop party", AutoSize = true, Margin = new Padding(0, 8, 0, 0) };
            startStopBtn.Click += (s, e) => { if (proc != null) StopServer(); else StartServer(); };
            top.Controls.Add(startStopBtn, 1, 2);

            statusLbl = new Label { Text = "Starting…", AutoSize = true, ForeColor = Color.Gray, Anchor = AnchorStyles.Left, TextAlign = ContentAlignment.MiddleLeft, Margin = new Padding(0, 8, 0, 0) };
            top.Controls.Add(statusLbl, 0, 2);

            logBox = new TextBox
            {
                Multiline = true,
                ReadOnly = true,
                ScrollBars = ScrollBars.Vertical,
                Dock = DockStyle.Fill,
                Font = new Font("Consolas", 9F),
                BackColor = Color.White
            };

            Controls.Add(logBox);
            Controls.Add(top);

            FormClosing += (s, e) => StopServer();
            Shown += (s, e) => StartServer();
        }

        void CopyIfAny(TextBox b)
        {
            if (!string.IsNullOrEmpty(b.Text)) Clipboard.SetText(b.Text);
        }

        string AppDir()
        {
            return Path.GetDirectoryName(Application.ExecutablePath);
        }

        void StartServer()
        {
            if (proc != null) return;
            var dir = AppDir();
            var script = Path.Combine(dir, "server.js");
            if (!File.Exists(script))
            {
                AppendLog("server.js was not found next to this program (" + script + ").");
                statusLbl.Text = "Not found";
                return;
            }
            var psi = new ProcessStartInfo
            {
                FileName = "node",
                Arguments = "\"" + script + "\"",
                WorkingDirectory = dir,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true
            };
            try
            {
                proc = new Process { StartInfo = psi, EnableRaisingEvents = true };
                proc.OutputDataReceived += (s, e) => { if (e.Data != null) OnLine(e.Data); };
                proc.ErrorDataReceived += (s, e) => { if (e.Data != null) OnLine(e.Data); };
                proc.Exited += (s, e) => BeginInvoke((Action)(() =>
                {
                    AppendLog("[server stopped]");
                    statusLbl.Text = "Stopped";
                    startStopBtn.Text = "Start party";
                    proc = null;
                }));
                proc.Start();
                proc.BeginOutputReadLine();
                proc.BeginErrorReadLine();
                statusLbl.Text = "Running";
                startStopBtn.Text = "Stop party";
                codeBox.Text = "";
                inviteBox.Text = "";
                logBox.Clear();
            }
            catch (Exception ex)
            {
                AppendLog("Could not start the server: " + ex.Message);
                AppendLog("Make sure Node.js is installed (node must be on your PATH).");
                statusLbl.Text = "Error";
                proc = null;
            }
        }

        void StopServer()
        {
            if (proc == null) return;
            try { proc.Kill(); } catch { }
            proc = null;
            statusLbl.Text = "Stopped";
            startStopBtn.Text = "Start party";
        }

        void OnLine(string line)
        {
            if (IsDisposed) return;
            BeginInvoke((Action)(() =>
            {
                AppendLog(line);
                var mc = codeRe.Match(line);
                if (mc.Success) codeBox.Text = mc.Groups[1].Value.ToUpperInvariant();
                var mi = inviteRe.Match(line);
                if (mi.Success) inviteBox.Text = mi.Groups[1].Value;
            }));
        }

        void AppendLog(string line)
        {
            logBox.AppendText(line + Environment.NewLine);
        }

        [STAThread]
        public static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new HostForm());
        }
    }
}
