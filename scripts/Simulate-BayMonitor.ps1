# Sentinel device protocol v1 smoke harness. Runs on Windows PowerShell 5.1+ or PowerShell 7.
# Provision a BayMonitor credential in Setup > Device registry first.
# Examples:
# .\Simulate-BayMonitor.ps1 -Serial TEST-BM-001 -Action Go -Latitude -36.24 -Longitude 145.5
# Confirm on the Sentinel Deploy screen, then:
# .\Simulate-BayMonitor.ps1 -Serial TEST-BM-001 -Action Apply -ConfigurationVersion 1
# .\Simulate-BayMonitor.ps1 -Serial TEST-BM-001 -Action Water
# .\Simulate-BayMonitor.ps1 -Serial TEST-BM-001 -Action SmsSent -RelatedEventId BM001-00083 -Phone 0411222333
# .\Simulate-BayMonitor.ps1 -Serial TEST-BM-001 -Action Ack -RelatedEventId BM001-00083 -Phone 0411222333
# Keep the unique EventId and resend an identical event to verify deduplication.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$Serial,
    [Parameter(Mandatory=$true)][ValidateSet('Go','Poll','Apply','Water','Dry','SmsSent','SmsFailed','Ack','CommandApplied','Fallback')][string]$Action,
    [string]$ApiUrl = 'https://sentinel-api-dev01-aub0efeufxhzbqhw.australiasoutheast-01.azurewebsites.net',
    [double]$Latitude = -36.243056,
    [double]$Longitude = 145.5055,
    [string]$GoId = '',
    [string]$EventId = '',
    [string]$RelatedEventId = '',
    [string]$CommandId = '',
    [string]$Phone = '',
    [int]$ConfigurationVersion = 0,
    [int]$BatteryPercent = 85
)
$ErrorActionPreference = 'Stop'
if (-not $EventId) { $EventId = [guid]::NewGuid().ToString() }
if (-not $GoId) { $GoId = [guid]::NewGuid().ToString() }
$secure = Read-Host -AsSecureString -Prompt 'BayMonitor device key (not your Entra token)'
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { $key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
if (-not $key) { throw 'Device key required' }
$body = @{ batteryPercent = $BatteryPercent; events = @() }
$event = @{eventId=$EventId; at=[DateTime]::UtcNow.ToString('o')}
switch ($Action) {
    'Go' { $body.goId=$GoId; $body.latitude=$Latitude; $body.longitude=$Longitude; $body.wet=$false; break }
    'Poll' { break }
    'Apply' { if ($ConfigurationVersion -lt 1) { throw 'Supply -ConfigurationVersion (from server response)' }; $body.configAppliedVersion=$ConfigurationVersion; $event.type='CONFIG_APPLIED'; $body.events=@($event); break }
    'Water' { $body.wet=$true; $event.type='WATER_DETECTED'; $body.events=@($event); break }
    'Dry' { $body.wet=$false; $event.type='WATER_CLEARED'; $body.events=@($event); break }
    'SmsSent' { if(-not $RelatedEventId -or -not $Phone){throw 'Supply -RelatedEventId and -Phone'}; $event.type='SMS_SENT'; $event.relatedEventId=$RelatedEventId; $event.recipient=$Phone; $event.modemResult='SIMULATED_ACCEPTED'; $body.events=@($event); break }
    'SmsFailed' { if(-not $RelatedEventId -or -not $Phone){throw 'Supply -RelatedEventId and -Phone'}; $event.type='SMS_FAILED'; $event.relatedEventId=$RelatedEventId; $event.recipient=$Phone; $event.modemResult='SIMULATED_FAILURE'; $body.events=@($event); break }
    'Ack' { if(-not $RelatedEventId -or -not $Phone){throw 'Supply -RelatedEventId and -Phone'}; $event.type='ALERT_ACKNOWLEDGED'; $event.relatedEventId=$RelatedEventId; $event.sender=$Phone; $body.events=@($event); break }
    'CommandApplied' { if(-not $CommandId){throw 'Supply -CommandId'}; $event.type='COMMAND_APPLIED';$event.commandId=$CommandId;$body.events=@($event);break }
    'Fallback' {$event.type='LOCAL_FALLBACK';$body.events=@($event);break}
}
# PowerShell ConvertTo-Json preserves arrays with this explicit array assignment.
$json = ConvertTo-Json -InputObject $body -Depth 10 -Compress
Write-Host "Action: $Action | Serial: $Serial | EventId: $EventId"
if ($Action -eq 'Go') { Write-Host "GO ID: $GoId" }
try {
    $response = Invoke-RestMethod -Method Post -Uri "$($ApiUrl.TrimEnd('/'))/api/device/v1/$([uri]::EscapeDataString($Serial.ToUpperInvariant()))/checkin" `
        -Headers @{'X-Sentinel-Device-Key'=$key} -ContentType 'application/json' -Body $json
    $response | ConvertTo-Json -Depth 15
} finally { $key = $null }
