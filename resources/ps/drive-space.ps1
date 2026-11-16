# LinkShift - free/total space for the drive that holds the given path.
# Args: $args[0] = B64(anyPath)
# Out:  { ok, drive, freeBytes, totalBytes }

. "$PSScriptRoot\_lib.ps1"

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
