# One-time, per-user registration. A click on the deployed Scorebook page can
# then start the local launcher without keeping a helper running at login.
$scheme = 'HKCU:\Software\Classes\sluggers-game'
$commandKey = Join-Path $scheme 'shell\open\command'
$powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
$handler = Join-Path $PSScriptRoot 'game_protocol_handler.ps1'
$command = '"' + $powershell + '" -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $handler + '" "%1"'

if (Test-Path $commandKey) {
    $existing = (Get-Item $commandKey).GetValue('')
    if ($existing -and $existing -ne $command) {
        throw 'sluggers-game is already registered to another command. Registration was left unchanged.'
    }
}

New-Item -Path $commandKey -Force | Out-Null
Set-Item -Path $scheme -Value 'URL:Sluggers Game Launcher'
New-ItemProperty -Path $scheme -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
Set-Item -Path $commandKey -Value $command
Write-Output 'Sluggers Game links are registered for this Windows user.'
