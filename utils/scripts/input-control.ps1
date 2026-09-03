param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('move', 'click', 'scroll', 'type', 'key', 'bounds', 'dragdrop', 'clipget', 'clipset')]
  [string]$Op,

  [int]$X,
  [int]$Y,
  [ValidateSet('left', 'right', 'middle')]
  [string]$Button = 'left',
  [switch]$Double,
  [int]$Delta = 0,
  [string]$Text,
  [string]$Keys,
  [int]$FromX,
  [int]$FromY,
  [int]$ToX,
  [int]$ToY
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;

public class JarvisInput {
    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, UIntPtr dwExtraInfo);

    public const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004;
    public const uint RIGHTDOWN = 0x0008, RIGHTUP = 0x0010;
    public const uint MIDDLEDOWN = 0x0020, MIDDLEUP = 0x0040;
    public const uint WHEEL = 0x0800;
}
"@

function Get-VirtualBounds {
  $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
  [PSCustomObject]@{ left = $b.Left; top = $b.Top; width = $b.Width; height = $b.Height }
}

function Assert-InBounds([int]$px, [int]$py) {
  $b = Get-VirtualBounds
  if ($px -lt $b.left -or $px -gt ($b.left + $b.width) -or $py -lt $b.top -or $py -gt ($b.top + $b.height)) {
    throw "Coordinates ($px, $py) are outside the visible screen area ($($b.width)x$($b.height))."
  }
}

# SendKeys requires +^%~(){}[] to be escaped by wrapping in braces.
function Escape-SendKeys([string]$s) {
  $sb = New-Object System.Text.StringBuilder
  foreach ($ch in $s.ToCharArray()) {
    if ('+^%~(){}[]' -match [regex]::Escape([string]$ch)) {
      [void]$sb.Append('{').Append($ch).Append('}')
    } else {
      [void]$sb.Append($ch)
    }
  }
  $sb.ToString()
}

switch ($Op) {
  'bounds' {
    (Get-VirtualBounds) | ConvertTo-Json -Compress
  }
  'move' {
    Assert-InBounds $X $Y
    [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point($X, $Y)
    '{"ok":true,"op":"move"}'
  }
  'click' {
    if ($PSBoundParameters.ContainsKey('X') -and $PSBoundParameters.ContainsKey('Y')) {
      Assert-InBounds $X $Y
      [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point($X, $Y)
    }
    $down = switch ($Button) { 'right' { [JarvisInput]::RIGHTDOWN } 'middle' { [JarvisInput]::MIDDLEDOWN } default { [JarvisInput]::LEFTDOWN } }
    $up   = switch ($Button) { 'right' { [JarvisInput]::RIGHTUP }   'middle' { [JarvisInput]::MIDDLEUP }   default { [JarvisInput]::LEFTUP } }
    [JarvisInput]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero)
    [JarvisInput]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero)
    if ($Double) {
      Start-Sleep -Milliseconds 60
      [JarvisInput]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero)
      [JarvisInput]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero)
    }
    ([PSCustomObject]@{ ok = $true; op = 'click'; button = $Button; double = [bool]$Double }) | ConvertTo-Json -Compress
  }
  'scroll' {
    if ($PSBoundParameters.ContainsKey('X') -and $PSBoundParameters.ContainsKey('Y')) {
      Assert-InBounds $X $Y
      [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point($X, $Y)
    }
    [JarvisInput]::mouse_event([JarvisInput]::WHEEL, 0, 0, [uint32]($Delta * 120), [UIntPtr]::Zero)
    '{"ok":true,"op":"scroll"}'
  }
  'type' {
    [System.Windows.Forms.SendKeys]::SendWait((Escape-SendKeys $Text))
    '{"ok":true,"op":"type"}'
  }
  'key' {
    # Raw SendKeys notation, e.g. "^c" (ctrl+c), "{ENTER}", "%{F4}" (alt+F4).
    # Not escaped — this is the "I know exactly what key combo I want" path.
    [System.Windows.Forms.SendKeys]::SendWait($Keys)
    '{"ok":true,"op":"key"}'
  }
  'dragdrop' {
    # Press at (FromX,FromY), move through intermediate points, release at
    # (ToX,ToY). The step-by-step move (not a single teleport) matters —
    # HTML5 drag-and-drop and many custom UI drag handlers only start
    # tracking a drag once they see mousemove events after mousedown, so a
    # single jump from press to release is silently ignored by those.
    Assert-InBounds $FromX $FromY
    Assert-InBounds $ToX $ToY
    [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point($FromX, $FromY)
    Start-Sleep -Milliseconds 50
    [JarvisInput]::mouse_event([JarvisInput]::LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
    $steps = 20
    for ($i = 1; $i -le $steps; $i++) {
      $ix = [int]($FromX + ($ToX - $FromX) * $i / $steps)
      $iy = [int]($FromY + ($ToY - $FromY) * $i / $steps)
      [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point($ix, $iy)
      Start-Sleep -Milliseconds 10
    }
    Start-Sleep -Milliseconds 50
    [JarvisInput]::mouse_event([JarvisInput]::LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
    ([PSCustomObject]@{ ok = $true; op = 'dragdrop'; from = @{ x = $FromX; y = $FromY }; to = @{ x = $ToX; y = $ToY } }) | ConvertTo-Json -Compress
  }
  'clipget' {
    # Get-Clipboard/Set-Clipboard (not System.Windows.Forms.Clipboard) —
    # the .NET Clipboard class requires an STA thread, which a
    # non-interactive PowerShell process isn't guaranteed to be; these
    # built-in cmdlets handle that correctly.
    $clip = Get-Clipboard -Raw -ErrorAction SilentlyContinue
    if ($null -eq $clip) { $clip = '' }
    ([PSCustomObject]@{ ok = $true; op = 'clipget'; text = $clip }) | ConvertTo-Json -Compress
  }
  'clipset' {
    Set-Clipboard -Value $Text
    '{"ok":true,"op":"clipset"}'
  }
}
