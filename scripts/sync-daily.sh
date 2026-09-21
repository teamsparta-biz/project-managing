#!/bin/zsh
# 교육 가져오기(ax-hub → 웹앱) 자동 실행 — launchd에서 매일 오전 10시 호출
# 수동 실행: scripts/sync-daily.sh [담당자이름] [--dry-run]

set -u

PROJECT_DIR="/Users/teamsparta/Library/CloudStorage/GoogleDrive-chanho.song@teamsparta.co/내 드라이브/Project_managing_tool"
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

"$CLAUDE_BIN" -p "/sync-ax-hub 담당자:${OWNER}${DRY}" \
  --permission-mode acceptEdits \
  --allowedTools "Skill" "mcp__ax-hub__query_sql" "Write" "Bash(node scripts/sync-ax-hub.js:*)" \
  >> "$LOG" 2>&1
RC=$?

echo "===== [$(date '+%F %T')] 종료 (exit=$RC) =====" >> "$LOG"
exit $RC
