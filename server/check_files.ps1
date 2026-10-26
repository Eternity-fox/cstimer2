$html = Get-Content .\src\index.html -Raw
$matches = [regex]::Matches($html, 'src=[\x27\x22]([^\x27\x22]+)[\x27\x22]')
Write-Host "Total script tags found: $($matches.Count)"
$missingCount = 0
foreach ($m in $matches) {
    $src = $m.Groups[1].Value
    if ($src -like "data:*" -or $src -like "http*") { continue }
    $localFile = Join-Path "src" $src
    if (-not (Test-Path $localFile)) {
        Write-Host "MISSING: $localFile" -ForegroundColor Red
        $missingCount++
    }
}
Write-Host "Done. Missing: $missingCount"
