#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$PROJECT_ROOT/.main.pid"
LOG_FILE="$PROJECT_ROOT/main.log"

if [[ -f "$PID_FILE" ]]; then
    EXISTING_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ -n "$EXISTING_PID" ]] && kill -0 "$EXISTING_PID" 2>/dev/null; then
        echo "main.py 已在背景執行（PID: $EXISTING_PID）"
        echo "如需停止請執行: ./stop_main_bg.sh"
        exit 0
    fi
    rm -f "$PID_FILE"
fi

if [[ -x "$PROJECT_ROOT/.venv/bin/python" ]]; then
    PYTHON_BIN="$PROJECT_ROOT/.venv/bin/python"
elif command -v python3 >/dev/null 2>&1; then
    PYTHON_BIN="$(command -v python3)"
else
    echo "找不到可用的 Python（需要 python3）。"
    exit 1
fi

cd "$PROJECT_ROOT"

echo "使用 Python: $PYTHON_BIN"
echo "日誌檔案: $LOG_FILE"

nohup "$PYTHON_BIN" main.py > "$LOG_FILE" 2>&1 &
NEW_PID=$!
echo "$NEW_PID" > "$PID_FILE"

if kill -0 "$NEW_PID" 2>/dev/null; then
    echo "main.py 已背景啟動（PID: $NEW_PID）"
    echo "查看日誌: tail -f $LOG_FILE"
else
    echo "啟動失敗，請檢查日誌: $LOG_FILE"
    rm -f "$PID_FILE"
    exit 1
fi