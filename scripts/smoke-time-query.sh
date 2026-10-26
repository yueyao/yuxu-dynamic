#!/usr/bin/env bash
# 在允许监听本机端口的环境中启动独立 API、Worker 和 CLI 进程，验证真实 HTTP 链路。
set -euo pipefail

cd "$(dirname "$0")/.."
run_dir="$(mktemp -d)"
api_pid=""
worker_pid=""

cleanup() {
  local status="$1"
  if [[ -n "$worker_pid" ]]; then kill "$worker_pid" 2>/dev/null || true; fi
  if [[ -n "$api_pid" ]]; then kill "$api_pid" 2>/dev/null || true; fi
  if [[ "$status" -ne 0 ]]; then
    echo 'API 日志:' >&2
    cat "$run_dir/api.log" >&2 2>/dev/null || true
    echo 'Worker 日志:' >&2
    cat "$run_dir/worker.log" >&2 2>/dev/null || true
  fi
  rm -rf "$run_dir"
}
trap 'cleanup $?' EXIT

export PLATFORM_DATA_DIR="$run_dir/platform"
export TIME_CLI_DIR="$run_dir/client"
export PLATFORM_ADMIN_PASSWORD="$(node -e "process.stdout.write(require('node:crypto').randomBytes(24).toString('hex'))")"
export TIME_CLI_PASSWORD="$PLATFORM_ADMIN_PASSWORD"
export PORT="${PORT:-3333}"
export PLATFORM_URL="http://127.0.0.1:$PORT"

node apps/platform-api/src/bootstrap.ts
node apps/platform-api/src/register-app.ts apps/time-worker/manifest.json
node apps/platform-api/src/main.ts >"$run_dir/api.log" 2>&1 &
api_pid=$!

ready=0
for _ in {1..50}; do
  if curl -fsS --max-time 1 "$PLATFORM_URL/health" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.1
done
if [[ "$ready" -ne 1 ]]; then
  echo 'API 未在预期端口启动' >&2
  exit 1
fi

node apps/time-worker/src/main.ts >"$run_dir/worker.log" 2>&1 &
worker_pid=$!
node apps/time-cli/src/main.ts config set-server "$PLATFORM_URL"
node apps/time-cli/src/main.ts login
node apps/time-cli/src/main.ts query time --json --timeout 20
