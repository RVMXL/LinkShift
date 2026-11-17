# LinkShift - validate a source path before the move transaction.
# Args: $args[0] = B64(rawPath, may contain %ENV% variables)
# Out:  { ok, path, exists, isDirectory, isReparsePoint, linkType, linkTarget,
#         parent, name, pathRoot, isSystemPath }

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
