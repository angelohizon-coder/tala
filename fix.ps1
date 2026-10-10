$content = Get-Content -Raw src\pages\LedgerPages.tsx
$content = $content -replace 'account\?\.openingBalance \|\| 0', 'account?.openingBalances?.[account?.currency || ''PHP''] ?? account?.openingBalance ?? 0'
$content = $content -replace 'openingBalance, openingDate', 'openingBalances: { [currency]: openingBalance }, openingBalance, openingDate'
$content = $content -replace 'balances\[account\.id\] \?\? account\.openingBalance', 'balances[account.id]?.[account.currency] ?? account.openingBalances?.[account.currency] ?? account.openingBalance ?? 0'
[System.IO.File]::WriteAllText('src\pages\LedgerPages.tsx', $content)
