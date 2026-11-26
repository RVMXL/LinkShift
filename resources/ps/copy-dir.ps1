# LinkShift - robocopy copy step (transaction step 4: backup -> target).
#
# robocopy runs HERE, inside PowerShell, not spawned directly by the app:
# Neutralino's CreateProcess passes the command line as ANSI, so a UTF-8
# path with Cyrillic turns into mojibake, robocopy cannot find the source
# and exits with code 16 ("serious error"). This script receives Base64
# arguments (like every other LinkShift script) and hands real Unicode
# strings to robocopy - the path survives any user name language.
#
# The log goes to a temp file via /UNILOG (official UTF-16 log): robocopy's
# console output is OEM-encoded and unreadable after the UTF-8 pipe, while
# /UNILOG always parses cleanly. The app decodes it and extracts the
# "ERROR N (0x...)" line for the failure toast.
#
# Args: $args[0] = B64(source dir), $args[1] = B64(target dir),
#       $args[2] = B64(flags string, e.g. "/E /COPY:DAT ...")
# Out:  { ok, exitCode, log }

$libPath = Join-Path $PSScriptRoot '_lib.ps1'
if (-not (Test-Path -LiteralPath $libPath)) {
    [Console]::Out.Write('{"ok":false,"error":"lib-missing","message":"_lib.ps1 was not written next to the script"}')
    exit 1
}
. $libPath

# If _lib.ps1 died partway, fail fast with a machine-readable error.
if (-not (Get-Command 'Write-Json' -ErrorAction SilentlyContinue)) {
    [Console]::Out.Write('{"ok":false,"error":"lib-load-failed","message":"_lib.ps1 failed to load"}')
    exit 1
}

$src = ConvertFrom-B64 $args[0]
$dst = ConvertFrom-B64 $args[1]
$flagsRaw = ''
if ($args.Count -ge 3) { $flagsRaw = ConvertFrom-B64 $args[2] }

$flags = @()
foreach ($f in ($flagsRaw -split '\s+')) { if ($f.Trim()) { $flags += $f.Trim() } }

# /UNILOG: <path> as one token; PowerShell quotes arguments with spaces,
# so robocopy receives the quoted switch even for a %TEMP% path with Cyrillic.
$logFile = Join-Path ([System.IO.Path]::GetTempPath()) ('LinkShift_rc_' + [Guid]::NewGuid().ToString('N') + '.log')

try {
    if (-not (Get-Command robocopy.exe -ErrorAction SilentlyContinue)) {
        Write-Json @{ ok = $false; error = 'robocopy-missing'; message = 'robocopy.exe was not found on this system' }
        return
    }
    # Console output is discarded on purpose: the Unicode log has everything.
    & robocopy.exe $src $dst @flags ('/UNILOG:' + $logFile) | Out-Null
    $code = -1
    if ($null -ne $LASTEXITCODE) { $code = $LASTEXITCODE }
} catch {
    Write-Json @{ ok = $false; error = 'robocopy-failed'; message = $_.Exception.Message }
    return
}

$log = ''
try {
    if (Test-Path -LiteralPath $logFile) {
        $log = [System.IO.File]::ReadAllText($logFile, [System.Text.Encoding]::Unicode)
    }
} catch { $log = '' }
try { Remove-Item -LiteralPath $logFile -ErrorAction SilentlyContinue } catch { }

Write-Json @{ ok = $true; exitCode = $code; log = $log }
