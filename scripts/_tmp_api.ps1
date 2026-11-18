param(
  [string]$Email,
  [string]$Password
)
$ErrorActionPreference = "Stop"
$anon = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZoaXZraWNtcXdqaXlwdmJzc2J2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIzODM2MTUsImV4cCI6MjEwNzk1OTYxNX0.HubY19CKmXVkWdac0Ngs989MAZZ0azfrA1P_OmBEmhc"
$biz = "2f3788b8-e48e-4dbd-8e55-98c82c618be6"
$base = "http://localhost:5000/api"

$tokResp = Invoke-RestMethod -Uri "https://vhivkicmqwjiypvbssbv.supabase.co/auth/v1/token?grant_type=password" -Method Post -Headers @{ apikey = $anon; "Content-Type"="application/json" } -Body (@{ email=$Email; password=$Password } | ConvertTo-Json) -TimeoutSec 25
$tok = $tokResp.access_token
$h = @{ Authorization = "Bearer $tok"; "Content-Type"="application/json"; "x-business-id"=$biz }

function Get-Api($p) { try { Invoke-RestMethod -Uri "$base/$p" -Headers $h -TimeoutSec 30 } catch { Write-Output "GET $p -> ERR $($_.ErrorDetails.Message)"; $null } }
function Post-Api($p, $body) { try { Invoke-RestMethod -Uri "$base/$p" -Method Post -Headers $h -Body ($body | ConvertTo-Json -Depth 8) -TimeoutSec 30 } catch { Write-Output "POST $p -> ERR $($_.ErrorDetails.Message)"; $null } }
function Patch-Api($p, $body) { try { Invoke-RestMethod -Uri "$base/$p" -Method Patch -Headers $h -Body ($body | ConvertTo-Json -Depth 8) -TimeoutSec 30 } catch { Write-Output "PATCH $p -> ERR $($_.ErrorDetails.Message)"; $null } }
