using System;
using System.Diagnostics;
using System.IO;
using System.ServiceProcess;
using System.Timers;

public sealed class RemoteSupportService : ServiceBase {
  const string TaskName = "Organization Remote Support Admin Agent";
  readonly Timer timer = new Timer(30000);

  public RemoteSupportService() {
    ServiceName = "OrganizationRemoteSupport";
    CanStop = true;
    AutoLog = false;
    timer.AutoReset = true;
    timer.Elapsed += (_sender, _event) => EnsureAgent();
  }

  static string LogPath {
    get {
      var directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "OrganizationRemoteSupport");
      Directory.CreateDirectory(directory);
      return Path.Combine(directory, "service.log");
    }
  }

  static void Log(string message) {
    try { File.AppendAllText(LogPath, DateTimeOffset.Now.ToString("O") + " " + message + Environment.NewLine); }
    catch { }
  }

  static void EnsureAgent() {
    try {
      var process = Process.Start(new ProcessStartInfo("schtasks.exe", "/Run /TN \"" + TaskName + "\"") {
        UseShellExecute = false,
        CreateNoWindow = true,
        WindowStyle = ProcessWindowStyle.Hidden
      });
      if (process != null) process.Dispose();
    } catch (Exception error) { Log("watchdog error: " + error.Message); }
  }

  protected override void OnStart(string[] args) {
    Log("service started");
    EnsureAgent();
    timer.Start();
  }

  protected override void OnStop() {
    timer.Stop();
    Log("service stopped");
  }

  public static void Main(string[] args) {
    if (Environment.UserInteractive && args.Length > 0 && args[0] == "--check") {
      Console.WriteLine("SERVICE_OK");
      return;
    }
    ServiceBase.Run(new RemoteSupportService());
  }
}
