# LinkShift - measure a directory tree.
# Args: $args[0] = B64(path)
# Out:  { ok, path, exists, isReparsePoint, bytes, files, dirs, reparseDirs, accessErrors }

# The temp copy lives alone in its folder: the app must write _lib.ps1
# next to this script. Fail with a machine-readable error instead of a
# bare CommandNotFoundException when it is missing.
$libPath = Join-Path $PSScriptRoot '_lib.ps1'
if (-not (Test-Path -LiteralPath $libPath)) {
    [Console]::Out.Write('{"ok":false,"error":"lib-missing","message":"_lib.ps1 was not written next to the script"}')
    exit 1
}
. $libPath

# If _lib.ps1 died partway (e.g. a throwing console-encoding setter),
# fail fast with a machine-readable error instead of a confusing
# CommandNotFoundException at the final Write-Json call.
if (-not (Get-Command 'Write-Json' -ErrorAction SilentlyContinue)) {
    [Console]::Out.Write('{"ok":false,"error":"lib-load-failed","message":"_lib.ps1 failed to load"}')
    exit 1
}

$path = ConvertFrom-B64 $args[0]

try {
    $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
    if (-not $item.PSIsContainer) {
        Write-Json @{ ok = $false; path = $path; exists = $true; error = 'not-a-directory' }
        return
    }
    if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        Write-Json @{ ok = $true; path = $path; exists = $true; isReparsePoint = $true }
        return
    }
    $stats = Get-TreeStats $path
    Write-Json @{
        ok             = $true
        path           = $path
        exists         = $true
        isReparsePoint = $false
        bytes          = $stats.bytes
        files          = $stats.files
        dirs           = $stats.dirs
        reparseDirs    = $stats.reparse
        accessErrors   = $stats.errors
    }
} catch {
    Write-Json @{
        ok     = $false
        path   = $path
        exists = $false
        error  = 'not-found-or-inaccessible'
    }
}
