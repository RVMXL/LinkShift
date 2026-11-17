# LinkShift - storage scanner ("space eaters").
#
# Scans known heavy directories (browser caches, messengers, GPU/game shader
# caches) plus every first-level folder in %LOCALAPPDATA% and %APPDATA% that
# is heavier than the configured threshold.
#
# Rules implemented here:
#   * Folders that are ALREADY reparse points (junctions/symlinks created by
#     this app or manually) are skipped entirely - they must never be
#     suggested for a second move.
#   * isSafeToMove = false when the owning application is currently running.
#
# Args: $args[0] = B64(JSON { minSizeMB: number, checkProcesses: bool })
# Out:  progress lines "##P##{json}" while measuring, then one final JSON:
#       { ok, items: [ { name, path, sizeMB, files, category, isSafeToMove, reasons } ] }

. "$PSScriptRoot\_lib.ps1"

# If _lib.ps1 died partway (e.g. a throwing console-encoding setter),
# fail fast with a machine-readable error instead of a confusing
# CommandNotFoundException at the final Write-Json call.
if (-not (Get-Command 'Write-Json' -ErrorAction SilentlyContinue)) {
    [Console]::Out.Write('{"ok":false,"error":"lib-load-failed","message":"_lib.ps1 failed to load"}')
    exit 1
}

$rawParams = '{}'
if ($args -and $args.Count -ge 1) { $rawParams = ConvertFrom-B64 $args[0] }
$params = $rawParams | ConvertFrom-Json

$minBytes = 500MB
if ($params.minSizeMB) { $minBytes = [long]$params.minSizeMB * 1MB }
$checkProcesses = ($params.checkProcesses -ne $false)

$LAD = $env:LOCALAPPDATA
$RAD = $env:APPDATA

# ------------------------------------------------------------ process table

$runningProcs = @{}
if ($checkProcesses) {
    try {
        Get-Process -ErrorAction SilentlyContinue | ForEach-Object {
            $runningProcs[$_.ProcessName.ToLowerInvariant()] = $true
        }
    } catch { }
}

function Test-ProcRunning([string[]]$names) {
    foreach ($n in $names) {
        if ($n -and $runningProcs.ContainsKey($n.ToLowerInvariant())) { return $n }
    }
    return $null
}

# ------------------------------------------------------------- result store

$results = New-Object System.Collections.ArrayList
$seen = New-Object 'System.Collections.Generic.HashSet[string]'

function Add-Candidate {
    param(
        [string]$name,
        [string]$path,
        [string]$category,
        [string[]]$procs = @(),
        [bool]$enforceMin = $true,
        [string]$procGuess = ''
    )
    if ([string]::IsNullOrWhiteSpace($path)) { return }
    if (-not [System.IO.Directory]::Exists($path)) { return }

    # Core rule: never suggest a folder that is already a link/reparse point.
    $di = New-Object System.IO.DirectoryInfo($path)
    if ($di.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { return }
    if (-not $seen.Add($path.ToLowerInvariant())) { return }

    Write-ProgressJson @{ phase = 'measure'; path = $path; category = $category }

    $stats = Get-TreeStats $path
    if ($enforceMin -and $stats.bytes -lt $minBytes) { return }

    $isUnsafe = $false
    $reasons = @()

    $hit = Test-ProcRunning $procs
    if (-not $hit -and $procGuess) { $hit = Test-ProcRunning @($procGuess) }
    if ($hit) {
        $isUnsafe = $true
        $reasons += @{ code = 'process_running'; process = $hit }
    }
    if ($stats.reparse -gt 0) {
        $reasons += @{ code = 'contains_links'; count = $stats.reparse }
    }
    if ($category -eq 'temp') {
        $isUnsafe = $true
        $reasons += @{ code = 'temp_hint' }
    }
    if ($category -eq 'app-data') {
        $reasons += @{ code = 'verify_manually' }
    }

    [void]$results.Add(@{
        name         = $name
        path         = $path
        sizeMB       = [math]::Round($stats.bytes / 1MB, 1)
        files        = $stats.files
        category     = $category
        isSafeToMove = (-not $isUnsafe)
        reasons      = $reasons
    })
}

# ------------------------------------------------------- browser caches

$cacheSubs = @('Cache', 'Code Cache', 'GPUCache', 'Service Worker\CacheStorage', 'Media Cache')
$browsers = @(
    @{ name = 'Chrome'; root = (Join-Path $LAD 'Google\Chrome\User Data'); proc = 'chrome' },
    @{ name = 'Edge'; root = (Join-Path $LAD 'Microsoft\Edge\User Data'); proc = 'msedge' },
    @{ name = 'Yandex'; root = (Join-Path $LAD 'Yandex\YandexBrowser\User Data'); proc = 'browser' }
)

foreach ($b in $browsers) {
    if (-not [System.IO.Directory]::Exists($b.root)) { continue }
    foreach ($profile in [System.IO.Directory]::EnumerateDirectories($b.root)) {
        $profileName = [System.IO.Path]::GetFileName($profile)
        if ($profileName -eq 'System Profile' -or $profileName -eq 'Guest Profile' -or $profileName -eq 'Crashpad') { continue }
        foreach ($sub in $cacheSubs) {
            $cachePath = Join-Path $profile $sub
            if ([System.IO.Directory]::Exists($cachePath)) {
                Add-Candidate -name ($b.name + ' cache (' + $profileName + '\' + $sub + ')') `
                    -path $cachePath -category 'browser-cache' -procs @($b.proc) -enforceMin $false
            }
        }
    }
}

# ------------------------------------------------------------- messengers

Add-Candidate -name 'Telegram Desktop' -path (Join-Path $RAD 'Telegram Desktop') `
    -category 'messenger' -procs @('telegram') -enforceMin $false
Add-Candidate -name 'Discord' -path (Join-Path $RAD 'discord') `
    -category 'messenger' -procs @('discord') -enforceMin $false

# ---------------------------------------------------------- GPU shaders

Add-Candidate -name 'NVIDIA DXCache' -path (Join-Path $LAD 'NVIDIA\DXCache') `
    -category 'gpu-shaders' -enforceMin $false
Add-Candidate -name 'NVIDIA GLCache' -path (Join-Path $LAD 'NVIDIA\GLCache') `
    -category 'gpu-shaders' -enforceMin $false
Add-Candidate -name 'NVIDIA NV_Cache' -path (Join-Path $LAD 'NVIDIA Corporation\NV_Cache') `
    -category 'gpu-shaders' -enforceMin $false
Add-Candidate -name 'AMD DxCache' -path (Join-Path $LAD 'AMD\DxCache') `
    -category 'gpu-shaders' -enforceMin $false
Add-Candidate -name 'AMD DxcCache' -path (Join-Path $LAD 'AMD\DxcCache') `
    -category 'gpu-shaders' -enforceMin $false
Add-Candidate -name 'D3DSCache' -path (Join-Path $LAD 'D3DSCache') `
    -category 'gpu-shaders' -enforceMin $false

# -------------------------------------------------- Steam shader caches

$steamPath = $null
try {
    $steamPath = (Get-ItemProperty -Path 'HKCU:\Software\Valve\Steam' -Name SteamPath -ErrorAction Stop).SteamPath
} catch { }

if ($steamPath) {
    $libraries = New-Object 'System.Collections.Generic.HashSet[string]'
    [void]$libraries.Add($steamPath)
    $vdf = Join-Path $steamPath 'steamapps\libraryfolders.vdf'
    if ([System.IO.File]::Exists($vdf)) {
        try {
            $content = [System.IO.File]::ReadAllText($vdf)
            foreach ($m in [regex]::Matches($content, '"path"\s+"([^"]+)"')) {
                [void]$libraries.Add(($m.Groups[1].Value -replace '\\\\', '\'))
            }
        } catch { }
    }
    foreach ($lib in $libraries) {
        $shaderRoot = Join-Path $lib 'steamapps\shadercache'
        if ([System.IO.Directory]::Exists($shaderRoot)) {
            foreach ($app in [System.IO.Directory]::EnumerateDirectories($shaderRoot)) {
                Add-Candidate -name ('Steam shadercache (' + [System.IO.Path]::GetFileName($app) + ')') `
                    -path $app -category 'game-shaders' -procs @('steam') -enforceMin $false
            }
        }
    }
}

# ------------------------------------------------------ temp (informational)

Add-Candidate -name 'Temp' -path (Join-Path $LAD 'Temp') `
    -category 'temp' -enforceMin $false

# ------------------------------------------- generic heavy dirs (>500 MB)

$procGuessMap = @{
    'telegram desktop' = 'telegram'
    'discord'          = 'discord'
    'steam'            = 'steam'
    'google'           = 'chrome'
    'mozilla'          = 'firefox'
    'bravesoftware'    = 'brave'
    'opera software'   = 'opera'
    'vivaldi'          = 'vivaldi'
    'code'             = 'code'
}

foreach ($root in @($LAD, $RAD)) {
    if (-not [System.IO.Directory]::Exists($root)) { continue }
    $rootPrefix = $root.TrimEnd('\') + '\'

    # Skip first-level folders that already contain detected special caches,
    # so the same bytes are not listed twice.
    $skipRoots = New-Object 'System.Collections.Generic.HashSet[string]'
    foreach ($r in $results) {
        $rp = $r.path.ToLowerInvariant()
        if ($rp.StartsWith($rootPrefix.ToLowerInvariant())) {
            $rest = $r.path.Substring($rootPrefix.Length)
            [void]$skipRoots.Add($rest.Split('\')[0].ToLowerInvariant())
        }
    }
    [void]$skipRoots.Add('linkshift')

    foreach ($dir in [System.IO.Directory]::EnumerateDirectories($root)) {
        $dirName = [System.IO.Path]::GetFileName($dir)
        if ($skipRoots.Contains($dirName.ToLowerInvariant())) { continue }
        $di = New-Object System.IO.DirectoryInfo($dir)
        if ($di.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { continue }

        $guess = $null
        $key = $dirName.ToLowerInvariant()
        if ($procGuessMap.ContainsKey($key)) { $guess = $procGuessMap[$key] }

        Add-Candidate -name $dirName -path $dir `
            -category 'app-data' -procGuess $guess -enforceMin $true
    }
}

# --------------------------------------------------------------- final JSON

Write-Json @{
    ok    = $true
    count = $results.Count
    items = $results
}
