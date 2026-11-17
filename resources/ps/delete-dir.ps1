# LinkShift - delete a real directory tree SAFELY (used for the .bak copy).
#
# Two-phase delete: first strip any nested reparse points (shallow delete of
# the link itself), then remove the remaining real tree. This guarantees the
# recursive delete can never walk THROUGH a junction into data on another
# volume (the classic Remove-Item / Directory.Delete foot-gun).
#
# Args: $args[0] = B64(path)
# Out:  { ok, path, error, message }

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
    if (Test-ReparsePoint $path) {
        Write-Json @{ ok = $false; path = $path; error = 'is-reparse-point'; message = 'Refusing to delete a reparse point with delete-dir; use remove-link.ps1' }
        return
    }

    $long = Get-LongPath $path
    if (-not [System.IO.Directory]::Exists($long)) {
        Write-Json @{ ok = $true; path = $path; alreadyGone = $true }
        return
    }

    # Phase 1: remove nested reparse points shallowly.
    $pending = New-Object 'System.Collections.Generic.List[string]'
    $stack = New-Object System.Collections.Stack
    $stack.Push($long)
    while ($stack.Count -gt 0) {
        $dir = [string]$stack.Pop()
        $pending.Add($dir)
        try {
            foreach ($f in [System.IO.Directory]::EnumerateFiles($dir)) {
                try {
                    $fi = New-Object System.IO.FileInfo($f)
                    if ($fi.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
                        [System.IO.File]::Delete($f)
                    }
                } catch { }
            }
            foreach ($d in [System.IO.Directory]::EnumerateDirectories($dir)) {
                try {
                    $di = New-Object System.IO.DirectoryInfo($d)
                    if ($di.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
                        [System.IO.Directory]::Delete($d, $false)
                    } else {
                        $stack.Push($d)
                    }
                } catch { }
            }
        } catch { }
    }

    # Phase 2: delete real directories bottom-up.
    for ($i = $pending.Count - 1; $i -ge 0; $i--) {
        try { [System.IO.Directory]::Delete($pending[$i], $false) } catch { }
    }

    if ([System.IO.Directory]::Exists($long)) {
        Write-Json @{ ok = $false; path = $path; error = 'partially-locked'; message = 'Some files are locked and were left in place' }
    } else {
        Write-Json @{ ok = $true; path = $path }
    }
} catch {
    Write-Json @{
        ok        = $false
        path      = $path
        error     = 'exception'
        errorType = $_.Exception.GetType().FullName
        message   = $_.Exception.Message
    }
}
