# LinkShift - shared PowerShell helpers.
#
# IMPORTANT: this file is intentionally ASCII-only. Windows PowerShell 5.1
# reads .ps1 files without a BOM in the system ANSI codepage, so any
# non-ASCII character here would break on non-English Windows. All dynamic
# data (paths, options) arrives from the app as Base64-encoded arguments and
# is decoded below with an explicit UTF-8 codec. All JSON output is produced
# with ConvertTo-Json, which escapes non-ASCII as \uXXXX, so the console pipe
# stays clean for the Neutralino side.

# The console encoding setter throws on processes without a real console
# (we are spawned from a GUI app with redirected pipes), which would kill the
# whole dot-sourced library. JSON output is ASCII-escaped anyway, so a failed
# setter costs nothing. Same guard is applied in runPSInline (exec.js).
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

# ---------------------------------------------------------------- base64 I/O

function ConvertFrom-B64([string]$b64) {
    if ([string]::IsNullOrWhiteSpace($b64)) { return '' }
    [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($b64))
}

# ------------------------------------------------------------------ output

function Write-Json([object]$obj) {
    # -InputObject keeps single-element arrays intact on PS 5.1.
    # WriteLine, not Write: the app's line parser splits on \n, so a final
    # JSON without a trailing newline stayed in the stream buffer and was
    # lost ("produced no JSON" with exit 0).
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject $obj -Compress -Depth 8))
}

function Write-ProgressJson([object]$obj) {
    [Console]::Out.WriteLine(('##P##' + (ConvertTo-Json -InputObject $obj -Compress -Depth 8)))
}

# Last-resort net for terminating errors (.NET method exceptions, missing
# cmdlets, etc.): emit the error as JSON over stdout and exit 1, so the app
# shows a localized message instead of "produced no JSON". Deliberately does
# NOT depend on Write-Json - the exact failure this guards against is that
# function being missing. Dot-sourcing places this trap in the caller's
# scope, covering the whole calling script.
trap {
    $msg = ''
    try { $msg = [string]$_.Exception.Message } catch { }
    $payload = @{ ok = $false; error = 'ps-error'; message = $msg }
    try {
        [Console]::Out.WriteLine((ConvertTo-Json -InputObject $payload -Compress -Depth 3))
    } catch { }
    exit 1
}

# ------------------------------------------------------------------- paths

function Get-LongPath([string]$p) {
    # \\?\ prefix removes the 260-char MAX_PATH limit for .NET APIs.
    # Raw .NET APIs treat the prefix literally: forward slashes (drag-drop,
    # copy-paste) are NOT normalized there - "Could not find a part of the
    # path '\\?\C:/...'". Convert everything to canonical backslashes first.
    $p = $p.Replace('/', '\').TrimEnd('\')
    if ($p.StartsWith('\\?\')) { return $p }
    if ($p.StartsWith('\\')) { return ('\\?\UNC\' + $p.Substring(2)) }
    return ('\\?\' + $p)
}

function Test-ReparsePoint([string]$path) {
    try {
        $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
        return [bool]($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
    } catch {
        return $false
    }
}

# --------------------------------------------------- fast tree size scanner

if (-not ('LinkShift.TreeScanner' -as [type])) {
    try {
        # Compiled C# scanner: ~50x faster than a pure PS loop on big trees.
        # Reparse points (junctions/symlinks) are never followed, so linked
        # content is neither double-counted nor walked into.
        Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.IO;
namespace LinkShift {
    public static class TreeScanner {
        public static long[] Scan(string rootPath) {
            long bytes = 0, files = 0, dirs = 0, reparse = 0, errors = 0;
            var stack = new Stack<string>();
            stack.Push(rootPath);
            while (stack.Count > 0) {
                string dir = stack.Pop();
                IEnumerable<string> entries = null;
                try { entries = Directory.EnumerateFileSystemEntries(dir); }
                catch { errors++; continue; }
                foreach (string e in entries) {
                    try {
                        FileAttributes attr = File.GetAttributes(e);
                        if ((attr & FileAttributes.ReparsePoint) != 0) { reparse++; continue; }
                        if ((attr & FileAttributes.Directory) != 0) { dirs++; stack.Push(e); }
                        else { bytes += new FileInfo(e).Length; files++; }
                    } catch { errors++; }
                }
            }
            return new long[] { bytes, files, dirs, reparse, errors };
        }
    }
}
"@
    } catch {
        # Add-Type unavailable - the PS fallback below will be used instead.
    }
}

function Get-TreeStats([string]$dirPath) {
    # Returns @{ bytes; files; dirs; reparse; errors } for a directory tree.
    $root = Get-LongPath $dirPath
    try {
        $r = [LinkShift.TreeScanner]::Scan($root)
        return @{
            bytes  = [long]$r[0]
            files  = [int]$r[1]
            dirs   = [int]$r[2]
            reparse = [int]$r[3]
            errors = [int]$r[4]
        }
    } catch {
        # Fallback: pure PowerShell recursion (slower, same semantics).
        $bytes = [long]0; $files = 0; $dirs = 0; $reparse = 0; $errors = 0
        $stack = New-Object System.Collections.Stack
        $stack.Push($root)
        while ($stack.Count -gt 0) {
            $dir = [string]$stack.Pop()
            try {
                foreach ($f in [System.IO.Directory]::EnumerateFiles($dir)) {
                    try { $bytes += ([System.IO.FileInfo]$f).Length; $files++ } catch { $errors++ }
                }
                foreach ($d in [System.IO.Directory]::EnumerateDirectories($dir)) {
                    try {
                        $di = New-Object System.IO.DirectoryInfo($d)
                        if ($di.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { $reparse++ }
                        else { $dirs++; $stack.Push($d) }
                    } catch { $errors++ }
                }
            } catch { $errors++ }
        }
        return @{ bytes = $bytes; files = $files; dirs = $dirs; reparse = $reparse; errors = $errors }
    }
}

# ------------------------------------------------------------- drive space

function Get-DriveInfoForPath([string]$path) {
    $full = [System.IO.Path]::GetFullPath($path)
    $root = [System.IO.Path]::GetPathRoot($full)
    $drive = $root.TrimEnd('\')
    if ($root.StartsWith('\\')) { throw 'UNC paths are not supported for drive space check' }
    $filter = "DeviceID='{0}'" -f $drive
    $disk = Get-CimInstance -ClassName Win32_LogicalDisk -Filter $filter -ErrorAction Stop
    if (-not $disk) { throw ('Drive not found: ' + $drive) }
    @{
        ok         = $true
        drive      = $drive
        freeBytes  = [long]$disk.FreeSpace
        totalBytes = [long]$disk.Size
    }
}
