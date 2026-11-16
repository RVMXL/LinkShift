# LinkShift - validate a source path before the move transaction.
# Args: $args[0] = B64(rawPath, may contain %ENV% variables)
# Out:  { ok, path, exists, isDirectory, isReparsePoint, linkType, linkTarget,
#         parent, name, pathRoot, isSystemPath }

. "$PSScriptRoot\_lib.ps1"

$raw = ConvertFrom-B64 $args[0]

if ([string]::IsNullOrWhiteSpace($raw)) {
    Write-Json @{ ok = $true; path = ''; exists = $false }
    return
}

try {
    $path = [System.Environment]::ExpandEnvironmentVariables($raw)
    $full = [System.IO.Path]::GetFullPath($path).TrimEnd('\')

    $item = Get-Item -LiteralPath $full -Force -ErrorAction Stop

    $isReparse = [bool]($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
    $linkType = $null
    $linkTarget = $null
    if ($isReparse) {
        $linkType = [string]$item.LinkType
        $linkTarget = [string]($item.Target | Select-Object -First 1)
    }

    $parent = Split-Path -Parent $full
    $name = Split-Path -Leaf $full
    $pathRoot = [System.IO.Path]::GetPathRoot($full).TrimEnd('\')

    # Guard rails: never let the transaction touch the system core.
    $winDir = [System.Environment]::GetEnvironmentVariable('WinDir').TrimEnd('\')
    $progFiles = [System.Environment]::GetEnvironmentVariable('ProgramFiles').TrimEnd('\')
    $progFiles86 = [System.Environment]::GetEnvironmentVariable('ProgramFiles(x86)').TrimEnd('\')
    $usersRoot = Join-Path ([System.Environment]::GetEnvironmentVariable('SystemDrive')) 'Users'

    $isSystemPath =
        ($full -ieq $pathRoot) -or
        ($full -ieq $winDir) -or
        ($winDir -and $full.StartsWith($winDir + '\', [System.StringComparison]::OrdinalIgnoreCase)) -or
        ($progFiles -and $full.StartsWith($progFiles + '\', [System.StringComparison]::OrdinalIgnoreCase)) -or
        ($progFiles86 -and $full.StartsWith($progFiles86 + '\', [System.StringComparison]::OrdinalIgnoreCase)) -or
        ($full -ieq $usersRoot)

    Write-Json @{
        ok             = $true
        path           = $full
        exists         = $true
        isDirectory    = [bool]$item.PSIsContainer
        isReparsePoint = $isReparse
        linkType       = $linkType
        linkTarget     = $linkTarget
        parent         = $parent
        name           = $name
        pathRoot       = $pathRoot
        isSystemPath   = [bool]$isSystemPath
    }
} catch {
    Write-Json @{ ok = $true; path = $raw; exists = $false }
}
