# LinkShift - find ALL junction/symlink (reparse point) folders under a root.
#
# The "Links on disk" tab shows every link, including ones created manually
# with mklink outside this app. A compiled C# walker does the tree walk fast;
# it never descends into a reparse point, so junction loops (e.g. the Windows
# "Application Data" compatibility links) cannot occur.
#
# Noise filters:
#   * the C:\Windows tree is never entered;
#   * links that are Hidden AND System (Windows compatibility junctions)
#     are skipped in the resolve step.
#
# Args: $args[0] = B64(root path, may contain %ENV%; empty = %USERPROFILE%)
# Out:  progress lines "##P##{json}", then one final JSON:
#       { ok, root, walked, errors, count, items: [ { name, path, linkType, linkTarget } ] }

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

if (-not ('LinkShift.LinkFinder' -as [type])) {
    try {
        Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.IO;
namespace LinkShift {
    public static class LinkFinder {
        // Walks the tree without following reparse points.
        // Returns a flat list: [0]=walked, [1]=errors, [2]=found, then link paths.
        public static List<string> Find(string rootPath, string skipPrefix, int maxResults) {
            var links = new List<string>();
            var stack = new Stack<string>();
            stack.Push(rootPath);
            int walked = 0, errors = 0;
            string skip = string.IsNullOrEmpty(skipPrefix)
                ? null : skipPrefix.TrimEnd('\\') + '\\';
            while (stack.Count > 0) {
                string dir = stack.Pop();
                walked++;
                try {
                    var di = new DirectoryInfo(dir);
                    if ((di.Attributes & FileAttributes.ReparsePoint) != 0) {
                        if (links.Count < maxResults) { links.Add(dir); }
                        continue; // never descend into a link
                    }
                    if (skip != null && dir.StartsWith(skip, StringComparison.OrdinalIgnoreCase)) {
                        continue;
                    }
                    foreach (string d in Directory.EnumerateDirectories(dir)) { stack.Push(d); }
                } catch { errors++; }
            }
            var result = new List<string>();
            result.Add(walked.ToString());
            result.Add(errors.ToString());
            result.Add(links.Count.ToString());
            result.AddRange(links);
            return result;
        }
    }
}
"@
    } catch {
        Write-Json @{ ok = $false; error = 'addtype-failed'; message = $_.Exception.Message; items = @() }
        return
    }
}

$rootRaw = ''
if ($args -and $args.Count -ge 1) { $rootRaw = ConvertFrom-B64 $args[0] }
if ([string]::IsNullOrWhiteSpace($rootRaw)) { $rootRaw = $env:USERPROFILE }

$root = [System.Environment]::ExpandEnvironmentVariables($rootRaw).Trim()
if ($root -match '^[a-zA-Z]:$') { $root += '\' }
try { $root = [System.IO.Path]::GetFullPath($root).TrimEnd('\') } catch { }

if (-not [System.IO.Directory]::Exists((Get-LongPath $root))) {
    Write-Json @{ ok = $false; error = 'root-not-found'; path = $root; items = @() }
    return
}

$winDir = [System.Environment]::GetEnvironmentVariable('WinDir')
$maxResults = 2000

Write-ProgressJson @{ phase = 'scan'; path = $root }

$meta = [LinkShift.LinkFinder]::Find($root, $winDir, $maxResults)
$walked = [int]$meta[0]
$errors = [int]$meta[1]

$results = New-Object System.Collections.ArrayList
foreach ($p in ($meta | Select-Object -Skip 3)) {
    if ($winDir -and $p.StartsWith($winDir.TrimEnd('\') + '\', [System.StringComparison]::OrdinalIgnoreCase)) { continue }
    try {
        $item = Get-Item -LiteralPath $p -Force -ErrorAction Stop
        $a = $item.Attributes
        if (($a -band [System.IO.FileAttributes]::Hidden) -and ($a -band [System.IO.FileAttributes]::System)) { continue }
        $target = ''
        $t = ($item.Target | Select-Object -First 1)
        if ($t) { $target = [string]$t }
        [void]$results.Add(@{
            name       = [System.IO.Path]::GetFileName($p)
            path       = $p
            linkType   = [string]$item.LinkType
            linkTarget = $target
        })
        Write-ProgressJson @{ phase = 'resolve'; path = $p }
    } catch { $errors++ }
}

$sorted = @($results | Sort-Object -Property path)

Write-Json @{
    ok     = $true
    root   = $root
    walked = $walked
    errors = $errors
    count  = $sorted.Count
    items  = $sorted
}
