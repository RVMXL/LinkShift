# LinkShift - remove a junction/symlink WITHOUT touching its target.
#
# Safety first: the path must be a reparse point, otherwise the script
# refuses to run. Directory.Delete(path, false) on a reparse point removes
# only the link itself - the target content stays intact.
#
# Args: $args[0] = B64(path)
# Out:  { ok, path, error, message }

. "$PSScriptRoot\_lib.ps1"

$path = ConvertFrom-B64 $args[0]

try {
    $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
    if (-not ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        Write-Json @{ ok = $false; path = $path; error = 'not-a-link'; message = 'Refusing to remove a real directory via remove-link' }
        return
    }

    [System.IO.Directory]::Delete((Get-LongPath $path), $false)

    if ([System.IO.Directory]::Exists((Get-LongPath $path))) {
        Write-Json @{ ok = $false; path = $path; error = 'remove-failed'; message = 'Link still exists after delete' }
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
