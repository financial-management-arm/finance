# Finances — Harutyunyan  ·  complete deploy
# Launch with "Deploy Finances.bat" or "Deploy Finances.vbs"
param(
  [switch]$Deploy,
  [switch]$Complete,
  [switch]$Script,
  [switch]$Check
)
if ($args -contains '/deploy'   -or $args -contains '-deploy')   { $Deploy   = $true }
if ($args -contains '/complete' -or $args -contains '-complete') { $Complete = $true }
if ($args -contains '/script'   -or $args -contains '-script')   { $Script   = $true }
if ($args -contains '/check'    -or $args -contains '-check')    { $Check    = $true }

$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $Root) { $Root = (Get-Location).Path }
Set-Location $Root

# Defaults — override with deploy-config.json in this folder.
$Cfg = [ordered]@{
  Name        = 'Finances — Harutyunyan'
  SiteUrl     = ''
  ProjectId   = ''
  Account     = ''
  Hosting     = 'auto'   # auto | firebase | vercel | github | none
  ScriptId    = '14tjp5lUfjZL9RTNMz8eCoxFOogbGSj-Op0C4WI7UNTY'
}

function Read-DeployConfig {
  $path = Join-Path $Root 'deploy-config.json'
  if (-not (Test-Path -LiteralPath $path)) { return }
  try {
    $raw = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($k in @('Name','SiteUrl','ProjectId','Account','Hosting','ScriptId')) {
      if ($null -ne $raw.$k -and "$($raw.$k)".Trim() -ne '') { $Cfg[$k] = "$($raw.$k)".Trim() }
    }
  } catch {
    Write-Host "deploy-config.json could not be read: $($_.Exception.Message)"
  }
}
Read-DeployConfig

function Detect-Hosting {
  if ($Cfg.Hosting -and $Cfg.Hosting -ne 'auto') { return $Cfg.Hosting.ToLowerInvariant() }
  if ((Test-Path (Join-Path $Root 'firebase.json')) -or (Test-Path (Join-Path $Root '.firebaserc'))) { return 'firebase' }
  if ((Test-Path (Join-Path $Root 'vercel.json')) -or (Test-Path (Join-Path $Root '.vercel'))) { return 'vercel' }
  if (Test-Path (Join-Path $Root '.git')) { return 'github' }
  return 'none'
}

function Read-FirebaseProject {
  $rc = Join-Path $Root '.firebaserc'
  if (-not (Test-Path $rc)) { return $null }
  try {
    $j = Get-Content -LiteralPath $rc -Raw | ConvertFrom-Json
    return [string]$j.projects.default
  } catch { return $null }
}

function Read-ClaspScriptId {
  $clasp = Join-Path $Root '.clasp.json'
  if (-not (Test-Path $clasp)) { return $null }
  try {
    $j = Get-Content -LiteralPath $clasp -Raw | ConvertFrom-Json
    return [string]$j.scriptId
  } catch { return $null }
}

$fbProj = Read-FirebaseProject
if ($fbProj -and -not $Cfg.ProjectId) { $Cfg.ProjectId = $fbProj }
$claspId = Read-ClaspScriptId
if ($claspId) { $Cfg.ScriptId = $claspId }

# Public PWA files that must ship together.
$Required = @(
  'index.html',
  'app.js',
  'style.css',
  'sw.js',
  'config.js',
  'manifest.json',
  'icon.png'
)

$Recommended = @(
  'exports.js'
)

$Optional = @(
  'vendor\exceljs.min.js',
  'vendor\pdf-lib.min.js',
  'vendor\fontkit.min.js',
  'bank-logos'
)

$IgnoredOnPurpose = @(
  'Deploy Finances.bat',
  'Deploy Finances.vbs',
  'deploy-finances.ps1',
  'deploy-config.json',
  'Code.gs',
  'DESIGN_BRIEF.md',
  'AGENTS.md'
)

$Navy   = [Drawing.Color]::FromArgb(11, 18, 32)
$Ink    = [Drawing.Color]::FromArgb(15, 23, 42)
$Muted  = [Drawing.Color]::FromArgb(100, 116, 139)
$Bg     = [Drawing.Color]::FromArgb(241, 245, 249)
$Card   = [Drawing.Color]::White
$Blue   = [Drawing.Color]::FromArgb(37, 99, 235)
$BlueH  = [Drawing.Color]::FromArgb(29, 78, 216)
$BlueD  = [Drawing.Color]::FromArgb(30, 64, 175)
$Ghost  = [Drawing.Color]::FromArgb(226, 232, 240)
$GhostH = [Drawing.Color]::FromArgb(203, 213, 225)
$Ok     = [Drawing.Color]::FromArgb(22, 163, 74)
$LogFg  = [Drawing.Color]::FromArgb(51, 65, 85)

function New-RoundPath([int]$x,[int]$y,[int]$w,[int]$h,[int]$r) {
  $p = New-Object Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

function New-AppleBtn($text, $fill, $fillH, $fillD, $fg, $x, $y, $w, $h, $pt) {
  $b = New-Object Windows.Forms.Button
  $b.Text = $text
  $b.Location = New-Object Drawing.Point($x, $y)
  $b.Size = New-Object Drawing.Size($w, $h)
  $b.FlatStyle = 'Flat'
  $b.FlatAppearance.BorderSize = 0
  $b.BackColor = $Bg
  $b.ForeColor = $fg
  $b.Font = New-Object Drawing.Font('Segoe UI Semibold', $pt)
  $b.Cursor = 'Hand'
  $st = @{ Fill=$fill; Hover=$fillH; Down=$fillD; Fg=$fg; Pressed=$false; Ox=$x; Oy=$y }
  $b.Tag = $st
  $b.Add_Paint({
    param($s,$e)
    $e.Graphics.SmoothingMode = 'AntiAlias'
    $e.Graphics.TextRenderingHint = 'ClearTypeGridFit'
    $t = $s.Tag
    $col = if ($t.Pressed) { $t.Down } elseif ($s.ClientRectangle.Contains($s.PointToClient([Windows.Forms.Cursor]::Position))) { $t.Hover } else { $t.Fill }
    $rect = $s.ClientRectangle
    $pad = if ($t.Pressed) { 1 } else { 0 }
    $path = New-RoundPath ($rect.X+$pad) ($rect.Y+$pad) ($rect.Width-1-2*$pad) ($rect.Height-1-2*$pad) 12
    $e.Graphics.FillPath((New-Object Drawing.SolidBrush $col), $path)
    $sf = New-Object Drawing.StringFormat
    $sf.Alignment = 'Center'
    $sf.LineAlignment = 'Center'
    $e.Graphics.DrawString($s.Text, $s.Font, (New-Object Drawing.SolidBrush $t.Fg), [Drawing.RectangleF]$rect, $sf)
  })
  $b.Add_MouseDown({ $this.Tag.Pressed = $true; $this.Invalidate() })
  $b.Add_MouseUp({ $this.Tag.Pressed = $false; $this.Invalidate() })
  $b.Add_MouseLeave({ $this.Tag.Pressed = $false; $this.Invalidate() })
  $b.Add_MouseEnter({ $this.Invalidate() })
  return $b
}

function Find-Cmd([string]$name, [string[]]$guesses) {
  $cmd = Get-Command $name -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($g in $guesses) { if (Test-Path $g) { return $g } }
  return $null
}

function Test-FirebaseCli {
  Find-Cmd 'firebase' @(
    "$env:APPDATA\npm\firebase.cmd",
    "$env:ProgramFiles\nodejs\firebase.cmd",
    "$env:LOCALAPPDATA\Yarn\bin\firebase.cmd"
  )
}
function Test-VercelCli {
  Find-Cmd 'vercel' @(
    "$env:APPDATA\npm\vercel.cmd",
    "$env:LOCALAPPDATA\Yarn\bin\vercel.cmd"
  )
}
function Test-ClaspCli {
  Find-Cmd 'clasp' @(
    "$env:APPDATA\npm\clasp.cmd",
    "$env:LOCALAPPDATA\Yarn\bin\clasp.cmd"
  )
}
function Test-GitCli { Find-Cmd 'git' @("$env:ProgramFiles\Git\cmd\git.exe") }

function Get-QueryVersion([string]$html, [string]$file) {
  if ($html -match "$([regex]::Escape($file))\?v=([0-9A-Za-z.\-]+)") { return $Matches[1] }
  return $null
}

function Get-SwCache {
  $sw = Join-Path $Root 'sw.js'
  if (-not (Test-Path $sw)) { return $null }
  $t = Get-Content -LiteralPath $sw -Raw
  if ($t -match "const CACHE = '([^']+)'") { return $Matches[1] }
  return $null
}

function Get-ApiUrlStatus {
  $cfg = Join-Path $Root 'config.js'
  if (-not (Test-Path $cfg)) { return 'missing' }
  $t = Get-Content -LiteralPath $cfg -Raw
  if ($t -match "YOUR_") { return 'placeholder' }
  if ($t -match "https://script\.google\.com/macros/s/[A-Za-z0-9_\-]+/exec") { return 'ok' }
  return 'unknown'
}

function Get-Preflight {
  $missing = New-Object System.Collections.Generic.List[string]
  $present = New-Object System.Collections.Generic.List[string]
  $warn    = New-Object System.Collections.Generic.List[string]
  $notes   = New-Object System.Collections.Generic.List[string]

  foreach ($f in $Required) {
    $p = Join-Path $Root $f
    if (Test-Path -LiteralPath $p) { [void]$present.Add($f) } else { [void]$missing.Add($f) }
  }
  foreach ($f in $Recommended) {
    if (-not (Test-Path -LiteralPath (Join-Path $Root $f))) { [void]$warn.Add($f) }
  }
  foreach ($f in $Optional) {
    if (-not (Test-Path -LiteralPath (Join-Path $Root $f))) { [void]$warn.Add($f) }
  }

  $indexPath = Join-Path $Root 'index.html'
  $swPath    = Join-Path $Root 'sw.js'
  if ((Test-Path $indexPath) -and (Test-Path $swPath)) {
    $html = Get-Content -LiteralPath $indexPath -Raw
    $sw   = Get-Content -LiteralPath $swPath -Raw
    foreach ($pair in @(@('style.css','css'), @('app.js','js'))) {
      $file = $pair[0]
      $iv = Get-QueryVersion $html $file
      if ($sw -match [regex]::Escape("$file`?v=")) {
        if ($sw -notmatch "$([regex]::Escape($file))\?v=$([regex]::Escape([string]$iv))") {
          [void]$notes.Add("Version mismatch: index.html and sw.js disagree on $file (?v=$iv in index).")
        }
      }
    }
  }

  $api = Get-ApiUrlStatus
  if ($api -eq 'placeholder') { [void]$notes.Add('config.js still has a placeholder API_URL.') }
  if ($api -eq 'missing') { [void]$missing.Add('config.js') }

  $hosting = Detect-Hosting
  return [pscustomobject]@{
    Missing = $missing
    Present = $present
    Warn    = $warn
    Notes   = $notes
    Ok      = ($missing.Count -eq 0)
    Hosting = $hosting
    Api     = $api
    Cache   = Get-SwCache
  }
}

$form = New-Object Windows.Forms.Form
$form.Text = 'Finances deploy'
$form.StartPosition = 'Manual'
$form.Location = New-Object Drawing.Point(48, 80)
$form.ClientSize = New-Object Drawing.Size(460, 700)
$form.BackColor = $Bg
$form.ForeColor = $Ink
$form.TopMost = $true
$form.FormBorderStyle = 'FixedSingle'
$form.MaximizeBox = $false
$form.MinimizeBox = $true
$form.Font = New-Object Drawing.Font('Segoe UI', 10)

$mark = New-Object Windows.Forms.Label
$mark.Text = [char]0x25CF
$mark.Font = New-Object Drawing.Font('Segoe UI', 9)
$mark.ForeColor = $Blue
$mark.Location = New-Object Drawing.Point(28, 18)
$mark.AutoSize = $true
$form.Controls.Add($mark)

$title = New-Object Windows.Forms.Label
$title.Text = 'Finances'
$title.Font = New-Object Drawing.Font('Segoe UI Semibold', 22)
$title.ForeColor = $Ink
$title.Location = New-Object Drawing.Point(24, 32)
$title.AutoSize = $true
$form.Controls.Add($title)

$sub = New-Object Windows.Forms.Label
$sub.Text = 'Harutyunyan workspace  ·  PWA + Sheets backend'
$sub.Font = New-Object Drawing.Font('Segoe UI', 10)
$sub.ForeColor = $Muted
$sub.Location = New-Object Drawing.Point(26, 70)
$sub.AutoSize = $true
$form.Controls.Add($sub)

$path = New-Object Windows.Forms.Label
$path.Text = $Root
$path.Font = New-Object Drawing.Font('Segoe UI', 8)
$path.ForeColor = $Muted
$path.Location = New-Object Drawing.Point(26, 94)
$path.Size = New-Object Drawing.Size(408, 28)
$form.Controls.Add($path)

$btnConnect = New-AppleBtn 'Connect account' $Ghost $GhostH ([Drawing.Color]::FromArgb(180,190,200)) $Ink 24 132 412 42 11
$btnCheck   = New-AppleBtn 'Check files'     $Ghost $GhostH ([Drawing.Color]::FromArgb(180,190,200)) $Ink 24 182 200 42 11
$btnHost    = New-AppleBtn 'Deploy website'  $Blue  $BlueH  $BlueD ([Drawing.Color]::White) 232 182 204 42 11
$btnScript  = New-AppleBtn 'Deploy Apps Script' $Ghost $GhostH ([Drawing.Color]::FromArgb(180,190,200)) $Ink 24 232 200 42 11
$btnAll     = New-AppleBtn 'Deploy complete' $Blue  $BlueH  $BlueD ([Drawing.Color]::White) 232 232 204 42 11
$btnPack    = New-AppleBtn 'Pack upload folder' $Card $Ghost $GhostH $Blue 24 282 200 36 10
$btnOpen    = New-AppleBtn 'Open live site'     $Card $Ghost $GhostH $Blue 232 282 204 36 10
$form.Controls.AddRange(@($btnConnect,$btnCheck,$btnHost,$btnScript,$btnAll,$btnPack,$btnOpen))

$logLbl = New-Object Windows.Forms.Label
$logLbl.Text = 'Activity'
$logLbl.Font = New-Object Drawing.Font('Segoe UI Semibold', 9)
$logLbl.ForeColor = $Muted
$logLbl.Location = New-Object Drawing.Point(26, 328)
$logLbl.AutoSize = $true
$form.Controls.Add($logLbl)

$box = New-Object Windows.Forms.TextBox
$box.Multiline = $true
$box.ScrollBars = 'Vertical'
$box.ReadOnly = $true
$box.BorderStyle = 'FixedSingle'
$box.BackColor = $Card
$box.ForeColor = $LogFg
$box.Font = New-Object Drawing.Font('Consolas', 8)
$box.Location = New-Object Drawing.Point(24, 350)
$box.Size = New-Object Drawing.Size(412, 326)
$form.Controls.Add($box)

function Write-Log([string]$msg) {
  $ts = Get-Date -Format 'HH:mm:ss'
  $box.AppendText("[$ts]  $msg`r`n")
  $box.SelectionStart = $box.Text.Length
  $box.ScrollToCaret()
  [System.Windows.Forms.Application]::DoEvents()
}

function Write-Preflight([object]$pf) {
  Write-Log ('App      ' + $Cfg.Name)
  Write-Log ('Folder   ' + $Root)
  Write-Log ('Hosting  ' + $pf.Hosting)
  if ($Cfg.ProjectId) { Write-Log ('Project  ' + $Cfg.ProjectId) }
  if ($Cfg.Account)   { Write-Log ('Account  ' + $Cfg.Account) }
  if ($Cfg.SiteUrl)   { Write-Log ('Live     ' + $Cfg.SiteUrl) }
  if ($pf.Cache)      { Write-Log ('SW cache ' + $pf.Cache) }
  Write-Log ('API      ' + $pf.Api)

  $fb = Test-FirebaseCli
  $vc = Test-VercelCli
  $cl = Test-ClaspCli
  $gt = Test-GitCli
  Write-Log ('CLI fb   ' + $(if ($fb) { $fb } else { 'not found' }))
  Write-Log ('CLI vercel ' + $(if ($vc) { $vc } else { 'not found' }))
  Write-Log ('CLI clasp  ' + $(if ($cl) { $cl } else { 'not found' }))
  Write-Log ('CLI git    ' + $(if ($gt) { $gt } else { 'not found' }))

  Write-Log 'Required PWA files:'
  foreach ($f in $Required) {
    if ($pf.Present -contains $f) { Write-Log ("  OK     $f") }
    else { Write-Log ("  MISSING $f") }
  }
  if ($pf.Warn.Count -gt 0) {
    Write-Log 'Optional / recommended, missing here:'
    foreach ($f in $pf.Warn) { Write-Log ("  WARN   $f") }
  }
  foreach ($n in $pf.Notes) { Write-Log ("  NOTE   $n") }
  Write-Log 'Not uploaded by this tool:'
  foreach ($f in $IgnoredOnPurpose) { Write-Log ("  skip   $f") }

  if ($pf.Hosting -eq 'none') {
    Write-Log 'No host detected. Add firebase.json, .vercel, or a git remote — or click Pack upload folder.'
  }
  if ($pf.Ok) { Write-Log 'Preflight passed.' }
  else { Write-Log 'Preflight failed. Put the MISSING files in this folder first.' }
}

function Invoke-Process([string]$fileName, [string]$arguments) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $fileName
  $psi.Arguments = $arguments
  $psi.WorkingDirectory = $Root
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $p = New-Object System.Diagnostics.Process
  $p.StartInfo = $psi
  [void]$p.Start()
  $raw = $p.StandardOutput.ReadToEnd() + $p.StandardError.ReadToEnd()
  $p.WaitForExit()
  $clean = [regex]::Replace($raw, '\x1B\[[0-9;]*[A-Za-z]', '')
  foreach ($line in ($clean -split "`r?`n")) {
    if ($line.Trim()) { Write-Log $line.Trim() }
  }
  return $p.ExitCode
}

function Set-Busy([bool]$busy) {
  foreach ($b in @($btnConnect,$btnCheck,$btnHost,$btnScript,$btnAll,$btnPack,$btnOpen)) {
    $b.Enabled = -not $busy
  }
}

function Invoke-WebsiteDeploy {
  $pf = Get-Preflight
  Write-Preflight $pf
  if (-not $pf.Ok) { return 2 }

  $hosting = $pf.Hosting
  Set-Busy $true
  $code = 1
  try {
    switch ($hosting) {
      'firebase' {
        $cli = Test-FirebaseCli
        if (-not $cli) {
          Write-Log 'Firebase CLI is not installed.'
          Write-Log 'Install: npm install -g firebase-tools'
          Write-Log 'Then click Connect account.'
          return 1
        }
        if (-not (Test-Path (Join-Path $Root 'firebase.json'))) {
          Write-Log 'firebase.json is missing. Cannot deploy hosting.'
          return 2
        }
        $proj = $Cfg.ProjectId
        if (-not $proj) { Write-Log 'Set ProjectId in deploy-config.json or .firebaserc'; return 2 }
        $acct = ''
        if ($Cfg.Account) { $acct = " --account $($Cfg.Account)" }
        Write-Log "firebase deploy --only hosting --project $proj --non-interactive"
        $code = Invoke-Process 'cmd.exe' "/c firebase deploy --only hosting --project $proj$acct --non-interactive"
      }
      'vercel' {
        $cli = Test-VercelCli
        if (-not $cli) {
          Write-Log 'Vercel CLI is not installed.'
          Write-Log 'Install: npm install -g vercel'
          return 1
        }
        Write-Log 'vercel --prod --yes'
        $code = Invoke-Process 'cmd.exe' '/c vercel --prod --yes'
      }
      'github' {
        $git = Test-GitCli
        if (-not $git) { Write-Log 'Git is not installed.'; return 1 }
        Write-Log 'git status'
        [void](Invoke-Process $git 'status --short')
        Write-Log 'Adding tracked PWA files and pushing current branch…'
        [void](Invoke-Process $git 'add -A')
        $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm'
        $code = Invoke-Process $git "commit -m `"Deploy Finances $stamp`""
        if ($code -ne 0) { Write-Log 'Nothing to commit, or commit failed. Pushing anyway.' }
        $code = Invoke-Process $git 'push'
      }
      default {
        Write-Log 'No hosting target. Use Pack upload folder, or add firebase.json / Vercel / git.'
        $code = 3
      }
    }
    if ($code -eq 0) {
      Write-Log 'Website deploy finished.'
      if ($Cfg.SiteUrl) { Write-Log $Cfg.SiteUrl }
    } elseif ($code -ne 3) {
      Write-Log "Failed  $code"
    }
  } catch { Write-Log $_.Exception.Message; $code = 1 }
  finally { Set-Busy $false }
  return $code
}

function Invoke-ScriptDeploy {
  $cl = Test-ClaspCli
  if (-not $cl) {
    Write-Log 'clasp is not installed.'
    Write-Log 'Install: npm install -g @google/clasp'
    Write-Log 'Then: clasp login'
    return 1
  }
  if (-not (Test-Path (Join-Path $Root 'Code.gs'))) {
    Write-Log 'Code.gs is not in this folder. Copy the Apps Script file here first.'
    return 2
  }
  if (-not (Test-Path (Join-Path $Root '.clasp.json'))) {
    $sid = $Cfg.ScriptId
    if (-not $sid) {
      Write-Log 'No .clasp.json and no ScriptId in deploy-config.json.'
      Write-Log 'Run: clasp clone <SCRIPT_ID>   or add ScriptId to deploy-config.json.'
      return 2
    }
    Write-Log "Writing .clasp.json for $sid"
    $json = @{ scriptId = $sid; rootDir = '.' } | ConvertTo-Json
    Set-Content -LiteralPath (Join-Path $Root '.clasp.json') -Value $json -Encoding UTF8
  }
  Set-Busy $true
  try {
    Write-Log 'clasp push'
    $code = Invoke-Process 'cmd.exe' '/c clasp push'
    if ($code -eq 0) { Write-Log 'Apps Script pushed. Deploy the web app from script.google.com if the /exec URL changed.' }
    else { Write-Log "clasp failed  $code  — click Connect account if you are not signed in." }
    return $code
  } catch { Write-Log $_.Exception.Message; return 1 }
  finally { Set-Busy $false }
}

function Invoke-Pack {
  $pf = Get-Preflight
  if (-not $pf.Ok) { Write-Preflight $pf; return 2 }
  $stamp = Get-Date -Format 'yyyyMMdd-HHmm'
  $dest = Join-Path $Root ("_upload-$stamp")
  New-Item -ItemType Directory -Path $dest | Out-Null
  $copy = @('index.html','app.js','style.css','sw.js','config.js','manifest.json','icon.png','exports.js','icon.svg')
  foreach ($f in $copy) {
    $src = Join-Path $Root $f
    if (Test-Path $src) { Copy-Item $src $dest }
  }
  foreach ($dir in @('vendor','bank-logos','assets')) {
    $src = Join-Path $Root $dir
    if (Test-Path $src) { Copy-Item $src (Join-Path $dest $dir) -Recurse }
  }
  Write-Log "Packed upload folder:"
  Write-Log $dest
  Start-Process explorer.exe $dest
  return 0
}

function Invoke-Connect {
  $hosting = Detect-Hosting
  Write-Log "Detected host: $hosting"
  switch ($hosting) {
    'firebase' {
      Write-Log 'Opening Firebase sign-in…'
      Start-Process 'cmd.exe' -ArgumentList '/k', 'firebase login --reauth'
    }
    'vercel' {
      Write-Log 'Opening Vercel sign-in…'
      Start-Process 'cmd.exe' -ArgumentList '/k', 'vercel login'
    }
    default {
      if (Test-ClaspCli) {
        Write-Log 'Opening clasp sign-in for Apps Script…'
        Start-Process 'cmd.exe' -ArgumentList '/k', 'clasp login'
      } else {
        Write-Log 'No host CLI found. Install firebase-tools, vercel, or @google/clasp, then retry.'
      }
    }
  }
}

function Invoke-OpenSite {
  if ($Cfg.SiteUrl) { Start-Process $Cfg.SiteUrl; return }
  Write-Log 'Set SiteUrl in deploy-config.json to enable Open live site.'
}

$btnConnect.Add_Click({ Invoke-Connect })
$btnCheck.Add_Click({ Write-Preflight (Get-Preflight) })
$btnHost.Add_Click({ [void](Invoke-WebsiteDeploy) })
$btnScript.Add_Click({ [void](Invoke-ScriptDeploy) })
$btnAll.Add_Click({
  $a = Invoke-WebsiteDeploy
  $b = Invoke-ScriptDeploy
  if ($a -eq 0 -and $b -eq 0) { Write-Log 'Complete deploy finished.' }
})
$btnPack.Add_Click({ [void](Invoke-Pack) })
$btnOpen.Add_Click({ Invoke-OpenSite })

Write-Log 'Ready — Finances deploy.'
Write-Log 'Check files first. Then Deploy website, or Pack upload folder.'
Write-Preflight (Get-Preflight)

if ($Check)    { exit $(if ((Get-Preflight).Ok) { 0 } else { 2 }) }
if ($Complete) {
  $a = Invoke-WebsiteDeploy
  $b = Invoke-ScriptDeploy
  if (-not $Deploy) { [void]$form.ShowDialog() }
  exit $(if ($a -eq 0 -and $b -eq 0) { 0 } else { 1 })
}
if ($Script) {
  $exit = Invoke-ScriptDeploy
  if (-not $Deploy) { [void]$form.ShowDialog() }
  exit $exit
}
if ($Deploy) {
  $exit = Invoke-WebsiteDeploy
  exit $exit
}

[void]$form.ShowDialog()
