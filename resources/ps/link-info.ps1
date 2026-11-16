# LinkShift - link/reparse point info for a path.
# Args: $args[0] = B64(path)
# Out:  { ok, path, exists, isDirectory, isReparsePoint, linkType, linkTarget }

. "$PSScriptRoot\_lib.ps1"

$path = ConvertFrom-B64 $args[0]

try {
    $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
    $isReparse = [bool]($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
    $linkType = $null
    $linkTarget = $null
    if ($isReparse) {
        $linkType = [string]$item.LinkType
        $linkTarget = [string]($item.Target | Select-Object -First 1)
    }
    Write-Json @{
        ok             = $true
        path           = $path
        exists         = $true
        isDirectory    = [bool]$item.PSIsContainer
        isReparsePoint = $isReparse
        linkType       = $linkType
        linkTarget     = $linkTarget
    }
} catch {
    Write-Json @{
        ok             = $true
        path           = $path
        exists         = $false
        isReparsePoint = $false
    }
}
