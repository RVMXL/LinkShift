# LinkShift - create the directory link (transaction step 3).
# Uses cmd.exe mklink exactly as specified: /J = junction, /D = symbolic link.
# Junctions work without admin rights; symbolic links need elevation.
# Args: $args[0] = B64(linkPath), $args[1] = B64(targetPath), $args[2] = B64('J'|'D')
# Out:  { ok, linkPath, targetPath, linkType, output }

. "$PSScriptRoot\_lib.ps1"

# If _lib.ps1 died partway (e.g. a throwing console-encoding setter),
# fail fast with a machine-readable error instead of a confusing
# CommandNotFoundException at the final Write-Json call.
if (-not (Get-Command 'Write-Json' -ErrorAction SilentlyContinue)) {
    [Console]::Out.Write('{"ok":false,"error":"lib-load-failed","message":"_lib.ps1 failed to load"}')
    exit 1
}

$linkPath = ConvertFrom-B64 $args[0]
$targetPath = ConvertFrom-B64 $args[1]
$linkType = ConvertFrom-B64 $args[2]
if ($linkType -ne 'J' -and $linkType -ne 'D') { $linkType = 'J' }

try {
    $linkPath = $linkPath.TrimEnd('\')
    $targetPath = $targetPath.TrimEnd('\')

    if ([System.IO.Directory]::Exists($linkPath)) {
        Write-Json @{ ok = $false; error = 'already-exists'; message = 'Link path already exists' }
        return
    }

    $created = $false
    $lastError = ''

    # Primary: New-Item (no cmd.exe involved, clean errors for most paths).
    try {
        if ($linkType -eq 'J') {
            New-Item -Path $linkPath -ItemType Junction -Value $targetPath -ErrorAction Stop | Out-Null
        } else {
            New-Item -Path $linkPath -ItemType SymbolicLink -Value $targetPath -ErrorAction Stop | Out-Null
        }
        $created = $true
    } catch {
        $lastError = $_.Exception.Message
    }

    # Fallback: classic cmd mklink (spec requirement, covers exotic paths).
    if (-not $created) {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $env:ComSpec
        # chcp 65001 makes cmd.exe emit UTF-8 so mklink's localized message survives.
        $psi.Arguments = '/c chcp 65001 >nul & mklink /' + $linkType + ' "' + $linkPath + '" "' + $targetPath + '"'
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
        $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8

        $proc = [System.Diagnostics.Process]::Start($psi)
        $out = $proc.StandardOutput.ReadToEnd()
        $err = $proc.StandardError.ReadToEnd()
        $proc.WaitForExit()

        if ($proc.ExitCode -eq 0) { $created = $true }
        else { $lastError = ($out + ' ' + $err).Trim() }
    }

    if ($created -and [System.IO.Directory]::Exists($linkPath)) {
        Write-Json @{
            ok         = $true
            linkPath   = $linkPath
            targetPath = $targetPath
            linkType   = $linkType
        }
    } else {
        Write-Json @{
            ok      = $false
            error   = 'mklink-failed'
            message = $lastError
        }
    }
} catch {
    Write-Json @{
        ok        = $false
        error     = 'exception'
        errorType = $_.Exception.GetType().FullName
        message   = $_.Exception.Message
    }
}
