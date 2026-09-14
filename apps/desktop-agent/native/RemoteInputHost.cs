using Microsoft.Win32.SafeHandles;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

class RemoteInputHost {
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint clientProcessId);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int informationClass, ref PROCESS_BASIC_INFORMATION information, int size, out int returnLength);

  const uint MOUSE_MOVE=0x0001, MOUSE_LEFTDOWN=0x0002, MOUSE_LEFTUP=0x0004, MOUSE_RIGHTDOWN=0x0008, MOUSE_RIGHTUP=0x0010;
  const uint MOUSE_MIDDLEDOWN=0x0020, MOUSE_MIDDLEUP=0x0040, MOUSE_WHEEL=0x0800;
  const uint MOUSE_ABSOLUTE=0x8000, MOUSE_VIRTUALDESK=0x4000;
  const uint KEYUP=0x0002, UNICODE=0x0004;
  const uint INPUT_MOUSE=0, INPUT_KEYBOARD=1;

  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public InputUnion u; }
  [StructLayout(LayoutKind.Explicit)] struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, flags, time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort vk, scan; public uint flags, time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_BASIC_INFORMATION {
    public IntPtr Reserved1, PebBaseAddress, Reserved2_0, Reserved2_1, UniqueProcessId, InheritedFromUniqueProcessId;
  }

  static void Submit(params INPUT[] inputs) {
    var sent=SendInput((uint)inputs.Length,inputs,Marshal.SizeOf(typeof(INPUT)));
    if(sent!=inputs.Length) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(),"SendInput rejected");
  }

  static void SendMouse(int x, int y, uint data, uint flags) {
    Submit(new INPUT { type=INPUT_MOUSE, u=new InputUnion { mi=new MOUSEINPUT { dx=x,dy=y,mouseData=data,flags=flags } } });
  }

  static readonly Dictionary<string, byte> Keys = new Dictionary<string, byte>(StringComparer.OrdinalIgnoreCase) {
    {"Escape",0x1B},{"Backspace",0x08},{"Tab",0x09},{"Enter",0x0D},{"Return",0x0D},{"Delete",0x2E},
    {"Home",0x24},{"End",0x23},{"PageUp",0x21},{"PageDown",0x22},{"Space",0x20},{"Left",0x25},
    {"Up",0x26},{"Right",0x27},{"Down",0x28},{"Insert",0x2D},{"PrintScreen",0x2C},{"Pause",0x13},{"ContextMenu",0x5D},{"NumLock",0x90},{"ScrollLock",0x91},{"LeftShift",0xA0},{"RightShift",0xA1},{"LeftControl",0xA2},{"RightControl",0xA3},{"LeftAlt",0xA4},{"RightAlt",0xA5},
    {"LeftMeta",0x5B},{"RightMeta",0x5C},{"CapsLock",0x14},{"NumpadAdd",0x6B},{"NumpadSubtract",0x6D},{"NumpadMultiply",0x6A},{"NumpadDivide",0x6F},{"NumpadDecimal",0x6E},{"NumpadEnter",0x0D},{"Comma",0xBC},{"Period",0xBE},{"Slash",0xBF},{"Backslash",0xDC},
    {"Semicolon",0xBA},{"Quote",0xDE},{"LeftBracket",0xDB},{"RightBracket",0xDD},{"Minus",0xBD},{"Equal",0xBB},{"Grave",0xC0}
  };

  static void SendText(string text) {
    foreach (char ch in text) {
      var down = new INPUT { type=INPUT_KEYBOARD, u=new InputUnion { ki=new KEYBDINPUT { scan=ch, flags=UNICODE } } };
      var up = new INPUT { type=INPUT_KEYBOARD, u=new InputUnion { ki=new KEYBDINPUT { scan=ch, flags=UNICODE|KEYUP } } };
      Submit(down,up);
    }
  }

  static byte KeyCode(string name) {
    byte value;
    if (Keys.TryGetValue(name, out value)) return value;
    if (name.Length==1 && char.IsLetterOrDigit(name[0])) return (byte)char.ToUpperInvariant(name[0]);
    if (name.StartsWith("Num") && name.Length==4) return (byte)name[3];
    if (name.StartsWith("Numpad") && name.Length==7 && char.IsDigit(name[6])) return (byte)(0x60+(name[6]-'0'));
    int f;
    if (name.StartsWith("F") && int.TryParse(name.Substring(1), out f) && f>=1 && f<=24) return (byte)(0x6F+f);
    throw new ArgumentException("unsupported key");
  }

  static string Execute(string line) {
    var parts=line.Split(new[]{' '},4);
    switch(parts[0]) {
      case "MOVE":
        var x=double.Parse(parts[1],CultureInfo.InvariantCulture); var y=double.Parse(parts[2],CultureInfo.InvariantCulture);
        SendMouse((int)Math.Round(x*65535),(int)Math.Round(y*65535),0,MOUSE_MOVE|MOUSE_ABSOLUTE|MOUSE_VIRTUALDESK); break;
      case "BUTTON":
        bool down=parts[2]=="down"; uint flag=parts[1]=="right"?(down?MOUSE_RIGHTDOWN:MOUSE_RIGHTUP):parts[1]=="middle"?(down?MOUSE_MIDDLEDOWN:MOUSE_MIDDLEUP):(down?MOUSE_LEFTDOWN:MOUSE_LEFTUP);
        SendMouse(0,0,0,flag); break;
      case "WHEEL": SendMouse(0,0,unchecked((uint)int.Parse(parts[1],CultureInfo.InvariantCulture)),MOUSE_WHEEL); break;
      case "KEY": Submit(new INPUT { type=INPUT_KEYBOARD, u=new InputUnion { ki=new KEYBDINPUT { vk=KeyCode(parts[1]),flags=parts[2]=="up"?KEYUP:0 } } }); break;
      case "TEXT": SendText(Encoding.UTF8.GetString(Convert.FromBase64String(parts[1]))); break;
      case "RELEASE":
        foreach(var vk in new byte[]{0x10,0x11,0x12,0x5B,0x5C}) Submit(new INPUT { type=INPUT_KEYBOARD, u=new InputUnion { ki=new KEYBDINPUT { vk=vk,flags=KEYUP } } });
        SendMouse(0,0,0,MOUSE_LEFTUP); SendMouse(0,0,0,MOUSE_RIGHTUP); SendMouse(0,0,0,MOUSE_MIDDLEUP); break;
      case "PING": return "PONG "+GetSystemMetrics(0)+" "+GetSystemMetrics(1)+" "+(IsElevated()?"ADMIN":"STANDARD");
      default: throw new ArgumentException("unsupported command");
    }
    return null;
  }

  static bool IsElevated() {
    var identity=WindowsIdentity.GetCurrent();
    return new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
  }

  static int ParentProcessId(Process process) {
    var information=new PROCESS_BASIC_INFORMATION(); int returned;
    if(NtQueryInformationProcess(process.Handle,0,ref information,Marshal.SizeOf(information),out returned)!=0) return 0;
    return information.InheritedFromUniqueProcessId.ToInt32();
  }

  static bool IsAuthorizedClient(NamedPipeServerStream pipe, string expectedAgentPath) {
    uint clientId;
    if(!GetNamedPipeClientProcessId(pipe.SafePipeHandle,out clientId)) return false;
    var processId=(int)clientId;
    // Portable Electron adds a wrapper and the standard-user pipe client adds
    // one more process. Walk only a short, fixed ancestor chain and require an
    // exact match with the protected Agent path registered at installation.
    for(var depth=0;depth<5 && processId>0;depth++) {
      try {
        using(var process=Process.GetProcessById(processId)) {
          if(string.Equals(process.MainModule.FileName,expectedAgentPath,StringComparison.OrdinalIgnoreCase)) return true;
          processId=ParentProcessId(process);
        }
      } catch { return false; }
    }
    return false;
  }

  static PipeSecurity CreatePipeSecurity() {
    var security=new PipeSecurity();
    var user=WindowsIdentity.GetCurrent().User;
    security.SetOwner(user);
    security.AddAccessRule(new PipeAccessRule(user,PipeAccessRights.ReadWrite,AccessControlType.Allow));
    security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid,null),PipeAccessRights.FullControl,AccessControlType.Allow));
    security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid,null),PipeAccessRights.FullControl,AccessControlType.Allow));
    return security;
  }

  static void ProcessStream(Stream input, Stream output, string readyMessage) {
    using(var reader=new StreamReader(input,Encoding.UTF8,false,4096,true))
    using(var writer=new StreamWriter(output,new UTF8Encoding(false),4096,true)) {
      writer.AutoFlush=true; writer.WriteLine(readyMessage);
      string line;
      while((line=reader.ReadLine())!=null) {
        try { var response=Execute(line); if(response!=null) writer.WriteLine(response); }
        catch(Exception error) { writer.WriteLine("ERROR "+error.Message); }
      }
    }
  }

  static void RunPipe(string pipeName, string expectedAgentPath) {
    while(true) {
      using(var pipe=new NamedPipeServerStream(pipeName,PipeDirection.InOut,1,PipeTransmissionMode.Byte,PipeOptions.Asynchronous,4096,4096,CreatePipeSecurity())) {
        pipe.WaitForConnection();
        if(!IsAuthorizedClient(pipe,Path.GetFullPath(expectedAgentPath))) { pipe.Disconnect(); continue; }
        ProcessStream(pipe,pipe,"READY "+(IsElevated()?"ADMIN":"STANDARD"));
      }
    }
  }

  static void RunClient(string pipeName) {
    using(var pipe=new NamedPipeClientStream(".",pipeName,PipeDirection.InOut,PipeOptions.None)) {
      pipe.Connect(900);
      using(var pipeReader=new StreamReader(pipe,Encoding.UTF8,false,4096,true))
      using(var pipeWriter=new StreamWriter(pipe,new UTF8Encoding(false),4096,true))
      using(var input=new StreamReader(Console.OpenStandardInput(),Encoding.UTF8,false,4096,true))
      using(var output=new StreamWriter(Console.OpenStandardOutput(),new UTF8Encoding(false),4096,true)) {
        pipeWriter.AutoFlush=true; output.AutoFlush=true;
        var greeting=pipeReader.ReadLine();
        if(greeting==null || !greeting.StartsWith("READY ")) throw new IOException("broker handshake failed");
        output.WriteLine(greeting+" CLIENT_"+(IsElevated()?"ADMIN":"STANDARD"));
        string line;
        while((line=input.ReadLine())!=null) {
          pipeWriter.WriteLine(line);
          if(line=="PING") {
            var response=pipeReader.ReadLine();
            if(response==null) throw new IOException("broker disconnected");
            output.WriteLine(response);
          }
        }
      }
    }
  }

  static void Main(string[] args) {
    if(args.Length==1 && args[0]=="--check") { Console.WriteLine("INPUT_HOST_OK"); return; }
    if(args.Length==3 && args[0]=="--pipe") { RunPipe(args[1],args[2]); return; }
    if(args.Length==2 && args[0]=="--client") { RunClient(args[1]); return; }
    ProcessStream(Console.OpenStandardInput(),Console.OpenStandardOutput(),"READY "+(IsElevated()?"ADMIN":"STANDARD"));
  }
}
