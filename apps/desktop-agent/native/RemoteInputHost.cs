using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

class RemoteInputHost {
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);

  const uint MOUSE_MOVE=0x0001, MOUSE_LEFTDOWN=0x0002, MOUSE_LEFTUP=0x0004, MOUSE_RIGHTDOWN=0x0008, MOUSE_RIGHTUP=0x0010;
  const uint MOUSE_MIDDLEDOWN=0x0020, MOUSE_MIDDLEUP=0x0040, MOUSE_WHEEL=0x0800;
  const uint MOUSE_ABSOLUTE=0x8000, MOUSE_VIRTUALDESK=0x4000;
  const uint KEYUP=0x0002, UNICODE=0x0004;
  const uint INPUT_MOUSE=0, INPUT_KEYBOARD=1;

  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public InputUnion u; }
  [StructLayout(LayoutKind.Explicit)] struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, flags, time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort vk, scan; public uint flags, time; public UIntPtr extra; }

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
    {"Up",0x26},{"Right",0x27},{"Down",0x28},{"LeftShift",0x10},{"LeftControl",0x11},{"LeftAlt",0x12},
    {"LeftMeta",0x5B},{"CapsLock",0x14},{"Comma",0xBC},{"Period",0xBE},{"Slash",0xBF},{"Backslash",0xDC},
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
    int f;
    if (name.StartsWith("F") && int.TryParse(name.Substring(1), out f) && f>=1 && f<=24) return (byte)(0x6F+f);
    throw new ArgumentException("unsupported key");
  }

  static void Execute(string line) {
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
      case "PING": Console.WriteLine("PONG "+GetSystemMetrics(0)+" "+GetSystemMetrics(1)); break;
    }
  }

  static void Main() {
    Console.OutputEncoding=Encoding.UTF8; Console.WriteLine("READY");
    string line; while((line=Console.ReadLine())!=null) { try { Execute(line); } catch(Exception ex) { Console.WriteLine("ERROR "+ex.Message); } }
  }
}
