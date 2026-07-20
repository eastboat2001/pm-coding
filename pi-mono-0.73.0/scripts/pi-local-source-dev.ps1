param(
	[switch]$SkipDocker,
	[switch]$SkipWorkerBuild,
	[string]$PostgresPort = $(if ($env:PI_POSTGRES_PORT) { $env:PI_POSTGRES_PORT } else { "5432" }),
	[string]$RedisPort = $(if ($env:PI_REDIS_PORT) { $env:PI_REDIS_PORT } else { "6379" })
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$composeFile = Join-Path $repoRoot "docker\pi-coding-web\docker-compose.yaml"
Set-Location $repoRoot

$postgresDb = if ($env:PI_POSTGRES_DB) { $env:PI_POSTGRES_DB } else { "pi_coding" }
$postgresUser = if ($env:PI_POSTGRES_USER) { $env:PI_POSTGRES_USER } else { "pi" }
$postgresPassword = if ($env:PI_POSTGRES_PASSWORD) { $env:PI_POSTGRES_PASSWORD } else { "pi" }

$env:PI_RUNTIME_STORE = "postgres"
$env:PI_POSTGRES_URL = "postgres://${postgresUser}:${postgresPassword}@127.0.0.1:${PostgresPort}/${postgresDb}"
$env:PI_REDIS_URL = "redis://127.0.0.1:${RedisPort}"
$env:PI_AGENT_V2_RUN_QUEUE_NAME = if ($env:PI_AGENT_V2_RUN_QUEUE_NAME) {
	$env:PI_AGENT_V2_RUN_QUEUE_NAME
} else {
	"pi:agent-v2:runs:local"
}
$env:PI_WORKER_ID = if ($env:PI_WORKER_ID) { $env:PI_WORKER_ID } else { "pi-local-worker" }

Write-Host "PI_RUNTIME_STORE=$env:PI_RUNTIME_STORE"
Write-Host "PI_POSTGRES_URL configured for local PostgreSQL (value hidden)"
Write-Host "PI_REDIS_URL=$env:PI_REDIS_URL"
Write-Host "PI_AGENT_V2_RUN_QUEUE_NAME=$env:PI_AGENT_V2_RUN_QUEUE_NAME"

if (-not $SkipDocker) {
	Write-Host "Starting Docker dependencies: postgres redis"
	if (-not $env:PI_POSTGRES_IMAGE) {
		docker image inspect postgres:16-alpine *> $null
		if ($LASTEXITCODE -ne 0) {
			docker image inspect postgres:17 *> $null
			if ($LASTEXITCODE -eq 0) {
				$env:PI_POSTGRES_IMAGE = "postgres:17"
				Write-Host "Using existing local image PI_POSTGRES_IMAGE=$env:PI_POSTGRES_IMAGE"
			}
		}
	}

	$redisContainer = docker ps -a --filter "name=^/pi-coding-redis$" --format "{{.Names}}"
	if ($redisContainer) {
		Write-Host "Reusing existing pi-coding-redis container"
		$redisRunning = docker ps --filter "name=^/pi-coding-redis$" --format "{{.Names}}"
		if (-not $redisRunning) {
			docker start pi-coding-redis | Out-Null
		}
		$redisPort = docker port pi-coding-redis 6379/tcp 2> $null
		if (-not $redisPort) {
			Write-Warning "Existing pi-coding-redis does not expose 6379 to the host. Recreate it before running source dev."
		}
		docker compose -f $composeFile up -d postgres
	} else {
		docker compose -f $composeFile up -d postgres redis
	}
	docker compose -f $composeFile ps postgres redis
}

if ($SkipWorkerBuild) {
	Write-Warning "-SkipWorkerBuild is deprecated and ignored because a stale worker can execute obsolete generation limits."
}

Write-Host ""
Write-Host "Starting local source web and worker. Open http://localhost:5173"
Write-Host "Press Ctrl+C to stop both processes."

& "$repoRoot\node_modules\.bin\concurrently.cmd" `
	--names "web,worker" `
	--prefix-colors "cyan,yellow" `
	"npm run dev --workspace=pi-coding-web" `
	"npm run worker --workspace=pi-coding-web"
