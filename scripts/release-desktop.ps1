<#
.SYNOPSIS
桌面版一键发版：校验安装器 -> 打 tag 并推送 -> 创建 GitHub Release 并上传安装器。

.DESCRIPTION
版本号取自 apps/desktop/package.json 的 version 字段，与安装器文件名
(dsh-setup-<version>-win-x64.exe) 一致。tag 形如 desktop-v<version>，
刻意与上游 npm 发布序列 dsh-v* 区分。版本号带 "-"（如 rc/beta）的
自动标记为 Prerelease。

依赖 git；发布环节优先用 gh CLI（自动从 origin 解析仓库），未安装 gh
时回退到 GitHub REST API（需要环境变量 GITHUB_TOKEN 或文件
.github-release-token 里的 PAT，权限 repo；public 仓库上传资产只需
public_repo）。

.PARAMETER DryRun
只校验与打印将执行的动作，不打 tag、不推送、不建 Release。

.EXAMPLE
.\release-desktop.ps1 -DryRun
#>
[CmdletBinding()]
param(
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot
try {
  function Stop-Release([string]$Message) {
    Write-Host ''
    Write-Host "发版终止：$Message" -ForegroundColor Red
    exit 1
  }

  function Confirm-Step([string]$Question) {
    if ($DryRun) { return $false }
    $answer = Read-Host "$Question (y/N)"
    return ($answer -eq 'y' -or $answer -eq 'Y')
  }

  # --- 1. 版本号 ---------------------------------------------------------
  $version = (Get-Content 'apps/desktop/package.json' -Raw | ConvertFrom-Json).version
  if (-not $version) { Stop-Release 'apps/desktop/package.json 缺少 version 字段' }
  $tag = "desktop-v$version"
  Write-Host "桌面版版本：$version    tag：$tag" -ForegroundColor Cyan

  # --- 2. 安装器产物 -----------------------------------------------------
  $installer = Join-Path $repoRoot "apps/desktop/dist-release/dsh-setup-$version-win-x64.exe"
  if (-not (Test-Path $installer)) {
    Stop-Release "找不到安装器 $installer —— 请先运行 pnpm run desktop:build"
  }
  $sizeMb = [math]::Round((Get-Item $installer).Length / 1MB, 1)
  Write-Host "安装器：$(Split-Path $installer -Leaf) ($sizeMb MB)" -ForegroundColor Cyan

  # --- 3. 工具依赖 -------------------------------------------------------
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Stop-Release '未找到 git' }
  # winget/MSI 装的 gh 在固定目录；从资源管理器双击启动的进程可能继承
  # 安装前的陈旧 PATH，这里按固定目录兜底探测。
  foreach ($ghDir in @('C:\Program Files\GitHub CLI', 'C:\Program Files (x86)\GitHub CLI')) {
    if ((Test-Path (Join-Path $ghDir 'gh.exe')) -and ($env:PATH -notlike "*$ghDir*")) {
      $env:PATH = "$ghDir;$env:PATH"
    }
  }
  $gh = Get-Command gh -ErrorAction SilentlyContinue
  if ($gh) {
    # 装了 gh 但未登录时不可用，回退到 REST API（PAT）通道。
    # 临时放宽 ErrorActionPreference：Stop 会把 gh 的 stderr 提示变成终止性错误。
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & gh auth status 2>&1 | Out-Null
    $ErrorActionPreference = $prevEap
    if ($LASTEXITCODE -ne 0) { $gh = $null }
  }
  $remoteUrl = (git remote get-url origin) 2>&1
  if ($LASTEXITCODE -ne 0) { Stop-Release 'git remote origin 未配置' }

  # --- 4. 预检（不产生任何副作用） ----------------------------------------
  $localTag = git tag --list $tag
  $dirty = git status --porcelain
  Write-Host ''
  Write-Host '预检：' -ForegroundColor Yellow
  if ($localTag) { Write-Host "  - 本地已存在 tag $tag，将跳过打 tag，直接发布" }
  if ($dirty) {
    Write-Host '  - 工作区有未提交改动；tag 将指向当前 HEAD' -ForegroundColor Yellow
    Write-Host ($dirty | ForEach-Object { "      $_" })
  } else {
    Write-Host '  - 工作区干净'
  }

  # --- 5. 打 tag 并推送 ---------------------------------------------------
  if ($DryRun) {
    Write-Host ''
    Write-Host "[DryRun] 将执行：git tag $tag; git push origin $tag" -ForegroundColor DarkGray
  } elseif (-not $localTag) {
    if (-not (Confirm-Step "在 $(git rev-parse --short HEAD) 上打 tag $tag 并推送到 origin？")) {
      Stop-Release '用户取消'
    }
    git tag $tag
    if ($LASTEXITCODE -ne 0) { Stop-Release 'git tag 失败' }
    git push origin $tag
    if ($LASTEXITCODE -ne 0) { Stop-Release 'git push tag 失败' }
    Write-Host "已推送 $tag" -ForegroundColor Green
  }

  # --- 6. 是否 Prerelease --------------------------------------------------
  $prerelease = $version -match '-'

  # --- 7. 创建 Release 并上传安装器 ----------------------------------------
  if ($DryRun) {
    Write-Host "[DryRun] 将创建 Release：tag=$tag 标题='Desktop v$version' Prerelease=$prerelease 资产=$(Split-Path $installer -Leaf)" -ForegroundColor DarkGray
    Write-Host ''
    Write-Host 'DryRun 完成，未做任何变更。' -ForegroundColor Green
    exit 0
  }

  if (-not (Confirm-Step "创建 Release（Prerelease=$prerelease）并上传 $sizeMb MB 安装器？")) {
    Stop-Release '用户取消'
  }

  if ($gh) {
    $ghArgs = @('release', 'create', $tag, $installer, '--title', "Desktop v$version", '--notes', "DeepSeek Harness 桌面版 v$version（Windows x64 NSIS 安装器）。")
    if ($prerelease) { $ghArgs += '--prerelease' }
    & gh @ghArgs
    if ($LASTEXITCODE -ne 0) { Stop-Release 'gh release create 失败' }
    $url = (& gh release view $tag --json url --jq .url) 2>&1
  } else {
    # 回退：GitHub REST API。token 来源：环境变量 GITHUB_TOKEN > .github-release-token
    $token = $env:GITHUB_TOKEN
    if (-not $token -and (Test-Path '.github-release-token')) {
      $token = (Get-Content '.github-release-token' -Raw).Trim()
    }
    if (-not $token) {
      Stop-Release '未安装 gh CLI，且未提供 PAT。任选其一：(1) winget install GitHub.cli 后运行 gh auth login；(2) 设置环境变量 GITHUB_TOKEN（或创建文件 .github-release-token），PAT 需 repo 权限'
    }
    if ($remoteUrl -notmatch 'github\.com[:/](.+?)/(.+?)(\.git)?$') {
      Stop-Release "无法从 origin 解析仓库：$remoteUrl"
    }
    $repoSlug = "$($Matches[1])/$($Matches[2])"
    $headers = @{
      Authorization  = "Bearer $token"
      Accept         = 'application/vnd.github+json'
      'X-GitHub-Api-Version' = '2022-11-28'
    }
    $body = @{
      tag_name = $tag
      name     = "Desktop v$version"
      body     = "DeepSeek Harness 桌面版 v$version（Windows x64 NSIS 安装器）。"
      prerelease = $prerelease
    } | ConvertTo-Json -Compress
    try {
      $release = Invoke-RestMethod -Method Post -Uri "https://api.github.com/repos/$repoSlug/releases" -Headers $headers -Body $body -ContentType 'application/json; charset=utf-8'
    } catch {
      if ($_.Exception.Response.StatusCode.value__ -eq 422) {
        Stop-Release "Release 已存在（tag $tag 可能已发过）。到 GitHub Releases 页面手动补充资产，或先删除旧 Release 再重跑"
      }
      throw
    }
    $assetName = Split-Path $installer -Leaf
    $uploadUri = "$($release.upload_url -replace '\{.*}$')?name=$assetName"
    Write-Host "上传 $assetName ..." -ForegroundColor Cyan
    # 优先 curl：自带进度条与断线重试，避免大文件静默挂死。
    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if ($curl) {
      $prevEap = $ErrorActionPreference
      $ErrorActionPreference = 'Continue'
      & curl.exe -L --retry 5 --retry-delay 3 --retry-all-errors --connect-timeout 20 -H "Authorization: Bearer $token" -H 'Accept: application/vnd.github+json' -H 'Content-Type: application/octet-stream' --data-binary "@$installer" -o (Join-Path $env:TEMP 'dsh-release-upload-response.json') $uploadUri
      $ErrorActionPreference = $prevEap
      if ($LASTEXITCODE -ne 0) { Stop-Release "curl 上传失败（exit $LASTEXITCODE），重跑脚本即可重试" }
    } else {
      # 无 curl 时回退到内存一次性 POST（无进度显示）。
      $uploadHeaders = @{ Authorization = "Bearer $token"; 'Content-Type' = 'application/octet-stream' }
      $bytes = [System.IO.File]::ReadAllBytes($installer)
      Invoke-RestMethod -Method Post -Uri $uploadUri -Headers $uploadHeaders -Body $bytes | Out-Null
    }
    $url = $release.html_url
  }

  Write-Host ''
  Write-Host "发布完成：$url" -ForegroundColor Green
} finally {
  Pop-Location
}
