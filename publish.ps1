# Publishes hex-grid-aligner to GitHub and creates a Foundry-installable release.
# Usage:  $env:GHT = 'ghp_...'; .\publish.ps1 [-Version 1.0.0]
# The token is read from $env:GHT (never written to disk / .git/config).
param([string]$Version)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
if (-not $env:GHT) { throw "Set `$env:GHT to a GitHub token (scopes: repo, workflow)." }

$manifestPath = Join-Path $root "module.json"
$module = Get-Content $manifestPath -Raw | ConvertFrom-Json
if (-not $Version) { $Version = $module.version }
$tag = "v$Version"
$owner = "TheScKFred"
$repoName = "hex-grid-aligner"

$H = @{ Authorization = "Bearer $env:GHT"; Accept = "application/vnd.github+json"; "User-Agent" = "hga-publish" }
$user = Invoke-RestMethod -Headers $H -Uri "https://api.github.com/user"
Write-Host "Authenticated as $($user.login)"

# 1. Ensure the repository exists
try {
    $repo = Invoke-RestMethod -Headers $H -Uri "https://api.github.com/repos/$owner/$repoName"
} catch {
    $body = @{ name = $repoName; private = $false; has_issues = $true
        description = "Foundry VTT module: align and warp hand-drawn hex maps to a perfect hex grid (Offset, Size, Refine) with affine X-Y skew + Thin Plate Splines." } | ConvertTo-Json
    $repo = Invoke-RestMethod -Method Post -Headers $H -Uri "https://api.github.com/user/repos" -Body $body -ContentType "application/json"
    Write-Host "Created $($repo.html_url)"
}

# 2. Stamp version + URLs in module.json (text replace keeps formatting intact)
$manifestUrl = "https://github.com/$owner/$repoName/releases/latest/download/module.json"
$downloadUrl = "https://github.com/$owner/$repoName/releases/download/$tag/module.zip"
$raw = Get-Content $manifestPath -Raw
$raw = $raw -replace '"version":\s*"[^"]*"', "`"version`": `"$Version`""
$raw = $raw -replace '"manifest":\s*"[^"]*"', "`"manifest`": `"$manifestUrl`""
$raw = $raw -replace '"download":\s*"[^"]*"', "`"download`": `"$downloadUrl`""
[IO.File]::WriteAllText($manifestPath, $raw, (New-Object Text.UTF8Encoding $false))
$module = $raw | ConvertFrom-Json

# 3. Commit + push via WSL git (token passed as an HTTP header only)
$auth = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("x-access-token:$env:GHT"))
$email = "$($user.id)+$($user.login)@users.noreply.github.com"
$wslRoot = (wsl wslpath -a ($root -replace '\\', '/')).Trim()
$sh = @"
set -e
cd '$wslRoot'
[ -d .git ] || git init -b main
git config user.name '$($user.login)'
git config user.email '$email'
git add -A
git commit -m 'Release $tag' || true
git remote get-url origin >/dev/null 2>&1 || git remote add origin https://github.com/$owner/$repoName.git
git -c http.extraheader='AUTHORIZATION: basic $auth' push -u origin main
"@
$shFile = Join-Path $env:TEMP "hga-publish.sh"
[IO.File]::WriteAllText($shFile, ($sh -replace "`r", "") + "`n", (New-Object Text.UTF8Encoding $false))
try {
    wsl sh (wsl wslpath -a ($shFile -replace '\\', '/')).Trim()
    if ($LASTEXITCODE -ne 0) { throw "git push failed" }
} finally { Remove-Item $shFile -ErrorAction SilentlyContinue }

# 4. Build module.zip (files at archive root, as Foundry expects)
$dist = Join-Path $root "dist"
New-Item -ItemType Directory -Force -Path $dist | Out-Null
$zip = Join-Path $dist "module.zip"
if (Test-Path $zip) { Remove-Item $zip }
# Build entries manually with forward slashes (Compress-Archive on PS 5.1 writes backslashes,
# which breaks extraction on Linux-hosted Foundry servers).
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::Open($zip, [IO.Compression.ZipArchiveMode]::Create)
try {
    $files = @(Get-Item (Join-Path $root "module.json"), (Join-Path $root "README.md")) +
             @(Get-ChildItem -Recurse -File (Join-Path $root "scripts"), (Join-Path $root "styles"))
    foreach ($f in $files) {
        $entry = $f.FullName.Substring($root.Length + 1) -replace '\\', '/'
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $f.FullName, $entry) | Out-Null
    }
} finally { $archive.Dispose() }

# 5. Create (or reuse) the release and upload assets
try {
    $release = Invoke-RestMethod -Headers $H -Uri "https://api.github.com/repos/$owner/$repoName/releases/tags/$tag"
} catch {
    $body = @{ tag_name = $tag; target_commitish = "main"; name = $tag; body = "Hex Grid Aligner $tag" } | ConvertTo-Json
    $release = Invoke-RestMethod -Method Post -Headers $H -Uri "https://api.github.com/repos/$owner/$repoName/releases" -Body $body -ContentType "application/json"
}
foreach ($asset in $release.assets) {
    if ($asset.name -in @("module.json", "module.zip")) {
        Invoke-RestMethod -Method Delete -Headers $H -Uri $asset.url | Out-Null
    }
}
$uploadBase = $release.upload_url -replace '\{.*\}$', ''
Invoke-RestMethod -Method Post -Headers $H -Uri "$uploadBase`?name=module.json" -InFile $manifestPath -ContentType "application/json" | Out-Null
Invoke-RestMethod -Method Post -Headers $H -Uri "$uploadBase`?name=module.zip" -InFile $zip -ContentType "application/zip" | Out-Null

Write-Host ""
Write-Host "Release: $($release.html_url)"
Write-Host "Foundry manifest URL: $($module.manifest)"
