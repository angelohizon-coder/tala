$content = Get-Content -Raw src\pages\LedgerPages.tsx
$content = $content -replace '\{\} as Record<string, number>', '{} as Record<string, Record<string, number>>'
[System.IO.File]::WriteAllText('src\pages\LedgerPages.tsx', $content)
