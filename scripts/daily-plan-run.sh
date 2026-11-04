#!/bin/zsh
# 오늘의 업무 정리 자동 실행 — launchd(co.teamsparta.daily-plan)가 평일 오전 9시에 호출
# 수동 실행: scripts/daily-plan-run.sh

set -u

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CLAUDE_BIN="/Users/teamsparta/.aegis/bin/claude"
LOG="$HOME/Library/Logs/daily-plan.log"
PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
export PATH

mkdir -p "$(dirname "$LOG")"
cd "$PROJECT_DIR" || { echo "[$(date '+%F %T')] 프로젝트 폴더 없음: $PROJECT_DIR" >> "$LOG"; exit 1; }

echo "" >> "$LOG"
echo "===== [$(date '+%F %T')] 오늘의 업무 정리 시작 =====" >> "$LOG"

# 복사본(SYNC_PULL=1)은 실행 전에 최신 스킬·스크립트로 맞춘다
if [[ "${SYNC_PULL:-}" == "1" ]]; then
  git pull --ff-only >> "$LOG" 2>&1 || echo "[$(date '+%F %T')] git pull 실패 — 기존 버전으로 진행" >> "$LOG"
fi

"$CLAUDE_BIN" -p "/daily-plan --auto" \
  --allowedTools "Skill" "Bash(node scripts/daily-plan.js:*)" "Read" \
    "mcp__claude_ai_Google_Calendar__list_events" "mcp__claude_ai_Slack__slack_send_message" \
  >> "$LOG" 2>&1
RC=$?

echo "===== [$(date '+%F %T')] 종료 (exit=$RC) =====" >> "$LOG"
exit $RC
