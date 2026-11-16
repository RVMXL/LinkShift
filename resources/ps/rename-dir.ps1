# LinkShift - rename a directory (transaction step 1: lock probe).
# Renaming fails BEFORE any copying starts if the folder is held open by a
# running program, which is exactly the safe-abort behavior we need.
# Args: $args[0] = B64(path), $args[1] = B64(newName)
# Out:  { ok, newPath, error, errorType, hresult, message }

. "$PSScriptRoot\_lib.ps1"

$path = ConvertFrom-B64 $args[0]
$newName = ConvertFrom-B64 $args[1]

try {
    Rename-Item -LiteralPath $path -NewName $newName -ErrorAction Stop | Out-Null
    $parent = Split-Path -Parent $path
    Write-Json @{ ok = $true; newPath = (Join-Path $parent $newName) }
} catch {
    $ex = $_.Exception
    $kind = 'generic'
    if ($ex -is [System.IO.IOException]) { $kind = 'locked-or-in-use' }
    elseif ($ex -is [System.UnauthorizedAccessException]) { $kind = 'access-denied' }
    elseif ($ex -is [System.Management.Automation.ItemNotFoundException]) { $kind = 'not-found' }

    Write-Json @{
        ok        = $false
        error     = $kind
        errorType = $ex.GetType().FullName
        hresult   = $ex.HResult
        message   = $ex.Message
    }
}
