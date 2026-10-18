$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class PultNative {
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  public const uint MOVE = 0x0001;
  public const uint LEFTDOWN = 0x0002;
  public const uint LEFTUP = 0x0004;
  public const uint RIGHTDOWN = 0x0008;
  public const uint RIGHTUP = 0x0010;
  public const uint MIDDLEDOWN = 0x0020;
  public const uint MIDDLEUP = 0x0040;
  public const uint WHEEL = 0x0800;
  public const uint KEYUP = 0x0002;
}
"@

function Reply($id, $ok, $extra) {
  $payload = @{ id = $id; ok = $ok }
  if ($extra) { foreach ($key in $extra.Keys) { $payload[$key] = $extra[$key] } }
  [Console]::Out.WriteLine(($payload | ConvertTo-Json -Compress -Depth 5))
  [Console]::Out.Flush()
}

function Vk([string]$key) {
  switch ($key) {
    'enter' { 13 } 'escape' { 27 } 'tab' { 9 } 'backspace' { 8 } 'space' { 32 }
    'left' { 37 } 'up' { 38 } 'right' { 39 } 'down' { 40 }
    'ctrl' { 17 } 'alt' { 18 } 'shift' { 16 } 'win' { 91 } 'meta' { 91 }
    'f1' { 112 } 'f2' { 113 } 'f3' { 114 } 'f4' { 115 } 'f5' { 116 } 'f6' { 117 }
    'f7' { 118 } 'f8' { 119 } 'f9' { 120 } 'f10' { 121 } 'f11' { 122 } 'f12' { 123 }
    default {
      if ($key.Length -eq 1) { [int][char]::ToUpperInvariant($key[0]) } else { 0 }
    }
  }
}

while ($null -ne ($line = [Console]::In.ReadLine())) {
  $cmd = $null
  try {
    $cmd = $line | ConvertFrom-Json
    switch ($cmd.op) {
      'ping' { Reply $cmd.id $true @{} }
      'capture' {
        $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
        $bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
        $graphics = [System.Drawing.Graphics]::FromImage($bmp)
        $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
        $width = [Math]::Min(1280, $bounds.Width)
        $height = [Math]::Max(1, [int]($bounds.Height * ($width / [double]$bounds.Width)))
        $small = New-Object System.Drawing.Bitmap $width, $height
        $scaled = [System.Drawing.Graphics]::FromImage($small)
        $scaled.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBilinear
        $scaled.DrawImage($bmp, 0, 0, $width, $height)
        $stream = New-Object System.IO.MemoryStream
        $encoder = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
        $params = New-Object System.Drawing.Imaging.EncoderParameters 1
        $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality, [long]45)
        $small.Save($stream, $encoder, $params)
        $graphics.Dispose(); $scaled.Dispose(); $bmp.Dispose(); $small.Dispose()
        Reply $cmd.id $true @{ width = $width; height = $height; jpeg = [Convert]::ToBase64String($stream.ToArray()) }
      }
      'move' { [PultNative]::mouse_event([PultNative]::MOVE, [int]$cmd.dx, [int]$cmd.dy, 0, [UIntPtr]::Zero); Reply $cmd.id $true @{} }
      'click' {
        $down = [PultNative]::LEFTDOWN; $up = [PultNative]::LEFTUP
        if ($cmd.button -eq 'right') { $down = [PultNative]::RIGHTDOWN; $up = [PultNative]::RIGHTUP }
        if ($cmd.button -eq 'middle') { $down = [PultNative]::MIDDLEDOWN; $up = [PultNative]::MIDDLEUP }
        $count = [Math]::Max(1, [int]$cmd.count)
        for ($i = 0; $i -lt $count; $i++) {
          [PultNative]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero)
          [PultNative]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero)
        }
        Reply $cmd.id $true @{}
      }
      'scroll' { [PultNative]::mouse_event([PultNative]::WHEEL, 0, 0, [uint32]([int]$cmd.dy * 120), [UIntPtr]::Zero); Reply $cmd.id $true @{} }
      'key' {
        $vk = Vk $cmd.key
        if ($vk -eq 0) { throw 'Неизвестная клавиша' }
        $flags = $(if ($cmd.down) { 0 } else { [PultNative]::KEYUP })
        [PultNative]::keybd_event([byte]$vk, 0, [uint32]$flags, [UIntPtr]::Zero)
        Reply $cmd.id $true @{}
      }
      'text' {
        foreach ($char in $cmd.text.ToCharArray()) {
          $vk = Vk ([string]$char)
          if ($vk -gt 0 -and $vk -lt 256) {
            [PultNative]::keybd_event([byte]$vk, 0, 0, [UIntPtr]::Zero)
            [PultNative]::keybd_event([byte]$vk, 0, [PultNative]::KEYUP, [UIntPtr]::Zero)
          }
        }
        Reply $cmd.id $true @{}
      }
      'volume' {
        Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int RegisterControlChangeNotify(IntPtr a); int UnregisterControlChangeNotify(IntPtr a);
  int GetChannelCount(out uint c);
  int SetMasterVolumeLevel(float v, ref Guid g); int SetMasterVolumeLevelScalar(float v, ref Guid g);
  int GetMasterVolumeLevel(out float v); int GetMasterVolumeLevelScalar(out float v);
  int SetChannelVolumeLevel(uint c, float v, ref Guid g); int SetChannelVolumeLevelScalar(uint c, float v, ref Guid g);
  int GetChannelVolumeLevel(uint c, out float v); int GetChannelVolumeLevelScalar(uint c, out float v);
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool m, ref Guid g); int GetMute(out bool m);
  int GetVolumeStepInfo(out uint a, out uint b); int VolumeStepUp(ref Guid g); int VolumeStepDown(ref Guid g);
  int QueryHardwareSupport(out uint a); int GetVolumeRange(out float a, out float b, out float c);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
  int Activate(ref Guid id, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object v);
}
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
  int EnumAudioEndpoints(int flow, int mask, IntPtr devices);
  int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice device);
}
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator { }
public static class PultVolume {
  public static IAudioEndpointVolume Endpoint() {
    var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
    IMMDevice device; enumerator.GetDefaultAudioEndpoint(0, 1, out device);
    var iid = typeof(IAudioEndpointVolume).GUID; object result;
    device.Activate(ref iid, 23, IntPtr.Zero, out result);
    return (IAudioEndpointVolume)result;
  }
}
"@ -ErrorAction SilentlyContinue
        $endpoint = [PultVolume]::Endpoint()
        $guid = [Guid]::Empty
        if ($null -ne $cmd.level) { [void]$endpoint.SetMasterVolumeLevelScalar([float]$cmd.level / 100.0, [ref]$guid) }
        if ($null -ne $cmd.muted) { [void]$endpoint.SetMute([bool]$cmd.muted, [ref]$guid) }
        $level = 0.0; $muted = $false
        [void]$endpoint.GetMasterVolumeLevelScalar([ref]$level)
        [void]$endpoint.GetMute([ref]$muted)
        Reply $cmd.id $true @{ level = [int][Math]::Round($level * 100); muted = [bool]$muted }
      }
      'media' {
        $vk = switch ($cmd.action) { 'next' { 0xB0 } 'previous' { 0xB1 } default { 0xB3 } }
        [PultNative]::keybd_event([byte]$vk, 0, 0, [UIntPtr]::Zero)
        [PultNative]::keybd_event([byte]$vk, 0, [PultNative]::KEYUP, [UIntPtr]::Zero)
        Reply $cmd.id $true @{}
      }
      'media-state' {
        $title = ''
        $proc = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -and $_.ProcessName -match 'Spotify|Music|chrome|msedge' } | Select-Object -First 1
        if ($proc) { $title = $proc.MainWindowTitle }
        Reply $cmd.id $true @{ title = $title; app = $(if ($proc) { $proc.ProcessName } else { '' }) }
      }
      'apps' {
        $roots = @(
          "$env:ProgramData\Microsoft\Windows\Start Menu\Programs",
          "$env:APPDATA\Microsoft\Windows\Start Menu\Programs"
        )
        $running = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | ForEach-Object { $_.ProcessName })
        $apps = @()
        foreach ($root in $roots) {
          if (-not (Test-Path $root)) { continue }
          Get-ChildItem $root -Recurse -Filter *.lnk -ErrorAction SilentlyContinue | Select-Object -First 80 | ForEach-Object {
            $apps += @{ id = $_.FullName; name = $_.BaseName; running = ($running -contains $_.BaseName) }
          }
        }
        Reply $cmd.id $true @{ apps = $apps }
      }
      'launch' { Start-Process -FilePath $cmd.id; Reply $cmd.id $true @{} }
      'clipboard-get' { Reply $cmd.id $true @{ text = [string](Get-Clipboard -Raw) } }
      'clipboard-set' { Set-Clipboard -Value ([string]$cmd.text); Reply $cmd.id $true @{} }
      'notifications' { Reply $cmd.id $true @{ items = @() } }
      'power' {
        switch ($cmd.action) {
          'sleep' { Start-Process rundll32.exe -ArgumentList 'powrprof.dll,SetSuspendState 0,1,0' }
          'lock' { Start-Process rundll32.exe -ArgumentList 'user32.dll,LockWorkStation' }
          'restart' { Start-Process shutdown.exe -ArgumentList '/r','/t','0' }
          'shutdown' { Start-Process shutdown.exe -ArgumentList '/s','/t','0' }
          default { throw 'Неизвестное действие питания' }
        }
        Reply $cmd.id $true @{}
      }
      default { throw 'Неизвестная команда помощника' }
    }
  } catch {
    $id = if ($cmd) { $cmd.id } else { 0 }
    Reply $id $false @{ error = $_.Exception.Message }
  }
}
