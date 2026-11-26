[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$PostgresBin,
    [string]$OpenSsl = 'C:\Program Files\Git\usr\bin\openssl.exe'
)

$ErrorActionPreference = 'Stop'
$backend = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$ml = (Resolve-Path -LiteralPath (Join-Path $backend '..\abc-ml')).Path
$postgresBinPath = (Resolve-Path -LiteralPath $PostgresBin).Path
$python = Join-Path $ml '.venv\Scripts\python.exe'
$model = Join-Path $ml 'artifacts\run-next-day-42'
$prisma = Join-Path $backend 'node_modules\.bin\prisma.cmd'
$tsNode = Join-Path $backend 'node_modules\ts-node\dist\bin.js'
$node = (Get-Command node.exe -ErrorAction Stop).Source
$initdb = Join-Path $postgresBinPath 'initdb.exe'
$postgres = Join-Path $postgresBinPath 'postgres.exe'
$isReady = Join-Path $postgresBinPath 'pg_isready.exe'
$psql = Join-Path $postgresBinPath 'psql.exe'
$createdb = Join-Path $postgresBinPath 'createdb.exe'
$pgCtl = Join-Path $postgresBinPath 'pg_ctl.exe'
foreach ($file in @($python, (Join-Path $model 'metadata.json'), $prisma, $tsNode, $OpenSsl,
                    $initdb, $postgres, $isReady, $psql, $createdb, $pgCtl)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Required file not found: $file" }
}

$environmentNames = @(
    'DATABASE_URL', 'DIRECT_URL', 'PGPASSWORD', 'PGSSLMODE', 'PGHOST', 'PGPORT',
    'FORECAST_RESEARCH_URL', 'FORECAST_RESEARCH_TOKEN', 'FORECAST_API_TOKEN', 'MODEL_DIR',
    'AI_FORECAST_TEST_BUSINESS', 'AI_FORECAST_TEST_SKU', 'AI_FORECAST_TEST_DEMO_PREFIX',
    'AI_FORECAST_CREATE_TEMP_BUSINESS', 'AI_FORECAST_ISOLATED_FLOW', 'AI_DEMO_PREFIX',
    'DOTENV_CONFIG_PATH', 'DOTENV_CONFIG_OVERRIDE', 'TS_NODE_PROJECT'
)
$previousEnvironment = @{}
foreach ($name in $environmentNames) {
    $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

function Invoke-Checked {
    param([string]$Executable, [string[]]$Arguments)
    $oldPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = @(& $Executable @Arguments 2>&1)
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $oldPreference
    }
    foreach ($line in $output) {
        $text = [string]$line
        if ($script:password) { $text = $text.Replace($script:password, '[redacted]') }
        if ($script:token) { $text = $text.Replace($script:token, '[redacted]') }
        Write-Host $text
    }
    if ($code -ne 0) { throw "$([IO.Path]::GetFileName($Executable)) failed with exit code $code" }
}

function Get-FreePort {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    try {
        $listener.Start()
        return $listener.LocalEndpoint.Port
    } finally {
        $listener.Stop()
    }
}

function Stop-OwnedProcess {
    param([System.Diagnostics.Process]$Process, [string]$PostgresData = '')
    if ($null -eq $Process) { return }
    $Process.Refresh()
    $start = $Process.StartTime
    $start = $start.AddTicks(-($start.Ticks % 10))
    $end = if ($Process.HasExited) { $Process.ExitTime } else { [DateTime]::MaxValue }
    $all = @(Get-CimInstance Win32_Process)
    $owned = [System.Collections.Generic.List[object]]::new()
    $owned.Add([pscustomobject]@{ ProcessId = $Process.Id; CreationDate = $start })
    for ($i = 0; $i -lt $owned.Count; $i++) {
        $parent = $owned[$i]
        foreach ($child in $all | Where-Object {
            $_.ParentProcessId -eq $parent.ProcessId -and $_.CreationDate -ge $parent.CreationDate -and
            $_.CreationDate -le $end
        }) {
            $owned.Add($child)
        }
    }
    $shutdownError = $null
    if ($PostgresData -and -not $Process.HasExited) {
        try {
            $pidFile = Join-Path $PostgresData 'postmaster.pid'
            $pidLine = Get-Content -LiteralPath $pidFile -TotalCount 1
            if ($pidLine -ne [string]$Process.Id) { throw 'PostgreSQL PID file does not match the started process.' }
            Invoke-Checked $pgCtl @('stop', '-D', $PostgresData, '-m', 'fast', '-w', '-t', '30')
        } catch {
            $shutdownError = $_
        }
    }
    foreach ($item in $owned) {
        $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($item.ProcessId)"
        if ($null -eq $current) { continue }
        if ($current.CreationDate -ne $item.CreationDate) {
            throw "Process $($item.ProcessId) was replaced; refusing to stop it."
        }
        $target = Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue
        if ($null -ne $target) {
            Stop-Process -Id $item.ProcessId -ErrorAction Stop
            if (-not $target.WaitForExit(30000)) { throw "Process $($item.ProcessId) did not exit." }
        }
    }
    if ($shutdownError) { throw $shutdownError }
}

function Assert-PortClosed {
    param([int]$Port)
    if ($Port -eq 0) { return }
    for ($i = 0; $i -lt 30; $i++) {
        $client = [Net.Sockets.TcpClient]::new()
        try {
            $client.Connect('127.0.0.1', $Port)
        } catch [Net.Sockets.SocketException] {
            return
        } finally {
            $client.Dispose()
        }
        Start-Sleep -Milliseconds 500
    }
    throw "Temporary port $Port is still listening; refusing to remove its files."
}

$work = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) "abc-forecast-test-$([Guid]::NewGuid().ToString('N'))"))
$data = Join-Path $work 'data'
$dbProcess = $null
$forecastProcess = $null
$dbPort = 0
$forecastPort = 0
$workCreated = $false
$locationPushed = $false
$script:password = ''
$script:token = ''
try {
    if (Test-Path -LiteralPath $work) { throw "Temporary directory already exists: $work" }
    New-Item -ItemType Directory -Path $work -ErrorAction Stop | Out-Null
    $workCreated = $true
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
        [Security.Principal.WindowsIdentity]::GetCurrent().User, 'FullControl',
        'ContainerInherit, ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $work -AclObject $acl
    Push-Location $work
    $locationPushed = $true
    [IO.File]::WriteAllText((Join-Path $work '.env'), '')
    $env:DOTENV_CONFIG_PATH = Join-Path $work '.env'
    $env:DOTENV_CONFIG_OVERRIDE = 'false'
    $env:TS_NODE_PROJECT = Join-Path $backend 'tsconfig.json'
    $env:PGHOST = '127.0.0.1'
    $env:PGSSLMODE = 'require'
    $script:password = [Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N')
    $script:token = [Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N')
    $passwordFile = Join-Path $work 'password'
    [IO.File]::WriteAllText($passwordFile, $script:password, [Text.UTF8Encoding]::new($false))
    Invoke-Checked $initdb @('-D', $data, '-U', 'forecast_test', '--encoding=UTF8', '--locale=C',
                            '--auth=scram-sha-256', '--pwfile', $passwordFile, '--no-instructions')
    Invoke-Checked $OpenSsl @('req', '-x509', '-newkey', 'rsa:2048', '-nodes',
                               '-keyout', (Join-Path $data 'server.key'), '-out', (Join-Path $data 'server.crt'),
                               '-days', '1', '-subj', '/CN=localhost')
    $dbPort = Get-FreePort
    $env:PGPORT = [string]$dbPort
    $env:PGPASSWORD = $script:password
    $dbProcess = Start-Process -FilePath $postgres -ArgumentList @(
        '-D', "`"$data`"", '-h', '127.0.0.1', '-p', "$dbPort", '-c', 'ssl=on',
        '-c', 'max_connections=20', '-c', 'shared_buffers=32MB'
    ) -RedirectStandardOutput (Join-Path $work 'postgres.out') `
      -RedirectStandardError (Join-Path $work 'postgres.err') -PassThru -NoNewWindow
    $ready = $false
    for ($i = 0; $i -lt 60; $i++) {
        $dbProcess.Refresh()
        if ($dbProcess.HasExited) { break }
        & $isReady -h 127.0.0.1 -p $dbPort -U forecast_test 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) { $ready = $true; break }
        Start-Sleep -Milliseconds 500
    }
    if (-not $ready) {
        Get-Content -LiteralPath (Join-Path $work 'postgres.err') -ErrorAction SilentlyContinue
        throw 'Temporary PostgreSQL did not become ready.'
    }
    $reported = & $psql -h 127.0.0.1 -p $dbPort -U forecast_test -d postgres -X -A -t `
        -c "SELECT current_setting('data_directory')" 2>&1
    if ($LASTEXITCODE -ne 0 -or [IO.Path]::GetFullPath(([string]$reported).Trim()) -ne $data) {
        throw 'Refusing to use a PostgreSQL server with an unexpected data directory.'
    }
    Invoke-Checked $createdb @('-h', '127.0.0.1', '-p', "$dbPort", '-U', 'forecast_test', 'forecast_integration')
    $env:DATABASE_URL = "postgresql://forecast_test:$($script:password)@127.0.0.1:$dbPort/forecast_integration?sslmode=require"
    $env:DIRECT_URL = $env:DATABASE_URL
    Invoke-Checked $prisma @('db', 'push', '--config', (Join-Path $backend 'prisma.config.ts'),
                             '--schema', (Join-Path $backend 'prisma\schema.prisma'))
    $migration = [IO.File]::ReadAllText((Join-Path $backend 'prisma\migrations\20261115220000_ai_forecast_history\migration.sql'))
    $begin = $migration.IndexOf('CREATE FUNCTION', [StringComparison]::Ordinal)
    $end = $migration.IndexOf('COMMIT;', [StringComparison]::Ordinal)
    if ($begin -lt 0 -or $end -le $begin) { throw 'History trigger not found in the migration.' }
    Invoke-Checked $psql @('-h', '127.0.0.1', '-p', "$dbPort", '-U', 'forecast_test', '-d', 'forecast_integration',
                           '-X', '-v', 'ON_ERROR_STOP=1', '-c', $migration.Substring($begin, $end - $begin))
    $businessId = [Guid]::NewGuid().ToString()
    $userId = [Guid]::NewGuid().ToString()
    $authId = [Guid]::NewGuid().ToString()
    $roleId = [Guid]::NewGuid().ToString()
    $fixture = @"
INSERT INTO businesses (id, name, phone, industry_type, status) VALUES ('$businessId', 'FORECAST-ISOLATED-TEST-$businessId', '0000000000', 'TEST', 'SUSPENDED');
INSERT INTO users (id, auth_user_id, email, full_name, status) VALUES ('$userId', '$authId', 'test@example.invalid', 'Temporary test user', 'ACTIVE');
INSERT INTO roles (id, code, scope, display_name) VALUES ('$roleId', 'TEST_OWNER', 'BUSINESS', 'Temporary test role');
INSERT INTO business_memberships (business_id, user_id, role_id, updated_at) VALUES ('$businessId', '$userId', '$roleId', now());
"@
    Invoke-Checked $psql @('-h', '127.0.0.1', '-p', "$dbPort", '-U', 'forecast_test', '-d', 'forecast_integration',
                           '-X', '-v', 'ON_ERROR_STOP=1', '-c', $fixture)
    $env:AI_DEMO_PREFIX = 'DEMO-ISO-'
    Invoke-Checked $node @($tsNode, '--project', (Join-Path $backend 'tsconfig.json'), '--transpile-only',
                           (Join-Path $backend 'scripts\seed-ai-insights-demo.ts'), $businessId)
    $env:AI_FORECAST_TEST_BUSINESS = $businessId
    $env:AI_FORECAST_TEST_SKU = 'DEMO-ISO-AT-TRANG-L'
    $env:AI_FORECAST_TEST_DEMO_PREFIX = 'DEMO-ISO-'
    $env:AI_FORECAST_CREATE_TEMP_BUSINESS = '1'
    Invoke-Checked $node @('--test', (Join-Path $backend 'tests\ai-forecast.postgres.test.cjs'),
                           (Join-Path $backend 'tests\ai-forecast.postgres-concurrency.test.cjs'))

    $forecastPort = Get-FreePort
    $env:MODEL_DIR = $model
    $env:FORECAST_API_TOKEN = $script:token
    $forecastProcess = Start-Process -FilePath $python -WorkingDirectory $ml -ArgumentList @(
        '-m', 'uvicorn', 'service:app', '--host', '127.0.0.1', '--port', "$forecastPort"
    ) -RedirectStandardOutput (Join-Path $work 'forecast.out') `
      -RedirectStandardError (Join-Path $work 'forecast.err') -PassThru -NoNewWindow
    $env:FORECAST_RESEARCH_URL = "http://127.0.0.1:$forecastPort"
    $env:FORECAST_RESEARCH_TOKEN = $script:token
    $requestId = [Guid]::NewGuid().ToString()
    $body = @{ request_id = $requestId; as_of = '2025-01-01'; variants = @(@{ variant_id = 'test'; history = @() }) } |
        ConvertTo-Json -Depth 5 -Compress
    $ready = $false
    for ($i = 0; $i -lt 60; $i++) {
        $forecastProcess.Refresh()
        if ($forecastProcess.HasExited) { break }
        try {
            $response = Invoke-RestMethod -Uri "$($env:FORECAST_RESEARCH_URL)/v1/forecasts:predict" -Method Post `
                -ContentType 'application/json' -Headers @{ 'X-Forecast-Token' = $script:token } -Body $body -TimeoutSec 2
            if ($response.request_id -eq $requestId -and $response.results[0].reason -eq 'SHORT_HISTORY') {
                $ready = $true
                break
            }
        } catch [System.Net.WebException] {
            Start-Sleep -Milliseconds 500
        }
    }
    if (-not $ready) {
        Get-Content -LiteralPath (Join-Path $work 'forecast.err') -ErrorAction SilentlyContinue
        throw 'Temporary forecast service did not become ready with the expected token.'
    }
    $env:AI_FORECAST_ISOLATED_FLOW = '1'
    Invoke-Checked $node @('--test', (Join-Path $backend 'tests\ai-forecast.postgres-flow.test.cjs'))
} finally {
    if ($locationPushed) { Pop-Location }
    $cleanupErrors = [System.Collections.Generic.List[string]]::new()
    try {
        try { Stop-OwnedProcess $forecastProcess } catch { $cleanupErrors.Add($_.ToString()) }
        try { Stop-OwnedProcess $dbProcess $data } catch { $cleanupErrors.Add($_.ToString()) }
        try { Assert-PortClosed $forecastPort } catch { $cleanupErrors.Add($_.ToString()) }
        try { Assert-PortClosed $dbPort } catch { $cleanupErrors.Add($_.ToString()) }
        if ($cleanupErrors.Count -eq 0 -and $workCreated) {
            Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction Stop
        }
        if ($cleanupErrors.Count -gt 0) {
            throw "Cleanup failed; temporary files retained at $work. $($cleanupErrors -join '; ')"
        }
    } finally {
        foreach ($name in $environmentNames) {
            [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process')
        }
        $script:password = ''
        $script:token = ''
    }
}
Write-Host 'Isolated forecast integration tests passed; temporary services and files cleaned up.'
