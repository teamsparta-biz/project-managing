#!/bin/zsh
# 교육 가져오기(ax-hub → 웹앱) 자동 실행 — launchd에서 평일 오전 10시·오후 1시·오후 5시 호출
# 수동 실행: scripts/sync-daily.sh [담당자이름] [--dry-run]

set -u

# 스크립트 위치 기준 — launchd는 ~/Documents를 못 읽으므로 스케줄은 ~/sync-runner(복사본)에서 실행한다
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CLAUDE_BIN="/Users/teamsparta/.aegis/bin/claude"
LOG="$HOME/Library/Logs/sync-ax-hub.log"
PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
export PATH

OWNER="${1:-송찬호}"
DRY=""
[[ "${2:-}" == "--dry-run" ]] && DRY=" --dry-run"

mkdir -p "$(dirname "$LOG")"
cd "$PROJECT_DIR" || { echo "[$(date '+%F %T')] 프로젝트 폴더 없음: $PROJECT_DIR" >> "$LOG"; exit 1; }

echo "" >> "$LOG"
echo "===== [$(date '+%F %T')] 교육 가져오기 시작 (담당자: $OWNER)$DRY =====" >> "$LOG"

# 복사본(SYNC_PULL=1)은 실행 전에 최신 스킬·스크립트로 맞춘다
if [[ "${SYNC_PULL:-}" == "1" ]]; then
  git pull --ff-only >> "$LOG" 2>&1 || echo "[$(date '+%F %T')] git pull 실패 — 기존 버전으로 진행" >> "$LOG"
fi

"$CLAUDE_BIN" -p "/sync-ax-hub 담당자:${OWNER}${DRY}" \
  --permission-mode acceptEdits \
  --allowedTools "Skill" "mcp__ax-hub__query_sql" "Write" "Bash(node scripts/sync-ax-hub.js:*)" \
  >> "$LOG" 2>&1
RC=$?

echo "===== [$(date '+%F %T')] 종료 (exit=$RC) =====" >> "$LOG"
exit $RC
