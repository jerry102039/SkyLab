#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$PROJECT_ROOT/.main.pid"

stop_pid() {
    local pid="$1"

    if kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
        echo "已送出停止訊號給 PID: $pid"
    else
        echo "PID $pid 不存在或已停止"
    fi
}

if [[ -f "$PID_FILE" ]]; then
    PID="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ -n "$PID" ]]; then
        stop_pid "$PID"
    else
        echo "PID 檔案內容為空，已清理。"
    fi
    rm -f "$PID_FILE"
    exit 0
fi

echo "找不到 PID 檔案，嘗試以程序名稱搜尋 main.py..."
MATCHED_PIDS="$(pgrep -f "python.*main.py" || true)"

if [[ -z "$MATCHED_PIDS" ]]; then
    echo "沒有偵測到執行中的 main.py"
    exit 0
fi

while IFS= read -r pid; do
    [[ -n "$pid" ]] && stop_pid "$pid"
done <<< "$MATCHED_PIDS"