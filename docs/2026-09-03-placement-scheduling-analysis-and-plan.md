# PVE 排程（Placement）現況分析與改善計畫：多機同節點、跨叢集邊界與 GPU 約束

> 本文件記錄 2026-09-03 對 placement、scheduling coordinator、provisioning、課程與快速練習建機路徑的完整程式碼盤點結果，以及後續改善計畫。
>
> 所有結論皆附 `檔案:行號` 佐證，可逐條複驗（見第九節）。
>
> **2026-09-03 更新**：階段 0、階段 1、階段 2 與課堂叢集約束已實作完成，見第十節。分析當時的 HEAD 為 `8e2316e9`；實作期間 repo 合併了 i18n PR（`629e0e57`），部分行號因此位移，函式名與檔案位置不受影響。

| 項目 | 內容 |
| --- | --- |
| 文件版本 | v1.3 |
| 建立日期 | 2026-09-03（Asia/Taipei） |
| 分析基準提交 | `8e2316e9` |
| 實作基準提交 | `629e0e57`（i18n PR 合併後） |
| 文件性質 | 現況分析、問題清單、改善計畫、驗收標準、實作紀錄 |
| 盤點範圍 | `app/services/vm/placement_*`、`app/domain/placement/*`、`app/services/proxmox/provisioning_service.py`、`app/services/vm/batch_provision_service.py`、`app/services/quick_practice.py`、`app/services/teaching/class_capacity_service.py`、`app/infrastructure/proxmox/*` |
| 本次排除 | Course Room、作答流程、AI 推薦、前端 UI |

---

## 一、結論

排程的**判斷能力**（硬約束閘門）完整且正確；**決策能力**（在多個可行節點中選一個）在 LXC 路徑上已名存實亡；**群組能力**（同一組機器的共同約束）完全不存在。

| 能力 | 現況 |
| --- | --- |
| 判斷單台機器能否開在某節點 | ✅ 完整。四道硬約束：範本可見節點、GPU mapping 節點、CPU/RAM/guest 上限、disk |
| GPU 必須在特定節點 | ✅ 已實作，三層把關（placement 過濾、範本名稱推導、建機前二次驗證），有測試覆蓋 |
| 在多節點間做選擇 | ⚠️ 僅 VM 範本申請真正生效；LXC 課程路徑的決策結果仍會被範本節點覆寫（PVE linked clone 限制） |
| 同一組機器必須在同節點 | ✅ 已實作。VMRequest.placement_group_id + allowed_affinity_nodes 硬約束（快速練習整組） |
| 同一組機器必須在同叢集 | ✅ 已實作。快速練習由同節點約束涵蓋；正式課堂由 resolve_class_targets 在預留階段擋下跨叢集 |
| GPU 額度（同卡同時段被搶） | ✅ 已實作。allocatable_gpu_slots 進入容量模型，核准階段即擋下 |

**兩個結構性問題**：

1. **真正的優化器沒有接在決策上。** `_solve_placement_assignments`（貪婪初始解 + local search）的唯一呼叫者是審核畫面的評分預覽（`placement_service.py:1244`）。實際核准走的是另一套貪婪法 `rebuild_reserved_assignments`（`placement_service.py:1053`）。審核員看到的推薦節點與按下核准後的實際落點，是兩套不同演算法算出來的，可以不一致。
2. **有一整套死掉的舊排程演算法仍留在 codebase。** `_build_rule_based_plan` 及其四個 helper（約 190 行）在 `app/` 與 `tests/` 內零呼叫者。

---

## 二、目標

### 2.1 主要目標

| 編號 | 目標 | 驗收方式 |
| --- | --- | --- |
| G1 | **同一組機器絕不跨叢集**（正確性） | 單元測試：兩台同群組機器在任何節點資源分布下，都不會被分配到不同 connection |
| G2 | **同一組機器預設落在同一節點**（連貫環境需求） | 單元測試：三機環境在多節點叢集中整組落於同一節點；同節點放不下時整組失敗並回報原因，而非部分落地 |
| G3 | **GPU 額度在核准階段就擋下**，不再讓使用者在建機時才失敗 | 單元測試：同一 mapping 在重疊時段的第 N+1 張申請於核准時被拒，N = 該節點可用額度 |
| G4 | **審核預覽與實際核准使用同一套演算法**，結果一致 | 單元測試：同一組輸入下，預覽推薦節點 == 核准後 `assigned_node` |
| G5 | **正式課程能分散到多節點**，不再全班堆在範本節點 | 整合測試：範本在 2 節點可見時，全班機器依容量分散；容量檢查回報可行 |

### 2.2 次要目標

- **G6**：移除死碼與假功能，讓 codebase 的排程只有一套可信邏輯。
- **G7**：補上多節點維度的測試，現有 `tests/performance/` 三支壓測完全沒有節點維度。
- **G8**：降低審核畫面的資料庫往返次數（目前每次評估固定 2 次 query，無快取）。

---

## 三、界線（本次不做）

明確劃出範圍，避免計畫膨脹：

| 不做的事 | 原因 |
| --- | --- |
| **VM 線上遷移、自動再平衡（DRS）** | 已於 `ret01_remove_vm_migration_feature` 刻意移除，`tests/test_vm_movement_retired.py` 保護此決定。排程只在建機前決定落點，不搬既有機器 |
| **打通跨叢集 L2 網路** | 屬網路架構題。本次立場是「用約束避開跨叢集」，不是「讓跨叢集能通」 |
| **把 `SubnetConfig` 從全域單例改成 per-connection** | 影響面涵蓋 IP 配發、gateway、reverse proxy、WireGuard，應獨立立案 |
| **改寫評分公式與權重模型** | 現行 `placement_sort_key` 的公式合理，缺的是約束維度而非評分精度 |
| **解除 linked clone 必須同節點同 storage 的限制** | PVE 硬限制，非本系統可改 |
| **實作 spread / binpack 策略切換** | 見 P-7，建議移除選項而非補實作 |
| **改動 Course Room、作答流程、AI 推薦** | 與排程無關 |

---

## 四、目前排程邏輯現況

### 4.1 三條建機路徑

| 路徑 | 進入點 | 選節點方式 |
| --- | --- | --- |
| 研究申請 `research` | `vm_request_service.py:192-244` | 核准時對重疊時窗全部 approved 申請跑 `rebuild_reserved_assignments`（逐張貪婪） |
| 課程實驗機、快速練習 `course`、`quick_template` | `vm_request_service.py:159-190` | 單張申請獨立選點，選完即釘死，不參與 cohort（`placement_service.py:94-99`） |
| 正式課程批次 | `batch_provision_service.py:430-545` | **完全不進 placement**。範本機跟範本節點；自訂機走 `pick_target_node`（各連線 default_node → nodes[0]，`operations.py:187-211`） |

### 4.2 單張申請的決策鏈

```text
_to_placement_request()          VMRequest → PlacementRequest
  ↓
_load_cluster_state()            抓 PVE 節點與資源（TTL 快取）
_build_node_capacities()         算 allocatable（含 overcommit 比例）
  ↓
逐小時 checkpoint 掃時窗          _hour_window_iter → 每小時扣掉重疊申請占用
  ↓
node_can_host_request()          ★ 硬約束閘門（placement_support.py:212-239）
    ① allowed_nodes      = 範本可見節點（allowed_template_nodes_for_request）
    ② allowed_gpu_nodes  = GPU mapping 所在節點（allowed_gpu_nodes_for_request）
    ③ status / CPU / RAM / guest_soft_limit
    ④ disk（非 shared storage 時）
  ↓
feasible_nodes = 每小時交集       任一小時不可行 → 整個時窗不可行
  ↓
build_plan() → placement_sort_key()   對可行節點打分，取最小
```

### 4.3 評分公式（`placement_support.py:665-758`）

```text
total_score = dominant_share            # CPU/RAM/Disk 加權後的最大占比
            + peak_penalty              # 尖峰 margin 後仍超警戒線
            + cpu_contention × weight
            + memory_overflow           # 超賣硬懲罰
            + loadavg_penalty × weight  # 節點實測 loadavg / core
            + reassignment_cost         # 需換節點的成本
            + storage_contention × weight

排序鍵 = (total_score, dominant_share, average_share, node_priority, 已放台數, ...)
```

節點 priority 排在第 4 順位，僅在前三項打平時生效。

### 4.4 GPU 節點約束（已完整實作）

| 層 | 位置 | 作用 |
| --- | --- | --- |
| Placement 過濾 | `placement_support.py:212-239`、`:248-254` | `gpu_required > 0` 時以 mapping 實際所在節點為白名單。來源是 PVE `cluster/mapping/pci`（`gpu_service.py:470`），非手維護設定 |
| 範本名稱推導 | `placement_support.py:265-269` | 範本名以 `-GPU` 結尾時，即使未指定 mapping 也縮限到有 GPU 的節點 |
| 建機前二次驗證 | `provisioning_service.py:191-311` | pinned node 或自動選出的節點不相容則直接 raise |
| 範本系統 2.0 克隆 | `clone_service.py:98-110` | 擋「GPU 不在範本所在節點上」 |

測試覆蓋：`tests/services/test_template_node_constraints.py`、`tests/test_backend_workflows.py::test_placement_request_with_gpu_mapping_uses_mapping_nodes`。

---

## 五、問題清單

嚴重度定義：**S1** = 正確性問題，會產生壞掉的環境或錯誤拒絕；**S2** = 功能缺失或不一致，影響可用性與可維運性；**S3** = 冗餘、誤導或效能，不影響正確性。

### P-1〔S1〕同一組機器可被分到不同叢集 — ✅ 已於 T2.2 與課堂叢集約束修正

- **現象**：`list_nodes()` 明確「Return all nodes across all connections」（`operations.py:124-125`），`_load_cluster_state()`（`advisor.py:50-91`）直接以此建候選池。placement 從第一步就把不同叢集的節點放在同一個池子裡比分數。
- **唯一防線是 per-request 而非 per-group**：只有 VM 範本那條用 `get_nodes_for_connection(get_connection_id_for_node(template_node))` 限制在範本所屬連線（`placement_support.py:322-330`、`client.py:122-142`）。這只保證單台不跨叢集，不保證 A 機與 B 機同叢集。
- **LXC 更寬鬆**：`get_lxc_template_node_map()` docstring 自述「跨連線彙總」（`operations.py:596-601`）。同名 volid 若兩叢集都有，白名單會同時包含兩邊節點。
- **後果**：網路設定分層矛盾。`SubnetConfig` 是全域單例（cidr、gateway、bridge_name，`subnet_config.py:11-24`），但 `gateway_ip`、`local_subnet` 是每連線各自設定（`proxmox_config.py:84-85`）。跨叢集後 L2 不通、同 bridge 名稱指向不同實體網路、`allow_one_way` 兩邊各自下規則都成功但封包不通（`class_network_service.py:58-98`），拓樸 edge 形同虛設。

### P-2〔S1〕沒有任何群組 affinity 概念 — ✅ 已於 T2.1／T2.3 修正

- 全 codebase grep `affinity`、`group_key`、`same_node`、`placement_group` 零結果。`cohort` 一詞指的是「時間窗內的申請集合」，不是機器群組。
- `VMRequest` 無群組鍵（`models/vm_request.py:84-175`），只有 `batch_job_id`。
- 快速練習多台機器是**一台一張申請單**逐台送（`vm_request_service.py:527-560`），各自 `_approve_and_place` 各自選節點。先建的搶好節點，後建的被推去別台，無任何檢查。
- **群組資訊其實已存在但排程看不到**：`QuickPracticeSessionMachine.session_id` 已把同環境機器綁在一起（`quick_practice.py:169-180`），拓樸 edge 也知道誰要連誰（`quick_practice.py:182-253`）。這條資訊完全沒有傳進 placement。

### P-3〔S1〕GPU 額度未進排程模型 — ✅ 已於 T2.4 修正

- `reserve_request_on_capacities`（`placement_support.py:395-412`）只扣 CPU、RAM、disk，**從不扣 `gpu_count`**。
- 指定 mapping 時，`node_can_host_request` 只判斷「節點在不在白名單」，連 `gpu_count` 都不看（`placement_support.py:226-230`）。
- **後果**：同一張卡在同一時段可被 N 張申請同時排入並全部核准，直到建機時才由 `_build_gpu_hostpci` 發現 `available_count <= 0` 而失敗（`provisioning_service.py:126-176`）。「核准通過、建機才失敗」是最差的失敗時機。
- `/gpu/options` 有做時窗扣減（`api/routes/gpu.py:74-83`），但那只是表單顯示，排程不使用。

### P-4〔S2〕優化器沒接在決策上，預覽與核准是兩套演算法 — ✅ 已於 T1.1 修正

- `_solve_placement_assignments`（`placement_service.py:944-990`）等於貪婪初始解（`:580`）加 local search 單移與對調（`:739-853`）加 relief reassignment（`:856-943`）。
- **唯一呼叫者是 `get_preview_node_scores`（`placement_service.py:1244`）**，即審核畫面的評分條。
- 實際核准走 `rebuild_reserved_assignments`（`placement_service.py:1053-1096`）的逐張貪婪法。
- `get_review_context` 同一畫面同時呼叫兩者：`vm_request_service.py:665`（貪婪，產生 `projected_nodes`）與 `:766`（local search，產生 `node_score_breakdowns`）。兩者可給出不同答案。

### P-5〔S2〕LXC 課程實驗機的排程決策被覆寫丟棄

- `_select_request_placement` 完整跑完打分、寫入 `assigned_node` 與 `desired_node`，隨後 `provisioning_service.py:764` 直接以 `plan["target_node"] = template_row.node` 覆寫。
- 原因是 linked clone 必須同節點同 storage（PVE 限制，見第三節界線）。
- **後果**：這條路徑的排程實質退化為純能力檢查，只驗「有沒有能力開」，開在哪由範本節點決定。

### P-6〔S2〕正式課程完全繞過 placement，容量檢查不會分散 — ⚠️ 部分處理（已加叢集約束，分散未做）

- `batch_provision_service.py:430-545` 不呼叫任何 placement 函式。
- `class_capacity_service._evaluate_cluster_capacity`（`class_capacity_service.py:164-200`）以 `defaultdict` 依 `target_node` 累加 `× student_count`，全班需求全部堆到範本節點，只會回報「該節點不夠」，不會分配到其他節點。其他節點閒置也用不到。
- 範本節點成為單點：範本節點離線則整堂課的 LXC 都建不出來。

### P-7〔S3〕排程策略切換是假的 — ✅ 已於 T0.2 修正

- `normalize_strategy` 第一行即 `del strategy`，永遠回傳 `DEFAULT_PLACEMENT_STRATEGY`（`domain/placement/policy.py:98-100`）。
- 設定頁的策略選單、`placement_strategy` 欄位、一路傳遞的 `strategy` 參數（`_initial_active_assignment_map`、`_try_relief_reassignment` 都收了但未使用）全是裝飾。管理員以為換了策略，實際沒有。

### P-8〔S3〕死碼：整套舊排程演算法 — ✅ 已於 T0.1 移除

- `_build_rule_based_plan`（`advisor.py:157-263`）、`_choose_node`（`:404-427`）、`_fit_count`（`:428-441`）、`_weighted_headroom_score`（`:442-466`）、`_can_fit`（`:467-483`），約 190 行。
- 已於 `app/` 與 `tests/` 全域 grep 確認**零呼叫者**。
- 它是 `placement_support.build_plan` 的前身，結構相同但**沒有 GPU 白名單、沒有範本節點白名單、沒有 storage 選擇**。留著只會讓人誤以為系統有兩套規則。

### P-9〔S3〕跨節點 clone 失敗時的 fallback 繞過 GPU 檢查 — ✅ 已於 T0.3 修正

- `provisioning_service.py:975`：跨節點 full clone 失敗後 `actual_node = template_node`。
- 隨後 `:1015` 直接把 `hostpci0` 套到這個 fallback 節點，未重新驗證該節點是否有此 mapping。
- 前面 `_select_request_placement` 做過的相容性檢查在此被繞過。

### P-10〔S3〕審核預覽的資料庫往返次數過高 — ✅ 已隨 T1.1 消除

- `_evaluate_active_assignment_map`（`placement_service.py:414-441`）**每次呼叫都重跑兩個 DB query**：`get_all_storages` 與 `get_overcommit_ratios`，無任何快取。
- 預覽的呼叫次數約為 `候選節點數 N × search_depth D × (R×N 單移 + R²/2 對調) × 2 queries`。
- 以 N=3、R=20、D=3 估算約 **4,700 次 DB round-trip，僅為繪製審核畫面的分數條**。

### P-11〔S2〕課程機釘死節點導致研究申請誤判不可行

- `course` 與 `quick_template` 一旦選定節點即鎖住且不參與 cohort optimization（`placement_service.py:94-99`）。
- 研究申請重新求解時無法移動它們讓位。整體其實有可行解，排程仍回報「此時段沒有可用節點」。

### P-12〔S3〕沒有指定節點的手段

- `VMRequestCreate`（`schemas/vm_request.py:47-74`）無 `desired_node` 欄位；該欄位僅存在於 model 與讀取端，由系統寫入。
- 教師與管理員無法要求「這門課固定用 pve2」。節點 priority 又只是第 4 順位的 tie-breaker，實務上幾乎不生效。

### P-13〔S2〕缺多節點維度的測試

- `tests/performance/` 三支壓測（`test_concurrent_vm_requests`、`test_course_deploy_storm`、`test_provision_fanout`）完全沒有節點維度。
- 無任何測試驗證「同群組不被打散」「全班不會全塞範本節點」「跨叢集不混放」。

---

## 六、要做的事

### 階段 0：清場（低風險，可獨立進行）

| 編號 | 工作 | 對應問題 | 驗收標準 |
| --- | --- | --- | --- |
| T0.1 | 刪除 `_build_rule_based_plan` 及 `_choose_node`、`_fit_count`、`_weighted_headroom_score`、`_can_fit` | P-8 | `advisor.py` 減少約 190 行；全測試通過；grep 確認無殘留引用 |
| T0.2 | 移除假的策略切換：拿掉設定頁選單、`placement_strategy` 的傳遞鏈與 `normalize_strategy` | P-7 | 設定頁不再出現無效選項；`strategy` 參數不再穿過 placement 函式簽章 |
| T0.3 | 修 clone fallback 的 GPU 破口：fallback 到範本節點後重跑 `compatible_nodes` 檢查，不相容則明確失敗而非 fallback | P-9 | 新增單元測試：GPU 申請的跨節點 clone 失敗時，不會把 `hostpci0` 套到無該 mapping 的節點 |

### 階段 1：決策一致性（中風險）

| 編號 | 工作 | 對應問題 | 驗收標準 |
| --- | --- | --- | --- |
| T1.1 | **決定 local search 去留，建議刪除**：移除 `_run_local_placement_search`、`_try_relief_reassignment`、`_solve_placement_assignments`（約 250 行），`get_preview_node_scores` 改用與核准相同的 `rebuild_reserved_assignments` | P-4、P-10 | **G4**：預覽推薦節點 == 核准後 `assigned_node`；審核畫面 DB query 數降至個位數 |
| T1.2 | 連帶退休 `placement_search_depth`、`placement_search_max_reassignments` 兩個設定欄位（已 grep 確認僅 local search 使用） | P-4 | 設定頁不再顯示；migration 移除欄位 |

> **T1.1 的取捨說明**：另一個選項是「核准也改用 local search」，但需先修 P-10 的 N+1 query。評估後採取刪除，理由是 research 申請量不大、貪婪加逐小時 checkpoint 的結果實務上已足夠；真正缺的是**約束維度**（群組、GPU 額度）而非搜尋深度。加上 affinity 後貪婪一樣能滿足硬約束，local search 也不會因此變聰明。

### 階段 2：群組約束（核心）

| 編號 | 工作 | 對應問題 | 驗收標準 |
| --- | --- | --- | --- |
| T2.1 | `VMRequest` 新增 `placement_group_id: uuid \| None`（含 migration 與 index）。值取 `QuickPracticeSession.id`、`TeachingClass.id` 或 course deployment id | P-2 | 三條建機路徑皆正確寫入；既有資料 migration 後為 `NULL` 不受影響 |
| T2.2 | `node_can_host_request` 新增 `allowed_connection: int \| None` 參數，同群組已有落點時硬約束到同一 connection | P-1 | **G1**：兩台同群組機器在任何資源分布下都不會跨 connection |
| T2.3 | `node_can_host_request` 新增 `allowed_affinity_nodes: set[str] \| None` 參數，同群組已有落點時硬約束到同節點 | P-2 | **G2**：三機環境整組落於同一節點 |
| T2.4 | GPU 額度進模型：`NodeCapacity` 新增 `allocatable_gpu_slots`，於 `reserve_`、`apply_reserved_`、`release_` 三處一併增減；指定 mapping 時亦檢查剩餘量 | P-3 | **G3**：重疊時段第 N+1 張 GPU 申請於核准階段被拒 |

> T2.2 與 T2.3 都接在既有介面上。`node_can_host_request` 已經是「多組白名單取交集」的形狀，加參數即可，不需重構。

### 階段 3：整組求解與課程分散

| 編號 | 工作 | 對應問題 | 驗收標準 |
| --- | --- | --- | --- |
| T3.1 | 快速練習與課程實驗機改為**整組一次求解**，取代逐台送單。`build_plan` 已支援 `instance_count` 多台逐一放置（`placement_support.py:503-560`），延伸為「多規格整組加同節點約束」 | P-2 | 整組成功或整組失敗，不出現部分落地；失敗時回報明確原因 |
| T3.2 | 正式課程接上 placement：`class_capacity_service` 改為真正的分配（依範本可見節點與 shared storage 決定能否分散），並把決定的節點傳進 `batch_provision_service` | P-6 | **G5**：範本在 2 節點可見時全班依容量分散；容量檢查回報可行 |
| T3.3 | 檢討 course 與 quick 機器的節點釘死策略，讓研究申請重新求解時能正確評估可行性 | P-11 | 存在可行解時不再誤報「此時段沒有可用節點」 |

### 階段 4：測試與可觀測性

| 編號 | 工作 | 對應問題 | 驗收標準 |
| --- | --- | --- | --- |
| T4.1 | 新增多節點單元測試：同群組不被打散、同群組不跨叢集、GPU 額度用盡於核准階段擋下、全班不全塞範本節點 | P-13、G1、G2、G3、G5 | 四類情境皆有測試且通過 |
| T4.2 | `tests/performance/` 三支壓測加入節點維度參數 | P-13、G7 | 壓測可在 1、2、4 節點配置下執行並輸出比較 |
| T4.3 | （可選）`VMRequestCreate` 開放管理員與教師指定 `desired_node` | P-12 | 指定節點時仍需通過全部硬約束，不可繞過 |

---

## 七、執行順序與依賴

```text
階段 0（清場）        T0.1  T0.2  T0.3        ← 三項互相獨立，可並行
                        │
階段 1（一致性）      T1.1 → T1.2              ← 不依賴階段 0，但清場後改動面更小
                        │
階段 2（群組約束）    T2.1 ──┬── T2.2（同叢集，S1）
                            ├── T2.3（同節點，S2）
                            └── T2.4（GPU 額度，S1，可與 T2.1 並行）
                        │
階段 3（整組求解）    T3.1 → T3.2 → T3.3       ← T3.1 依賴 T2.1 與 T2.3
                        │
階段 4（測試）        T4.1  T4.2  T4.3         ← 隨各階段同步補
```

**關鍵依賴**：`T2.1`（群組鍵）是 `T2.2`、`T2.3`、`T3.1` 的共同前提，也是唯一需要動 schema 的工作項。

**優先序建議**：若資源有限只能做一件事，做 **T2.2（同叢集硬約束）**。理由：

- 它是**正確性**問題（跨叢集必壞），而 T2.3 是**品質**問題（跨節點同叢集靠同 bridge 加 PVE firewall 仍可通，只是無保證、效能與故障範圍不可控）。
- 它範圍小、可獨立驗證、不影響既有單機流程。

---

## 八、風險與注意事項

| 風險 | 說明 | 緩解 |
| --- | --- | --- |
| T1.1 刪除 local search 造成排程品質下降 | 目前 local search 未參與決策，刪除**不改變任何實際落點** | 先以測試固定現行核准結果，再刪除，確認結果不變 |
| T2.3 同節點硬約束造成整組失敗率上升 | 三機環境需單一節點容納全部資源，比分散更難滿足 | 可設計為「同叢集硬約束加同節點軟約束（高權重）」；但**有 topology edge 的連貫環境必須維持同節點硬約束** |
| T2.4 GPU 額度與 PVE 實際狀態不同步 | `get_gpu_node_counts` 有 TTL 快取；SR-IOV vGPU 額度受 profile `max_instances` 影響 | 保留建機前的 `_build_gpu_hostpci` 二次驗證作為最後防線，不因排程層已檢查就移除 |
| T3.2 LXC 無法真正分散 | LXC linked clone 必須同節點同 storage | 需範本在多節點有副本，或改走 shared storage；VM 已有跨節點 full clone 路徑可用 |
| 既有資料相容性 | `placement_group_id` 對歷史申請為 `NULL` | 群組約束僅在 `placement_group_id` 非空時啟用，舊資料行為不變 |

---

## 九、複驗指引

本文件所有結論可用以下指令快速複驗（於 repo 根目錄執行）。括號內為 2026-09-03 於 `8e2316e9` 的實測結果：

```bash
# P-2：確認無任何 affinity 概念（預期 0 筆）
grep -rniE "affinity|group_key|anti_affinity|same_node|placement_group" backend/app --include=*.py

# P-4：確認 local search 的唯一呼叫者
# （預期：定義處，加上 placement_service.py:1244 這唯一一個呼叫點）
grep -rn "_solve_placement_assignments" backend/app --include=*.py

# P-8：確認死碼零呼叫者
# （預期 5 筆，且全部位於 advisor.py 內部互相呼叫，app/ 與 tests/ 其他位置皆無）
grep -rnE "_build_rule_based_plan|_choose_node|_fit_count" backend/app backend/tests --include=*.py

# P-1：確認候選池跨叢集
sed -n '124,141p' backend/app/infrastructure/proxmox/operations.py

# P-3：確認 gpu_count 從不被扣減
grep -rn "gpu_count" backend/app --include=*.py

# P-7：確認策略切換為空實作
sed -n '98,100p' backend/app/domain/placement/policy.py
```

---

## 十、實作紀錄

### 階段 0 — 已完成（2026-09-03，基準 `629e0e57`）

| 編號 | 狀態 | 實際改動 |
| --- | --- | --- |
| T0.1 | ✅ 完成 | `advisor.py` 移除 `_build_rule_based_plan`、`_choose_node`、`_fit_count`、`_weighted_headroom_score`、`_can_fit` 共 **189 行**（純刪除，0 新增），連同失效的 `floor` 與 `PlacementPlan` import。隨之失效的 `placement_weight_cpu/memory/disk/guest` 由 `config.py`、`config/placement.json`、`config/placement.example.json` 一併移除 |
| T0.2 | ✅ 完成 | 前端 `SettingsPage.jsx` 移除放置策略選擇卡與 `UPDATE_KEYS` 中的 `placement_strategy`；連同 `SettingsPage.module.scss` 的 5 個孤兒 class 與三語系 3 組孤兒 i18n key。後端刪除 `normalize_strategy`（`del strategy` 的空實作）與轉發用的 `_normalize_strategy`，`get_placement_strategy` 改為直接回傳常數並移除無意義的 DB 讀取 |
| T0.3 | ✅ 完成 | `provisioning_service.py` 新增 `_template_node_accepts_gpu`，跨節點 clone 失敗退回範本節點前重驗 GPU mapping；不相容或無法確認時改為明確失敗。錯誤訊息循新合併的 i18n 慣例，新增 `provisioning.gpu_fallback_node_incompatible` 三語系 key |

**測試**：新增 `backend/tests/services/test_gpu_clone_fallback.py`（5 個案例）。關鍵斷言 `clone_vm` 只被呼叫一次已用「暫時關閉防護」的方式反向驗證過 —— 舊行為下會呼叫兩次，確認此測試非空測。

**全套件結果**：`963 passed, 3 skipped, 57 errors`。57 個 error 全為環境性（43 個 DB fixture 守門拒絕連非測試資料庫、14 個 redis 連線失敗），與本次改動無關，改動前後一致。

**未做（刻意）**：`proxmox_config.placement_strategy` 資料表欄位與 `VMRequest.placement_strategy_used` 均保留，不做 migration。前者已無寫入來源，後者記錄的是落點當時採用的策略名稱，仍是誠實資訊；日後真的支援多策略時從 `get_placement_strategy` 擴充即可。

**已知限制**：前端無法執行 `vite build` 驗證（rolldown 原生 binding 缺失，屬既有環境問題，與本次改動無關）。JSX 改動為單一自包含區塊的純刪除，已逐行檢視 diff 確認標籤平衡。

### 階段 1 — 已完成（2026-09-03）

| 編號 | 狀態 | 實際改動 |
| --- | --- | --- |
| T1.1 | ✅ 完成 | 移除 local search 整套機制（`_evaluate_active_assignment_map`、`_initial_active_assignment_map`、`_run_local_placement_search`、`_try_relief_reassignment`、`_solve_placement_assignments`）共 **639 行**。`get_preview_node_scores` 新增 `selected_node` 參數，由審核畫面直接傳入 `rebuild_reserved_assignments` 算出的投影落點 —— **G4 因此是結構性保證**，不是靠兩套演算法碰巧一致。候選節點評分改為單節點投影，順帶把原本硬編為 0 的 memory_share、disk_share、peak_penalty、loadavg_penalty 填上真實值 |
| T1.2 | ✅ 完成 | `PlacementTuning` 移除只服務 local search 的 `search_depth`、`search_max_reassignments`。保留 DB 欄位，不做 migration |

另移除隨之孤立的 `AssignmentEvaluation`、`compute_node_score_breakdown`、`build_placement_baseline_nodes`、`build_preview_selection_reasons`（後者在 placement_service 與 placement_support 各有一份，均無呼叫者）。

**G8 效能**：審核畫面原本每次評估固定 2 次 DB query，總量約「節點數 × depth × (申請×節點 + 申請²/2) × 2」；現為每個候選節點一次投影。

### 階段 2 — 已完成（2026-09-03）

| 編號 | 狀態 | 實際改動 |
| --- | --- | --- |
| T2.1 | ✅ 完成 | `VMRequest.placement_group_id` + 複合索引（migration `pgrp01`）。NULL = 不屬於任何群組，行為與過去完全相同 |
| T2.2 | ✅ 完成 | 由 T2.3 的同節點硬約束涵蓋（同節點必然同叢集）。正式課堂另有獨立機制，見下 |
| T2.3 | ✅ 完成 | `node_can_host_request` 新增 `allowed_affinity_nodes` 維度，與既有的範本節點、GPU 節點白名單同層取交集。群組第一台自由選點成為錨點（取最早建立者，確保穩定），之後的機器一律跟隨；錨點放不下時整組失敗。快速練習以 `QuickPracticeSession.id` 作為群組鍵 |
| T2.4 | ✅ 完成 | `NodeCapacity.allocatable_gpu_slots` 於 reserve／release／apply_reserved 與 build_plan 的多台迴圈一併增減；`node_can_host_request` 在白名單之外再檢查剩餘額度 |

**T2.4 已知限制**：`gpu_count` 是節點上所有 mapping 的總槽數，因此額度計算也是總量，同節點不同卡之間會互相排擠。屬保守誤差（寧可拒絕也不超賣）。若要精確到 per-mapping，需讓 `NodeCapacity` 帶 mapping 維度。

### 課堂叢集約束 — 已完成（2026-09-03）

原 T3.2 的目標是「正式課程分散到多節點」。實作過程中確認了更優先且更關鍵的需求：**同一堂課的機器必須在同一個叢集**。

問題：自訂 LXC 走 `provisioning_service._get_lxc_target_node()`（各連線 default_node → nodes[0]），會在所有連線之間自由挑選，可以落到與範本機器不同的叢集；而且它從不檢查該節點看不看得到 vztmpl，要等到建機才失敗。

- `eligible_nodes_for_machine`：每台課程機器實際能建在哪些節點（LXC 範本釘範本節點、VM 限制在範本所屬連線、自訂 LXC 限制在看得到該 vztmpl 的節點）。
- `resolve_class_targets`：取各機器可落腳連線的交集決定班級叢集，再於該叢集內挑節點；無交集時在容量預留階段就擋下並列出各機器的可用節點。
- 節點選擇沿用各連線 default_node 的既有偏好，僅在它不合格時才改挑其他節點。
- 建機端 `_process_task` 以同一個函式解出節點傳給 `create_lxc`，確保建機落點與預留時算的一致。

容量計算仍是每台機器對應單一節點（不分散），與建機行為一致。

### 重構後的清場

移除 local search 與 `build_placement_baseline_nodes` 之後留下的孤兒一併清除：
`_is_quick_template_request`、`_fixed_node_for_quick_template`（原本只服務 local search 的初始解，核准路徑從未使用）、`_release_request_from_capacities` 與 `placement_support` 的本體。

同時把「已定案的群組會被凍結」這個原本隱含的行為寫明並測試：研究申請核准時 `rebuild_reserved_assignments` 會重新求解整個時窗，其中包含尚未建機的群組成員；此時每個成員都已有 `assigned_node`，而 `group_anchor_node` 不排除呼叫者自己，因此每台都以自己為錨點留在原地 —— 整組被凍結成一個單位，不會在重解過程中被拆散。要讓某台真的重新自由選點時，才傳入 `exclude_request_id`。

### 未完成：G5 正式課程分散到多節點

**未實作，且刻意不做半套。** 原因：

1. 容量檢查一旦開始分散，建機端必須同步遵守，否則會核准出建不起來的班級 —— 比現況更糟。
2. 建機端要真正支援分散，需要 `ClassCapacityReservation` 存「每台機器 → 各節點台數」的細粒度計畫（現行 JSON 是全班加總，還原不出來）、`create_vm`／`clone_service` 支援跨節點 full clone 與失敗退回。
3. 其中最有價值的範本式課程機器正好需要跨節點 clone，而該路徑無法在沒有多節點 PVE 的環境中驗證。

實作到一半的分配邏輯已完整撤回，未在 codebase 留下未接線的程式碼。若要接續，`eligible_nodes_for_machine` 已是現成的可建節點來源。

### 測試（G7）

| 檔案 | 案例數 | 覆蓋 |
| --- | --- | --- |
| `tests/services/test_gpu_clone_fallback.py` | 5 | T0.3 GPU 退回把關 |
| `tests/services/test_placement_group_affinity.py` | 26 | G1、G2、G3、群組凍結 |
| `tests/services/test_class_cluster_constraint.py` | 12 | 課堂叢集約束 |

三個檔案都含**對照組**，確認約束確實載重而非空測：同一組節點在有／無群組鍵下選出不同節點；GPU 在 0 槽／1 槽下拒絕／接受；預設節點在別的叢集時改選同叢集節點、合格時維持不變。

**全套件**：`1001 passed, 3 skipped, 57 errors`；`ruff check` all checks passed。57 個 error 全為環境性（43 個 DB fixture 守門拒絕連非測試資料庫、14 個 redis 連線失敗），改動前後一致。

**T4.2（壓測加節點維度）未做** —— 現有壓測需要可用的資料庫與 PVE，本環境無法執行。

### 後續

1. `pgrp01` migration 需在既有環境執行；`vm_requests` 資料量大時先確認 `add_column` + `create_index` 的耗時。
2. 課堂叢集約束會讓「機器分屬不同叢集」的既有班級在下次容量預留時被擋下 —— 上線前先掃一次現有班級，確認沒有跨叢集組合。
3. GPU 額度改為總量計算，同節點多張不同卡的環境會比過去保守。若造成誤拒，再推進 per-mapping 維度。
4. G5（正式課程分散）若要接續，先決定 `ClassCapacityReservation` 的細粒度計畫格式，再處理 `clone_service` 的跨節點 full clone；該路徑需在多節點 PVE 上實測。
