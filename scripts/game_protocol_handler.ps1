param([Parameter(Mandatory = $true)][string]$Uri)

$node = (Get-Command node.exe -ErrorAction Stop).Source
$launcher = Join-Path $PSScriptRoot 'game_protocol_launcher.mjs'
& $node $launcher $Uri
exit $LASTEXITCODE
