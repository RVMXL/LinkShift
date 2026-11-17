# LinkShift - free/total space for the drive that holds the given path.
# Args: $args[0] = B64(anyPath)
# Out:  { ok, drive, freeBytes, totalBytes }

. "$PSScriptRoot\_lib.ps1"

# If _lib.ps1 died partway (e.g. a throwing console-encoding setter),
# fail fast with a machine-readable error instead of a confusing
# CommandNotFoundException at the final Write-Json call.
if (-not (Get-Command 'Write-Json' -ErrorAction SilentlyContinue)) {
    [Console]::Out.Write('{"ok":false,"error":"lib-load-failed","message":"_lib.ps1 failed to load"}')
    exit 1
}

$path = ConvertFrom-B64 $args[0]

try {
    Write-Json (Get-DriveInfoForPath $path)
} catch {
    Write-Json @{
        ok      = $false
        drive   = ''
        freeBytes  = 0
        totalBytes = 0
        error   = 'drive-not-found'
        message = $_.Exception.Message
    }
}
