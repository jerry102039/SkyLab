# 目前申請策略

## 目的

本文件整理目前 VM/LXC 申請流程的策略分工，讓前端 UX、後端容量評估、節點分配與 migration 行為有一致語意。

核心原則：

- 快速模板是短期、立即、自助使用。
- 研究申請是長期、日期區間、需管理員審核的資源保留。
- 不同申請類型可以共用 `start_at` / `end_at`，但不能共用同一種 UX 或容量提示方式。

## 申請類型總覽

| 類型 | 使用者語意 | 時間單位 | 核准方式 | 容量評估 | 分配策略 | Migration |
|---|---|---:|---|---|---|---|
| 快速模板 | 立即開環境 | 固定 3 小時 | 通過後自動核准 | 現在到 3 小時後是否可放 | 當下能放就放，不重排 cohort | 正常不主動 migration |
| 研究申請 | 長期研究資源 | 天 / 月 | 管理員審核 | 整段日期區間是否可安排 | 審核時可重建 reservation assignment | 可能產生 migration |
| 立即模式 | 管理者/教師立即部署 | 即時起算，可無結束 | 權限控管 | 有結束時間時檢查 window | 依現有 placement | 視現有資源狀態而定 |
| 導師/短時段預約 | 課程或短期實驗 | 小時 | 視角色與流程 | 小時級 availability | 依時段 reservation | 可能產生 migration |

## 快速模板策略

快速模板定位是「短期即時自助環境」，例如學生要快速開 PostgreSQL、MongoDB、Grafana、WordPress 等練習環境。

### 時間策略

前端不讓使用者選時間。

後端送出時固定覆寫：

```txt
start_at = now
end_at = now + 3 hours
```

使用時間固定 3 小時，到期後由 scheduler 進入關機流程。

### 容量提示

前端顯示「目前是否可立即建立」。

目前使用整段 window availability：

```txt
window = now -> now + 3 hours
mode = quick_template
```

畫面狀態：

- 可安排：目前容量可立即建立。
- 容量不足：目前不能立即建立，使用者稍後再試或降低規格。
- 檢查中：正在檢查現在到 3 小時後的容量。

### 限制

目前快速模板限制：

- 僅支援 LXC。
- 必須使用 service template。
- 模板必須在白名單內。
- 禁止 GPU。
- CPU 最多 2 cores。
- Memory 最多 4096 MB。
- Disk 最多 32 GB。
- 每位使用者同時最多 1 個快速模板。
- 每位使用者 24 小時內最多建立 3 個快速模板。

### 分配策略

快速模板採「當下能放就放」。

它不會為了自己重新分配其他研究申請或已核准資源：

```py
allow_cohort_rebalance = False
```

因此快速模板的容量預覽、送出前驗證、核准分配都必須使用相同規則，避免前端顯示可建立但送出後失敗。

### Migration 行為

正常快速模板不會主動觸發 migration。

原因：

- 它是新建 LXC。
- 它不做 cohort rebalance。
- active rebalance 應避免主動搬快速模板。

邊界情況：如果某筆快速模板資源已經有 `vmid` / `actual_node`，且系統後續算出的 `desired_node` 不同，狀態欄位可能進入 migration pending。但這不是快速模板的正常目標流程。

## 研究申請策略

研究申請定位是「長期資源保留」，適合專題、研究、課程長期環境或需要管理員控管的正式資源。

### 時間策略

研究申請以日期為主要單位。

前端顯示：

- 開始日期
- 結束日期

前端轉換為：

```txt
start_at = 開始日期 00:00 Asia/Taipei
end_at = 結束日期隔天 00:00 Asia/Taipei
```

因此申請期間會包含完整結束日期。

研究申請可能跨數週或數月，目前 UX 至少要能支援跨三個月以上的日期區間，不應用小時格呈現。

### 容量提示

研究申請不顯示逐小時格，也不要求使用者逐日挑選。

前端顯示「整段期間容量評估」：

```txt
window = start_at -> end_at
mode = research
```

畫面狀態：

- 可安排：整段期間預估可安排，仍需管理員審核。
- 容量緊張：整段期間可安排，但時間較長或壓力較高，需要管理員特別確認。
- 容量不足：整段期間目前無法安排，建議縮短期間或降低規格。

容量評估只是送出前提示；真正核准與建立仍由後端在送出與審核時重新檢查。

### 核准策略

研究申請送出後維持待審核，不自動建立。

管理員審核時，系統會再依當下最新狀態重新計算 placement。若容量狀態在使用者送出後改變，審核結果可能與前端預估不同。

### 分配策略

研究申請使用 reservation-aware placement。

它會看整段 `start_at` / `end_at` 內所有重疊的已核准申請，確認在整段期間都能安排。

如果申請時間很長，例如三個月，只要中間某一個時段因其他已核准保留導致容量不足，整段就可能被判定不可安排。

換句話說：

```txt
研究申請可安排 = 整段期間每個檢查點都可安排
```

目前後端會以小時 checkpoint 檢查整段區間。三個月約等於 2160 個 checkpoint，因此長期研究申請的評估成本會高於快速模板或短時段申請。

### Migration 行為

研究申請比較可能出現 migration。

核准研究申請時，系統可能把同時段已核准的申請一起重新計算 placement：

- 如果資源尚未建立，只會更新 `desired_node` / `assigned_node`。
- 如果資源已存在，且 `actual_node != desired_node`，就可能進入 migration pending。

研究申請允許這種重排，是因為它代表長期保留，管理員審核後可以接受較高治理成本，以換取整體容量最佳化。

## 長短時段混用是否會導致問題

目前不同時間長度共用 `start_at` / `end_at` 不會直接造成資料模型混亂，因為 overlap 判斷本來就是用時間區間。

真正要注意的是三件事：

### 1. UX 不能混用

快速模板不應顯示日期選擇。

研究申請不應顯示小時格。

導師或短時段預約才適合顯示 hourly availability。

### 2. 容量評估粒度不同

快速模板只需要檢查 3 小時。

研究申請要檢查整段日期區間。

短時段預約可以顯示小時級可用性。

### 3. 分配成本不同

快速模板不重排 cohort，成本低、干擾低。

研究申請會做長期 reservation-aware placement，成本較高，也可能導致 migration。

長期研究申請若每次表單變動都即時打完整段評估，會造成不必要的後端壓力。前端應避免過度頻繁查詢，例如：

- 日期或規格變更後 debounce。
- 只在使用者完成日期區間後查。
- 未來可改成手動「重新評估容量」。

## 後端目前相關位置

- `backend/app/services/vm/vm_request_service.py`
  - 快速模板限制。
  - quick template 固定 3 小時。
  - 自動核准。
  - 審核與 `_approve_and_place`。

- `backend/app/services/vm/vm_request_availability_service.py`
  - hourly availability。
  - `validate_request_window`。
  - 整段 window availability。

- `backend/app/services/vm/placement_service.py`
  - `select_reserved_target_node_for_request`。
  - `allow_cohort_rebalance`。
  - reservation rebuild。

- `backend/app/repositories/vm_request.py`
  - overlap 查詢。
  - quick template 使用次數與同時啟用限制。

## 前端目前相關位置

- `frontend/src/components/Applications/ApplicationRequestPage.tsx`
  - 快速模板提示。
  - 研究申請日期區間。
  - 容量評估狀態。

- `frontend/src/services/vmRequests.ts`
  - `windowAvailability` API wrapper。

- `frontend/src/lib/resourcePayloads.ts`
  - 不讓 quick template 傳 client-controlled `start_at` / `end_at`。
  - scheduled/research 傳日期區間。

## 後續建議

### 管理後台

建議把列表分流：

- 研究申請：待審核、容量評估、申請期間、建議節點。
- 快速模板紀錄：使用者、模板、開始時間、到期時間、狀態、是否已自動關機。

### 長期容量評估最佳化

目前長期 window 以小時 checkpoint 檢查，語意清楚但成本會隨時間增加。

未來可優化：

- 改用重疊申請的 start/end boundary 作為 checkpoint，而不是每小時。
- 對長於 30 天的研究申請只做 coarse preview，核准時再做完整檢查。
- 將容量評估結果快取短時間，例如 30 秒。

### Migration 安全邊界

研究申請可以產生 migration，但應確保：

- 快速模板不被 active rebalance 主動搬移。
- 已到期或即將到期資源不參與不必要 migration。
- 管理員審核頁清楚顯示「核准此研究申請可能造成哪些資源 migration」。

