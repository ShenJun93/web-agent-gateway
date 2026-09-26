import { spawn } from 'node:child_process';
import { sanitizeLocalMachineEnvironment } from '../environment-policy.js';
import type {
  DesktopBackend,
  DesktopBackendNode,
  DesktopBackendSession,
  DesktopPattern,
  DesktopTargetIdentity,
} from './desktop-port.js';

const MAX_BRIDGE_OUTPUT_BYTES = 4 * 1024 * 1024;
const BRIDGE_TIMEOUT_MS = 20_000;
const MAX_NODES = 500;

export interface WindowsUiaBridgeClient {
  request(value: Record<string, unknown>): Promise<unknown>;
}

export interface ResolvedWindowsDesktopWindow {
  readonly hwndHex: string;
  readonly title: string;
}

const WINDOWS_UIA_BRIDGE = String.raw`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing

$native = @"
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class WagDesktopNative {
  private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [StructLayout(LayoutKind.Sequential)]
  private struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  [DllImport("user32.dll")]
  private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

  [DllImport("user32.dll")]
  private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

  [DllImport("user32.dll")]
  private static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll")]
  private static extern IntPtr GetWindow(IntPtr hWnd, uint command);

  [DllImport("user32.dll")]
  private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int GetWindowTextLength(IntPtr hWnd);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);

  [DllImport("user32.dll")]
  private static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint flags);

  public static long[] VisibleTopLevelWindowsForProcess(int pid) {
    var result = new List<long>();
    EnumWindows((hWnd, _) => {
      uint ownerPid;
      GetWindowThreadProcessId(hWnd, out ownerPid);
      if (ownerPid != (uint)pid || !IsWindowVisible(hWnd) || GetWindow(hWnd, 4) != IntPtr.Zero) {
        return true;
      }
      RECT rect;
      if (!GetWindowRect(hWnd, out rect) || rect.Right <= rect.Left || rect.Bottom <= rect.Top) {
        return true;
      }
      result.Add(hWnd.ToInt64());
      return true;
    }, IntPtr.Zero);
    return result.ToArray();
  }

  public static string WindowTitle(long handle) {
    var hWnd = new IntPtr(handle);
    var length = Math.Max(0, GetWindowTextLength(hWnd));
    var buffer = new StringBuilder(length + 1);
    GetWindowText(hWnd, buffer, buffer.Capacity);
    return buffer.ToString();
  }

  private static byte[] EncodePng(Bitmap bitmap) {
    using (var stream = new MemoryStream()) {
      bitmap.Save(stream, ImageFormat.Png);
      return stream.ToArray();
    }
  }

  private static bool HasVisualVariance(Bitmap bitmap) {
    var colors = new HashSet<int>();
    var xSteps = Math.Min(16, Math.Max(2, bitmap.Width));
    var ySteps = Math.Min(16, Math.Max(2, bitmap.Height));
    for (var yi = 0; yi < ySteps; yi++) {
      var y = (int)Math.Round((bitmap.Height - 1) * (yi / (double)(ySteps - 1)));
      for (var xi = 0; xi < xSteps; xi++) {
        var x = (int)Math.Round((bitmap.Width - 1) * (xi / (double)(xSteps - 1)));
        colors.Add(bitmap.GetPixel(x, y).ToArgb() & 0x00FFFFFF);
        if (colors.Count >= 3) return true;
      }
    }
    return false;
  }

  private static byte[] CapturePrintWindow(IntPtr hWnd, int width, int height, uint flags) {
    using (var bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb))
    using (var graphics = Graphics.FromImage(bitmap)) {
      IntPtr hdc = graphics.GetHdc();
      bool printed;
      try {
        printed = PrintWindow(hWnd, hdc, flags);
      } finally {
        graphics.ReleaseHdc(hdc);
      }
      if (!printed || !HasVisualVariance(bitmap)) return Array.Empty<byte>();
      return EncodePng(bitmap);
    }
  }

  private static byte[] CaptureScreenRect(RECT rect, int width, int height) {
    using (var bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb))
    using (var graphics = Graphics.FromImage(bitmap)) {
      graphics.CopyFromScreen(
        rect.Left,
        rect.Top,
        0,
        0,
        new Size(width, height),
        CopyPixelOperation.SourceCopy
      );
      if (!HasVisualVariance(bitmap)) return Array.Empty<byte>();
      return EncodePng(bitmap);
    }
  }

  public static string CaptureWindowPngBase64(long handle) {
    var hWnd = new IntPtr(handle);
    RECT rect;
    if (!GetWindowRect(hWnd, out rect)) {
      throw new InvalidOperationException("window rectangle unavailable");
    }
    var width = rect.Right - rect.Left;
    var height = rect.Bottom - rect.Top;
    if (width <= 0 || height <= 0 || width > 16384 || height > 16384) {
      throw new InvalidOperationException("window dimensions are invalid");
    }

    var bytes = CapturePrintWindow(hWnd, width, height, 2);
    if (bytes.Length == 0) bytes = CapturePrintWindow(hWnd, width, height, 0);
    if (bytes.Length == 0) bytes = CaptureScreenRect(rect, width, height);
    if (bytes.Length == 0) {
      throw new InvalidOperationException("window capture produced no visual variance");
    }
    return Convert.ToBase64String(bytes);
  }
}
"@
Add-Type -TypeDefinition $native -ReferencedAssemblies 'System.Drawing.dll'

function Convert-HwndHexToInt64([string]$Value) {
  if ($Value.Length -lt 1 -or $Value.Length -gt 16 -or $Value -match '[^0-9A-Fa-f]') {
    throw 'invalid hwnd'
  }
  return [Convert]::ToInt64($Value, 16)
}

function Get-AutomationRoot([string]$HwndHex) {
  $handle = [IntPtr](Convert-HwndHexToInt64 $HwndHex)
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
  if ($null -eq $root) { throw 'UI Automation root unavailable' }
  return $root
}

function Get-BackendId($Element) {
  try {
    $ids = $Element.GetRuntimeId()
    if ($null -eq $ids -or $ids.Length -eq 0) { return $null }
    return 'uia:' + (($ids | ForEach-Object { [string]$_ }) -join ',')
  } catch {
    return $null
  }
}

function Get-ControlElements($Root) {
  $result = New-Object System.Collections.ArrayList
  try {
    $all = $Root.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.Automation]::ControlViewCondition
    )
    if ($all.Count -eq 0) {
      $all = $Root.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Automation]::RawViewCondition
      )
    }
    for ($index = 0; $index -lt $all.Count -and $result.Count -lt 500; $index += 1) {
      $element = $all.Item($index)
      if ($null -ne $element) {
        [void]$result.Add($element)
      }
    }
  } catch {}
  return ,$result.ToArray()
}

function Get-Pattern($Element, $PatternId) {
  $pattern = $null
  try {
    if ($Element.TryGetCurrentPattern($PatternId, [ref]$pattern)) { return $pattern }
  } catch {}
  return $null
}

function Get-ElementByBackendId($Root, [string]$BackendId) {
  if ((-not $BackendId.StartsWith('uia:')) -or ($BackendId.Length -gt 512) -or
      ($BackendId.Substring(4) -match '[^0-9,-]')) {
    throw 'invalid backend element id'
  }
  foreach ($element in (Get-ControlElements $Root)) {
    if ((Get-BackendId $element) -eq $BackendId) { return $element }
  }
  throw 'UI Automation element is stale or unavailable'
}

function Get-Snapshot($Root) {
  $nodes = New-Object System.Collections.ArrayList
  foreach ($element in (Get-ControlElements $Root)) {
    $backendId = Get-BackendId $element
    if ($null -eq $backendId) { continue }

    try {
      $controlName = [string]$element.Current.ControlType.ProgrammaticName
      if ($controlName.StartsWith('ControlType.')) {
        $controlName = $controlName.Substring(12)
      }
      if ($controlName.Length -gt 0) {
        $controlName = $controlName.Substring(0, 1).ToLowerInvariant() + $controlName.Substring(1)
      }
      $name = [string]$element.Current.Name
      $enabled = [bool]$element.Current.IsEnabled
    } catch {
      continue
    }

    $patterns = New-Object System.Collections.ArrayList
    $value = $null

    $invoke = Get-Pattern $element ([System.Windows.Automation.InvokePattern]::Pattern)
    if ($null -ne $invoke) { [void]$patterns.Add('Invoke') }

    $valuePattern = Get-Pattern $element ([System.Windows.Automation.ValuePattern]::Pattern)
    if ($null -ne $valuePattern) {
      [void]$patterns.Add('Value')
      try { $value = [string]$valuePattern.Current.Value } catch {}
    }

    $toggle = Get-Pattern $element ([System.Windows.Automation.TogglePattern]::Pattern)
    if ($null -ne $toggle) { [void]$patterns.Add('Toggle') }

    $selectionItem = Get-Pattern $element ([System.Windows.Automation.SelectionItemPattern]::Pattern)
    if ($null -ne $selectionItem) { [void]$patterns.Add('SelectionItem') }

    [void]$nodes.Add([pscustomobject]@{
      backendElementId = $backendId
      role = $controlName
      name = $name
      value = $value
      enabled = $enabled
      patterns = @($patterns)
    })
    if ($nodes.Count -ge 500) { break }
  }
  return $nodes.ToArray()
}

$requestText = [Console]::In.ReadToEnd()
if ([string]::IsNullOrWhiteSpace($requestText)) { throw 'missing bridge request' }
$request = $requestText | ConvertFrom-Json
$op = [string]$request.op

switch ($op) {
  'resolveWindow' {
    $pidValue = [int]$request.pid
    if ($pidValue -le 0) { throw 'invalid pid' }
    $windows = [WagDesktopNative]::VisibleTopLevelWindowsForProcess($pidValue)
    if ($windows.Length -eq 0) { throw 'owned process has no visible top-level window' }
    if ($windows.Length -ne 1) { throw 'owned process has multiple visible top-level windows' }
    $handle = [int64]$windows[0]
    $result = [pscustomobject]@{
      hwndHex = $handle.ToString('X')
      title = [WagDesktopNative]::WindowTitle($handle)
    }
  }
  'snapshot' {
    $root = Get-AutomationRoot ([string]$request.hwndHex)
    $result = [pscustomobject]@{ nodes = @(Get-Snapshot $root) }
  }
  'invoke' {
    $root = Get-AutomationRoot ([string]$request.hwndHex)
    $element = Get-ElementByBackendId $root ([string]$request.backendElementId)
    $pattern = Get-Pattern $element ([System.Windows.Automation.InvokePattern]::Pattern)
    if ($null -eq $pattern) { throw 'Invoke pattern unavailable' }
    $pattern.Invoke()
    $result = [pscustomobject]@{ ok = $true }
  }
  'setValue' {
    $root = Get-AutomationRoot ([string]$request.hwndHex)
    $element = Get-ElementByBackendId $root ([string]$request.backendElementId)
    $pattern = Get-Pattern $element ([System.Windows.Automation.ValuePattern]::Pattern)
    if ($null -eq $pattern) { throw 'Value pattern unavailable' }
    if ([bool]$pattern.Current.IsReadOnly) { throw 'Value pattern is read-only' }
    $pattern.SetValue([string]$request.value)
    $result = [pscustomobject]@{ ok = $true }
  }
  'toggle' {
    $root = Get-AutomationRoot ([string]$request.hwndHex)
    $element = Get-ElementByBackendId $root ([string]$request.backendElementId)
    $pattern = Get-Pattern $element ([System.Windows.Automation.TogglePattern]::Pattern)
    if ($null -eq $pattern) { throw 'Toggle pattern unavailable' }
    $pattern.Toggle()
    $result = [pscustomobject]@{ ok = $true }
  }
  'select' {
    $root = Get-AutomationRoot ([string]$request.hwndHex)
    $element = Get-ElementByBackendId $root ([string]$request.backendElementId)
    $pattern = Get-Pattern $element ([System.Windows.Automation.SelectionItemPattern]::Pattern)
    if ($null -eq $pattern) { throw 'SelectionItem pattern unavailable' }
    $pattern.Select()
    $result = [pscustomobject]@{ ok = $true }
  }
  'screenshot' {
    $handle = Convert-HwndHexToInt64 ([string]$request.hwndHex)
    $result = [pscustomobject]@{
      mimeType = 'image/png'
      dataBase64 = [WagDesktopNative]::CaptureWindowPngBase64($handle)
    }
  }
  default {
    throw 'unsupported bridge operation'
  }
}

[Console]::Out.Write(($result | ConvertTo-Json -Depth 8 -Compress))
`;

function boundedString(value: unknown, maxBytes: number): string {
  if (typeof value !== 'string') throw new Error('Windows UIA bridge returned invalid text');
  if (value.includes('\0') || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new Error('Windows UIA bridge returned oversized text');
  }
  return value;
}

function parseHwnd(nativeWindowId: string): string {
  const match = /^hwnd:([0-9A-Fa-f]{1,16})$/.exec(nativeWindowId);
  if (!match) throw new Error('Desktop native window id is invalid');
  return match[1]!;
}

async function runPowerShellBridge(value: Record<string, unknown>): Promise<unknown> {
  if (process.platform !== 'win32') {
    throw new Error('Windows UI Automation backend is available only on Windows');
  }
  const payload = JSON.stringify(value);
  if (Buffer.byteLength(payload, 'utf8') > 256 * 1024) {
    throw new Error('Windows UI Automation bridge request is oversized');
  }

  return await new Promise<unknown>((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-STA',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      WINDOWS_UIA_BRIDGE,
    ], {
      env: sanitizeLocalMachineEnvironment(process.env),
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdoutChunks: Uint8Array[] = [];
    const stderrChunks: Uint8Array[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finish = (error?: Error, result?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };

    const append = (chunks: Uint8Array[], chunk: Uint8Array, currentBytes: number): number => {
      const nextBytes = currentBytes + chunk.byteLength;
      if (nextBytes > MAX_BRIDGE_OUTPUT_BYTES) {
        child.kill();
        finish(new Error('Windows UI Automation bridge output exceeded limit'));
        return currentBytes;
      }
      chunks.push(chunk);
      return nextBytes;
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes = append(stdoutChunks, chunk, stdoutBytes);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes = append(stderrChunks, chunk, stderrBytes);
    });
    child.once('error', () => finish(new Error('Windows UI Automation bridge failed to start')));
    child.once('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        const detail = Buffer.concat(stderrChunks).toString('utf8')
          .replace(/[\r\n]+/g, ' ').trim().slice(0, 240);
        finish(new Error(detail
          ? `Windows UI Automation bridge failed: ${detail}`
          : 'Windows UI Automation bridge failed'));
        return;
      }
      try {
        finish(undefined, JSON.parse(Buffer.concat(stdoutChunks).toString('utf8')));
      } catch {
        finish(new Error('Windows UI Automation bridge returned invalid JSON'));
      }
    });

    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('Windows UI Automation bridge timed out'));
    }, BRIDGE_TIMEOUT_MS);

    child.stdin.end(payload);
  });
}

export function createPowerShellWindowsUiaBridgeClient(): WindowsUiaBridgeClient {
  return Object.freeze({ request: runPowerShellBridge });
}

export async function resolveWindowsDesktopWindow(
  bridge: WindowsUiaBridgeClient,
  pid: number,
): Promise<ResolvedWindowsDesktopWindow> {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('Desktop process pid is invalid');
  const raw = await bridge.request({ op: 'resolveWindow', pid });
  if (!raw || typeof raw !== 'object') throw new Error('Windows UIA bridge returned invalid window');
  const value = raw as { hwndHex?: unknown; title?: unknown };
  const hwndHex = boundedString(value.hwndHex, 32);
  if (!/^[0-9A-Fa-f]{1,16}$/.test(hwndHex)) throw new Error('Windows UIA bridge returned invalid hwnd');
  const title = boundedString(value.title, 4096);
  return Object.freeze({ hwndHex: hwndHex.toUpperCase(), title });
}

function parsePatterns(value: unknown): readonly DesktopPattern[] {
  if (!Array.isArray(value) || value.length > 8) throw new Error('Windows UIA bridge returned invalid patterns');
  const allowed = new Set<DesktopPattern>(['Invoke', 'Value', 'Toggle', 'SelectionItem']);
  const result: DesktopPattern[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !allowed.has(item as DesktopPattern)) {
      throw new Error('Windows UIA bridge returned unsupported pattern');
    }
    if (!result.includes(item as DesktopPattern)) result.push(item as DesktopPattern);
  }
  return Object.freeze(result);
}

function parseNodes(raw: unknown): readonly DesktopBackendNode[] {
  if (!raw || typeof raw !== 'object') throw new Error('Windows UIA bridge returned invalid snapshot');
  const rows = (raw as { nodes?: unknown }).nodes;
  if (!Array.isArray(rows) || rows.length > MAX_NODES) {
    throw new Error('Windows UIA bridge returned invalid node count');
  }
  return Object.freeze(rows.map((row): DesktopBackendNode => {
    if (!row || typeof row !== 'object') throw new Error('Windows UIA bridge returned invalid node');
    const value = row as {
      backendElementId?: unknown;
      role?: unknown;
      name?: unknown;
      value?: unknown;
      enabled?: unknown;
      patterns?: unknown;
    };
    const backendElementId = boundedString(value.backendElementId, 512);
    if (!/^uia:-?[0-9]+(?:,-?[0-9]+)*$/.test(backendElementId)) {
      throw new Error('Windows UIA bridge returned invalid element identity');
    }
    const role = boundedString(value.role, 512);
    const name = boundedString(value.name, 4096);
    if (typeof value.enabled !== 'boolean') throw new Error('Windows UIA bridge returned invalid enabled state');
    const patterns = parsePatterns(value.patterns);
    const elementValue = value.value == null ? undefined : boundedString(value.value, 64 * 1024);
    return Object.freeze({
      backendElementId,
      role,
      name,
      ...(elementValue === undefined ? {} : { value: elementValue }),
      enabled: value.enabled,
      patterns,
    });
  }));
}

export function createWindowsUiaDesktopBackend(options: {
  bridge?: WindowsUiaBridgeClient;
} = {}): DesktopBackend {
  const bridge = options.bridge ?? createPowerShellWindowsUiaBridgeClient();

  return {
    async open(target: DesktopTargetIdentity): Promise<DesktopBackendSession> {
      const hwndHex = parseHwnd(target.nativeWindowId);
      return {
        async snapshot() {
          return parseNodes(await bridge.request({ op: 'snapshot', hwndHex }));
        },
        async invoke(backendElementId) {
          await bridge.request({ op: 'invoke', hwndHex, backendElementId });
        },
        async setValue(backendElementId, value) {
          await bridge.request({ op: 'setValue', hwndHex, backendElementId, value });
        },
        async toggle(backendElementId) {
          await bridge.request({ op: 'toggle', hwndHex, backendElementId });
        },
        async select(backendElementId) {
          await bridge.request({ op: 'select', hwndHex, backendElementId });
        },
        async screenshot() {
          const raw = await bridge.request({ op: 'screenshot', hwndHex });
          if (!raw || typeof raw !== 'object') throw new Error('Windows UIA bridge returned invalid screenshot');
          const value = raw as { mimeType?: unknown; dataBase64?: unknown };
          if (value.mimeType !== 'image/png' || typeof value.dataBase64 !== 'string'
              || value.dataBase64.length < 1 || value.dataBase64.length > 16 * 1024 * 1024
              || !/^[A-Za-z0-9+/=]+$/.test(value.dataBase64)) {
            throw new Error('Windows UIA bridge returned invalid screenshot');
          }
          return { mimeType: 'image/png' as const, dataBase64: value.dataBase64 };
        },
        async close() {
          // DesktopPort owns the automation session, not the application process. Process lifetime
          // remains under machine.process.* ownership and is never changed by desktop.close.
        },
      };
    },
  };
}
