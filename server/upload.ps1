# Windows 一键上传 Realm 配置文件到 Linux 服务器
param (
    [string]$ServerIP = "",
    [int]$Port = 22,
    [string]$User = "root"
)

if (-not $ServerIP) {
    $ServerIP = Read-Host "请输入你的 Linux 服务器 IP"
}

$currentDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$configFile = Join-Path $currentDir "config.toml"

if (-not (Test-Path $configFile)) {
    Write-Host "❌ 未找到本地配置文件: $configFile" -ForegroundColor Red
    exit 1
}

Write-Host "`n🚀 准备上传配置到服务器: ${User}@${ServerIP}:${Port}" -ForegroundColor Cyan
Write-Host "目标目录: /etc/realm/config.toml`n" -ForegroundColor Yellow

# 先确保服务器存在 /etc/realm 目录，然后上传
ssh -p $Port "${User}@${ServerIP}" "mkdir -p /etc/realm"
scp -P $Port $configFile "${User}@${ServerIP}:/etc/realm/config.toml"

if ($LASTEXITCODE -eq 0) {
    Write-Host "`n✅ 上传成功！" -ForegroundColor Green
    Write-Host "现在你可以在服务器上启动或重启 realm 即可。" -ForegroundColor Green
} else {
    Write-Host "`n❌ 上传失败，请检查 IP、端口和密码。" -ForegroundColor Red
}
