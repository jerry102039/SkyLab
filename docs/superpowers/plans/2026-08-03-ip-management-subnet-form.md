# IP 管理子網設定表單 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 IP 管理頁補回子網設定的建立／編輯／刪除入口，並把 IP 管理從側欄「網路」群組移到「系統管理」群組。

**Architecture:** 頁面維持容器角色（載入資料、管理 editing/saving state、呼叫 service），新增一個純受控的 `SubnetConfigForm` 元件負責表單本身、不碰 API。設定入口為頁首按鈕，按下後在統計列與工具列之間展開表單卡片。後端完全不動。

**Tech Stack:** React 19 (JSX)、react-router-dom 7、SCSS Modules、Vitest、sonner（透過 `useToast`）

## Global Constraints

- 介面文字一律繁體中文。
- 樣式遵循 `docs/2026-09-05-frontend-style-guide.md`（原 `frontend/src/assets/styles/STYLE_GUIDE.md`）：**不得新增任何 SCSS 變數或 CSS 自訂屬性**，顏色用既有 `--color-*`；按鈕 hover 一律加 `:not(:disabled)`，disabled 用 `opacity: 0.4; cursor: not-allowed`。
- Icon 一律用 `MIcon`（material-icons filled），禁止 SVG inline / emoji。
- CSS Modules 類別名稱用 camelCase，變體用底線（`.badge_vm`）。
- API 一律經 `services/*.js`，頁面不直接 `fetch`。
- 後端無變更；URL 維持 `/ip-management` 不改。
- 本計畫的 commit 步驟在執行時會先與使用者確認再執行。

---

### Task 1: 把 IP 管理移到「系統管理」群組

**Files:**
- Move: `frontend/src/pages/network/ip-management/IpManagementPage.jsx` → `frontend/src/pages/system/ip-management/IpManagementPage.jsx`
- Move: `frontend/src/pages/network/ip-management/IpManagementPage.module.scss` → `frontend/src/pages/system/ip-management/IpManagementPage.module.scss`
- Modify: `frontend/src/components/Sidebar/Sidebar.jsx:41-52`（`network` 群組）與 `:75-84`（`system` 群組）
- Modify: `frontend/src/App.jsx:55`（lazy import）與 `:174-179`（Route 位置）

**Interfaces:**
- Consumes: 無
- Produces: `frontend/src/pages/system/ip-management/` 這個目錄路徑，Task 3 與 Task 4 會在此新增／修改檔案。

**背景：** 兩個目錄相對根目錄同深度，`.module.scss` 開頭的 `@use "../../../assets/styles/variables" as *;` 與 `mixins` 引入路徑**不需修改**。`IpManagementPage.jsx` 內的 `../../../components/MIcon`、`../../../services/ipManagement`、`../../../hooks/*` 同理不需修改。`App.jsx:55` 是全專案唯一 import 這個頁面的地方（已用 grep 確認）。

- [ ] **Step 1: 建立新目錄並用 git mv 搬移兩個檔案**

```bash
cd frontend/src/pages && mkdir -p system/ip-management && git mv network/ip-management/IpManagementPage.jsx system/ip-management/IpManagementPage.jsx && git mv network/ip-management/IpManagementPage.module.scss system/ip-management/IpManagementPage.module.scss && rmdir network/ip-management
```

- [ ] **Step 2: 更新 App.jsx 的 lazy import**

`frontend/src/App.jsx:55`，把：

```jsx
const IpManagementPage = lazy(() => import("./pages/network/ip-management/IpManagementPage"));
```

改成：

```jsx
const IpManagementPage = lazy(() => import("./pages/system/ip-management/IpManagementPage"));
```

同時把這一行從「網路」那一組 lazy import 移到 `SettingsPage` / `QuotasPage` 等系統管理頁的 import 附近，讓分組與側欄一致。

- [ ] **Step 3: 更新 App.jsx 的 Route 位置**

從「網路」區塊移除這一行：

```jsx
          <Route path="/ip-management"  element={<IpManagementPage />} />
```

加到「系統管理」區塊，放在 `/quotas` 之後、`/monitoring` 之前：

```jsx
          {/* 系統管理 */}
          <Route path="/admin"     element={<AdminPage />} />
          <Route path="/settings"  element={<SettingsPage />} />
          <Route path="/quotas"    element={<QuotasPage />} />
          <Route path="/ip-management" element={<IpManagementPage />} />
          <Route path="/monitoring" element={<MonitoringPage />} />
```

- [ ] **Step 4: 更新 Sidebar 群組**

`frontend/src/components/Sidebar/Sidebar.jsx`，`network` 群組移除 `ip-management` 那一行，變成：

```jsx
  {
    key: "network",
    label: "網路",
    icon: "router",
    items: [
      { key: "firewall",      label: "防火牆",     icon: "security" },
      { key: "reverse-proxy", label: "反向代理",   icon: "swap_horiz" },
      { key: "domain",        label: "網域管理",   icon: "domain" },
      { key: "gateway",       label: "閘道 VM",    icon: "dns" },
    ],
  },
```

`system` 群組加入，排在「配額管理」之後、「系統設定」之前：

```jsx
  {
    key: "system",
    label: "系統管理",
    icon: "tune",
    items: [
      { key: "admin",         label: "使用者管理", icon: "admin_panel_settings" },
      { key: "quotas",        label: "配額管理",   icon: "data_usage" },
      { key: "ip-management", label: "IP 管理",    icon: "lan" },
      { key: "settings",      label: "系統設定",   icon: "settings" },
    ],
  },
```

- [ ] **Step 5: 確認沒有殘留的舊路徑引用**

```bash
cd frontend && grep -rn "network/ip-management" src/ || echo "OK: no stale references"
```

Expected: `OK: no stale references`

- [ ] **Step 6: 建置驗證**

```bash
cd frontend && bun run build
```

Expected: 建置成功，無 "Failed to resolve import" 錯誤。

- [ ] **Step 7: Commit**

```bash
git add frontend/src/App.jsx frontend/src/components/Sidebar/Sidebar.jsx frontend/src/pages && git commit -m "refactor(frontend): IP 管理移至系統管理群組"
```

---

### Task 2: 補上 ipManagement service 的 vitest

**Files:**
- Create: `frontend/src/services/ipManagement.test.js`
- Read-only 參考: `frontend/src/services/ipManagement.js`、`frontend/src/services/proxmoxConfig.test.js`

**Interfaces:**
- Consumes: `IpManagementService`（既有，無需修改）— `getSubnet()`、`upsertSubnet(body)`、`deleteSubnet()`、`listAllocations(params)`、`getStatus()`
- Produces: 無（純測試）

**背景：** `services/ipManagement.js` 的函式早就存在但沒有任何測試，其餘 service 幾乎都有。Task 4 會開始真正呼叫 `upsertSubnet` / `deleteSubnet`，先把 URL 與 method 用測試釘住。

- [ ] **Step 1: 寫測試**

建立 `frontend/src/services/ipManagement.test.js`，完整內容：

```js
/**
 * ipManagement.test.js
 * 驗證 IpManagementService 各函式的 URL 與 method 組裝。
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import { IpManagementService } from "./ipManagement";

/** 假 localStorage */
function fakeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

/** 模擬 fetch Response */
const jsonRes = (status, body = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

let fetchMock;

beforeEach(() => {
  vi.stubGlobal("localStorage", fakeStorage());
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

describe("IpManagementService", () => {
  test("getSubnet 走 GET /ip-management/subnet", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(200, null));

    await IpManagementService.getSubnet();

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/v1/ip-management/subnet");
    expect(options.method).toBe("GET");
  });

  test("upsertSubnet 走 PUT /ip-management/subnet 並帶 body", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(200, { cidr: "10.10.0.0/24" }));

    await IpManagementService.upsertSubnet({
      cidr: "10.10.0.0/24",
      gateway: "10.10.0.1",
      bridge_name: "vmbr1",
      gateway_vm_ip: "10.10.0.2",
      dns_servers: null,
      extra_blocked_subnets: ["192.168.100.0/24"],
    });

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/v1/ip-management/subnet");
    expect(options.method).toBe("PUT");
    const body = JSON.parse(options.body);
    expect(body.cidr).toBe("10.10.0.0/24");
    expect(body.extra_blocked_subnets).toEqual(["192.168.100.0/24"]);
  });

  test("deleteSubnet 走 DELETE /ip-management/subnet", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(200, { message: "子網配置已刪除" }));

    await IpManagementService.deleteSubnet();

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/v1/ip-management/subnet");
    expect(options.method).toBe("DELETE");
  });

  test("listAllocations 把 skip / limit 組成 query string", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(200, { allocations: [], total: 0 }));

    await IpManagementService.listAllocations({ skip: 0, limit: 500 });

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/v1/ip-management/allocations?skip=0&limit=500");
    expect(options.method).toBe("GET");
  });

  test("getStatus 走 GET /ip-management/status", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(200, { configured: false }));

    await IpManagementService.getStatus();

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/v1/ip-management/status");
    expect(options.method).toBe("GET");
  });
});
```

- [ ] **Step 2: 執行測試**

```bash
cd frontend && bun run test -- --run src/services/ipManagement.test.js
```

Expected: 5 個測試全數 PASS。（service 函式已存在，這是把既有行為釘住的迴歸測試，不是紅燈起步的新功能。）

- [ ] **Step 3: Commit**

```bash
git add frontend/src/services/ipManagement.test.js && git commit -m "test(frontend): 補 ipManagement service 的 URL/method 測試"
```

---

### Task 3: 新增 SubnetConfigForm 元件與表單樣式

**Files:**
- Create: `frontend/src/pages/system/ip-management/SubnetConfigForm.jsx`
- Modify: `frontend/src/pages/system/ip-management/IpManagementPage.module.scss`（新增表單相關 class、補按鈕 disabled 樣式）

**Interfaces:**
- Consumes: Task 1 產出的 `pages/system/ip-management/` 目錄
- Produces: `SubnetConfigForm` 預設匯出元件，props 簽章為：

```
SubnetConfigForm({
  config,       // SubnetConfigPublic | null — null 為建立模式
  cidrLocked,   // boolean — true 時 cidr 欄位唯讀
  saving,       // boolean
  deleting,     // boolean
  onSubmit,     // (payload) => void，payload 為可直接送 PUT 的物件
  onCancel,     // () => void
  onDelete,     // () => void
})
```

payload 形狀（對應 `backend/app/schemas/ip_management.py` 的 `SubnetConfigCreate`）：

```
{ cidr: string, gateway: string, bridge_name: string,
  gateway_vm_ip: string, dns_servers: string | null,
  extra_blocked_subnets: string[] }
```

- [ ] **Step 1: 新增表單樣式**

在 `frontend/src/pages/system/ip-management/IpManagementPage.module.scss` 中，把既有的 `%btn-base`（目前在第 48-59 行）替換為下列版本 —— 補上 STYLE_GUIDE 要求的 disabled 樣式：

```scss
%btn-base {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px $spacing-16;
  border-radius: $radius-8;
  font-size: $font-size-14;
  font-weight: $font-weight-500;
  cursor: pointer;
  white-space: nowrap;
  transition: background $transition-base, box-shadow $transition-base;

  &:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
}
```

把既有的 `.btnPrimary` 與 `.btnSecondary` 的 `&:hover` 改為 `&:hover:not(:disabled)`，並在 `.btnSecondary` 之後新增 `.btnDanger`：

```scss
.btnPrimary {
  @extend %btn-base;
  background: var(--color-primary);
  color: var(--color-text-on-primary);

  &:hover:not(:disabled) {
    background: var(--color-primary-dark);
    box-shadow: var(--shadow-sm);
  }
}

.btnSecondary {
  @extend %btn-base;
  background: var(--color-surface);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  box-shadow: var(--shadow-sm);

  &:hover:not(:disabled) {
    background: var(--color-hover);
  }
}

.btnDanger {
  @extend %btn-base;
  /* 危險操作靠左，與右側的取消／儲存分開 */
  margin-right: auto;
  background: var(--color-danger);
  color: var(--color-text-on-primary);
  border: 1px solid var(--color-danger);

  &:hover:not(:disabled) {
    background: #b91c1c;
    border-color: #b91c1c;
  }
}
```

接著在檔案最末端（`.actionBtn` 之後）追加子網設定表單的樣式：

```scss
/* ── 子網設定表單 ── */
.card {
  @include flex-column;
  gap: $spacing-16;
  padding: $spacing-24;
  @include glass-surface($shadow: var(--shadow-sm));
  border-radius: $radius-16;
}

.cardTitle {
  font-size: $font-size-16;
  font-weight: $font-weight-700;
  color: var(--color-text-primary);
}

/* 標題下的說明文字（貼近標題） */
.cardDesc {
  margin-top: -$spacing-8;
  font-size: $font-size-12;
  color: var(--color-text-muted);
}

.formGrid {
  display: grid;
  grid-template-columns: 1fr;
  gap: $spacing-16;

  @include respond-to(md) {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

.field {
  @include flex-column;
  gap: 6px;
  font-size: $font-size-12;
  font-weight: $font-weight-500;
  color: var(--color-text-secondary);

  input,
  textarea {
    min-height: 38px;
    padding: 8px $spacing-16;
    border: 1px solid var(--color-border);
    border-radius: $radius-8;
    background: var(--color-surface);
    color: var(--color-text-primary);
    outline: none;
    font-size: $font-size-14;

    &:focus {
      border-color: var(--color-primary);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-primary) 12%, transparent);
    }

    &:read-only {
      background: var(--color-hover);
      color: var(--color-text-muted);
      cursor: not-allowed;
    }
  }

  textarea {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    resize: vertical;
  }
}

.fieldHint {
  font-weight: $font-weight-400;
  color: var(--color-text-muted);
}

.cardActions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: $spacing-8;
}
```

- [ ] **Step 2: 新增 SubnetConfigForm 元件**

建立 `frontend/src/pages/system/ip-management/SubnetConfigForm.jsx`，完整內容：

```jsx
import { useState } from "react";
import styles from "./IpManagementPage.module.scss";

const IPV4_PATTERN = "^(\\d{1,3}\\.){3}\\d{1,3}$";

/** textarea 內容切成 CIDR / IP 陣列（換行或逗號皆可） */
function parseBlockedList(text) {
  return (text ?? "")
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildInitialForm(config) {
  return {
    cidr:          config?.cidr ?? "",
    gateway:       config?.gateway ?? "",
    bridge_name:   config?.bridge_name ?? "vmbr1",
    gateway_vm_ip: config?.gateway_vm_ip ?? "",
    dns_servers:   config?.dns_servers ?? "",
    extra_blocked_subnets: (config?.extra_blocked_subnets ?? []).join("\n"),
  };
}

/**
 * 子網設定表單 — 純受控元件，不直接呼叫 API。
 * 送出時把整理好的 payload 交給 onSubmit，由頁面負責打 service。
 */
export default function SubnetConfigForm({
  config,
  cidrLocked,
  saving,
  deleting,
  onSubmit,
  onCancel,
  onDelete,
}) {
  const [form, setForm] = useState(() => buildInitialForm(config));
  const set = (name, value) => setForm((prev) => ({ ...prev, [name]: value }));
  const isEdit = Boolean(config);
  const busy = saving || deleting;

  function handleSubmit(e) {
    e.preventDefault();
    onSubmit({
      cidr:          form.cidr.trim(),
      gateway:       form.gateway.trim(),
      bridge_name:   form.bridge_name.trim(),
      gateway_vm_ip: form.gateway_vm_ip.trim(),
      dns_servers:   form.dns_servers.trim() || null,
      extra_blocked_subnets: parseBlockedList(form.extra_blocked_subnets),
    });
  }

  return (
    <form className={styles.card} onSubmit={handleSubmit}>
      <h2 className={styles.cardTitle}>
        {isEdit ? "編輯子網設定" : "建立子網設定"}
      </h2>
      <p className={styles.cardDesc}>
        設定子網後，系統才會在建立 VM / LXC 時自動分配靜態 IP。
      </p>

      <div className={styles.formGrid}>
        <label className={styles.field}>
          <span>子網 CIDR *</span>
          <input
            value={form.cidr}
            onChange={(e) => set("cidr", e.target.value)}
            placeholder="例：10.10.0.0/24"
            readOnly={cidrLocked}
            required
          />
          {cidrLocked && (
            <span className={styles.fieldHint}>
              已有 VM / LXC 使用此網段，需先刪除這些機器才能變更 CIDR。
            </span>
          )}
        </label>

        <label className={styles.field}>
          <span>閘道 IP *</span>
          <input
            value={form.gateway}
            onChange={(e) => set("gateway", e.target.value)}
            placeholder="例：10.10.0.1"
            pattern={IPV4_PATTERN}
            required
          />
        </label>

        <label className={styles.field}>
          <span>Bridge 名稱 *</span>
          <input
            value={form.bridge_name}
            onChange={(e) => set("bridge_name", e.target.value)}
            placeholder="例：vmbr1"
            required
          />
        </label>

        <label className={styles.field}>
          <span>Gateway VM IP *</span>
          <input
            value={form.gateway_vm_ip}
            onChange={(e) => set("gateway_vm_ip", e.target.value)}
            placeholder="例：10.10.0.2"
            pattern={IPV4_PATTERN}
            required
          />
          <span className={styles.fieldHint}>不可與閘道 IP 相同。</span>
        </label>

        <label className={styles.field}>
          <span>DNS Servers</span>
          <input
            value={form.dns_servers}
            onChange={(e) => set("dns_servers", e.target.value)}
            placeholder="選填，多組以逗號分隔：8.8.8.8,1.1.1.1"
          />
        </label>
      </div>

      <label className={styles.field}>
        <span>預設封鎖網段 / IP</span>
        <textarea
          rows={4}
          value={form.extra_blocked_subnets}
          onChange={(e) => set("extra_blocked_subnets", e.target.value)}
          placeholder={"選填，每行一個，例：\n192.168.100.0/24\n10.0.0.5"}
          spellCheck={false}
        />
        <span className={styles.fieldHint}>
          儲存時會在所有 VM / LXC 上建立或更新出站 DROP 規則，並清除已移除的舊規則。
        </span>
      </label>

      <div className={styles.cardActions}>
        {isEdit && (
          <button
            type="button"
            className={styles.btnDanger}
            onClick={onDelete}
            disabled={busy}
          >
            {deleting ? "刪除中..." : "刪除子網設定"}
          </button>
        )}
        <button
          type="button"
          className={styles.btnSecondary}
          onClick={onCancel}
          disabled={busy}
        >
          取消
        </button>
        <button type="submit" className={styles.btnPrimary} disabled={busy}>
          {saving ? "儲存中..." : isEdit ? "更新設定" : "建立設定"}
        </button>
      </div>
    </form>
  );
}
```

- [ ] **Step 3: 建置驗證**

```bash
cd frontend && bun run build
```

Expected: 建置成功。此時元件尚未被引用，只驗證語法與 SCSS 編譯（`@extend %btn-base` 在 `.btnDanger` 中要能正常展開）。

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/system/ip-management && git commit -m "feat(frontend): 新增 SubnetConfigForm 子網設定表單元件"
```

---

### Task 4: 把表單接上 IP 管理頁

**Files:**
- Modify: `frontend/src/pages/system/ip-management/IpManagementPage.jsx`

**Interfaces:**
- Consumes: Task 3 的 `SubnetConfigForm`（props 見 Task 3 的 Produces）；`IpManagementService.upsertSubnet(body)` / `deleteSubnet()`（Task 2 已測試）
- Produces: 無（終點任務）

**背景與注意事項：**

1. `getSubnet()` 需要 AdminUser，非管理員會 403，頁面現行以 `.catch(() => null)` 吞掉。因此「是否已設定」不能只看 `subnet`，要併看 `status.configured`（`/status` 是 CurrentUser 可讀）。
2. 現行 `EmptyState` 在「搜尋沒結果」時也會顯示「尚未設定子網」，加上 CTA 後會變成誤導，本任務一併修正成三種狀態。
3. `useAutoRefresh` 內部用 ref 保存最新 callback，所以可以直接在 callback 內讀 `editing` 來決定是否跳過背景刷新，不需要額外依賴處理。

- [ ] **Step 1: 改寫 IpManagementPage.jsx**

以下為 `frontend/src/pages/system/ip-management/IpManagementPage.jsx` 的完整新內容：

```jsx
import { useCallback, useEffect, useMemo, useState } from "react";
import styles from "./IpManagementPage.module.scss";
import MIcon from "../../../components/MIcon";
import SubnetConfigForm from "./SubnetConfigForm";
import { useAuth } from "../../../contexts/AuthContext";
import { IpManagementService } from "../../../services/ipManagement";
import { useToast } from "../../../hooks/useToast";
import useAutoRefresh from "../../../hooks/useAutoRefresh";

const COLUMNS = ["IP 位址", "用途", "VMID", "備註", "分配時間"];

const PURPOSE_LABELS = {
  vm: "VM",
  lxc: "LXC",
  gateway_vm: "Gateway VM",
  subnet_gateway: "閘道",
  reserved: "保留",
};

function EmptyState({ variant, canConfigure, onConfigure }) {
  if (variant === "unconfigured") {
    return (
      <div className={styles.empty}>
        <div className={styles.emptyIcon}>
          <MIcon name="lan" size={40} />
        </div>
        <h2 className={styles.emptyTitle}>尚未設定子網</h2>
        <p className={styles.emptyDesc}>
          建立子網設定後，系統將自動為虛擬機與容器分配 IP 位址
        </p>
        {canConfigure && (
          <button type="button" className={styles.btnPrimary} onClick={onConfigure}>
            <MIcon name="add" size={18} />
            建立子網設定
          </button>
        )}
      </div>
    );
  }

  const isNoMatch = variant === "no-match";
  return (
    <div className={styles.empty}>
      <div className={styles.emptyIcon}>
        <MIcon name={isNoMatch ? "search_off" : "inbox"} size={40} />
      </div>
      <h2 className={styles.emptyTitle}>
        {isNoMatch ? "沒有符合條件的 IP" : "尚無 IP 分配記錄"}
      </h2>
      <p className={styles.emptyDesc}>
        {isNoMatch
          ? "換個 IP、VMID 或備註關鍵字再試一次"
          : "建立虛擬機或容器後，分配的 IP 會顯示在這裡"}
      </p>
    </div>
  );
}

function PurposeBadge({ purpose }) {
  const label = PURPOSE_LABELS[purpose] ?? purpose ?? "—";
  return (
    <span className={`${styles.badge} ${styles[`badge_${purpose ?? "unknown"}`]}`}>
      {label}
    </span>
  );
}

export default function IpManagementPage() {
  const toast = useToast();
  const { user } = useAuth();
  const isAdmin = Boolean(user?.is_superuser || user?.role === "admin");

  const [allocations, setAllocations] = useState([]);
  const [subnet, setSubnet] = useState(null);
  const [status, setStatus] = useState(null);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  /** silent = true 時不觸發 loading 與錯誤提示，供背景自動刷新使用 */
  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [allocRes, subnetRes, statusRes] = await Promise.all([
        IpManagementService.listAllocations({ limit: 500 }),
        IpManagementService.getSubnet().catch(() => null),
        IpManagementService.getStatus().catch(() => null),
      ]);
      setAllocations(allocRes?.allocations ?? []);
      setSubnet(subnetRes ?? null);
      setStatus(statusRes ?? null);
    } catch (e) {
      if (!silent) toast.error(e?.message ?? "載入 IP 分配失敗");
    } finally {
      if (!silent) setLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);
  /* 編輯中不背景刷新，避免表單被重新掛載而清空輸入 */
  useAutoRefresh(() => { if (!editing) load(true); });

  /* getSubnet 需要管理員權限，非管理員只能靠 status 判斷是否已設定 */
  const configured = Boolean(subnet) || Boolean(status?.configured);

  /* 已有 VM/LXC 佔用網段時後端不允許改 CIDR，先在表單擋下來 */
  const cidrLocked = useMemo(
    () => allocations.some((a) => a.purpose === "vm" || a.purpose === "lxc"),
    [allocations],
  );

  const stats = useMemo(() => {
    const total = subnet?.total_ips ?? status?.total_ips ?? 0;
    const used  = subnet?.used_ips  ?? status?.used_ips  ?? allocations.length;
    const free  = subnet?.available_ips ?? status?.available_ips ?? Math.max(0, total - used);
    return { total, used, free };
  }, [allocations, subnet, status]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return allocations;
    return allocations.filter(
      (a) =>
        (a.ip_address ?? "").toLowerCase().includes(q) ||
        (a.description ?? "").toLowerCase().includes(q) ||
        String(a.vmid ?? "").includes(q),
    );
  }, [allocations, filter]);

  const emptyVariant = !configured
    ? "unconfigured"
    : allocations.length === 0
      ? "no-data"
      : "no-match";

  async function handleSave(payload) {
    setSaving(true);
    try {
      await IpManagementService.upsertSubnet(payload);
      toast.success("子網設定已儲存");
      setEditing(false);
      await load();
    } catch (e) {
      toast.error(e?.message ?? "儲存子網設定失敗");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    const ok = window.confirm(
      "確定刪除子網設定？刪除後全站 VM / LXC 建立功能將被停用，且需無任何 VM / LXC 仍佔用 IP 才能刪除。",
    );
    if (!ok) return;
    setDeleting(true);
    try {
      await IpManagementService.deleteSubnet();
      toast.success("子網設定已刪除");
      setEditing(false);
      await load();
    } catch (e) {
      toast.error(e?.message ?? "刪除子網設定失敗");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <div className={styles.pageHeading}>
          <h1 className={styles.pageTitle}>IP 管理</h1>
          <p className={styles.pageSubtitle}>管理子網設定與所有 IP 位址分配</p>
        </div>
        {isAdmin && !editing && (
          <div className={styles.pageActions}>
            <button
              type="button"
              className={styles.btnPrimary}
              onClick={() => setEditing(true)}
            >
              <MIcon name={configured ? "edit" : "add"} size={18} />
              {configured ? "編輯子網設定" : "建立子網設定"}
            </button>
          </div>
        )}
      </div>

      <div className={styles.statRow}>
        <div className={styles.statCard}>
          <div className={styles.statIcon}>
            <MIcon name="public" size={20} />
          </div>
          <div className={styles.statInfo}>
            <span className={styles.statLabel}>子網總 IP</span>
            <span className={styles.statValue}>{stats.total}</span>
          </div>
        </div>
        <div className={styles.statCard}>
          <div className={`${styles.statIcon} ${styles.statIconOk}`}>
            <MIcon name="check_circle" size={20} />
          </div>
          <div className={styles.statInfo}>
            <span className={styles.statLabel}>可用</span>
            <span className={styles.statValue}>{stats.free}</span>
          </div>
        </div>
        <div className={styles.statCard}>
          <div className={`${styles.statIcon} ${styles.statIconBusy}`}>
            <MIcon name="lan" size={20} />
          </div>
          <div className={styles.statInfo}>
            <span className={styles.statLabel}>已分配</span>
            <span className={styles.statValue}>{stats.used}</span>
          </div>
        </div>
      </div>

      {editing && (
        <SubnetConfigForm
          key={subnet?.updated_at ?? "new"}
          config={subnet}
          cidrLocked={cidrLocked}
          saving={saving}
          deleting={deleting}
          onSubmit={handleSave}
          onCancel={() => setEditing(false)}
          onDelete={handleDelete}
        />
      )}

      <div className={styles.toolbar}>
        <div className={styles.search}>
          <MIcon name="search" size={16} />
          <input
            type="text"
            className={styles.searchInput}
            placeholder="搜尋 IP、VMID 或備註"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        {subnet && (
          <span className={styles.muted}>
            子網: <code className={styles.code}>{subnet.cidr}</code> · Bridge: <code className={styles.code}>{subnet.bridge_name}</code>
          </span>
        )}
      </div>

      <div className={styles.content}>
        {visible.length === 0 ? (
          <EmptyState
            variant={emptyVariant}
            canConfigure={isAdmin && !editing}
            onConfigure={() => setEditing(true)}
          />
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  {COLUMNS.map((col) => (
                    <th key={col} className={styles.th}>{col}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map((a) => (
                  <tr key={a.ip_address} className={styles.tr}>
                    <td className={styles.td}>
                      <div className={styles.nameCell}>
                        <div className={styles.nameIcon}>
                          <MIcon name="device_hub" size={18} />
                        </div>
                        <div>
                          <div className={styles.namePrimary}>{a.ip_address}</div>
                        </div>
                      </div>
                    </td>
                    <td className={styles.td}>
                      <PurposeBadge purpose={a.purpose} />
                    </td>
                    <td className={styles.td}>{a.vmid ?? "—"}</td>
                    <td className={styles.td}>{a.description ?? "—"}</td>
                    <td className={styles.td}>
                      {a.allocated_at
                        ? new Date(a.allocated_at).toLocaleString("zh-TW")
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
```

註：`loading` state 目前沿用原檔案的行為（僅用於抑制靜默刷新的錯誤提示），維持不變。

- [ ] **Step 2: 執行前端測試**

```bash
cd frontend && bun run test -- --run
```

Expected: 全數 PASS（含 Task 2 新增的 5 個測試）。

- [ ] **Step 3: 建置驗證**

```bash
cd frontend && bun run build
```

Expected: 建置成功。

- [ ] **Step 4: 瀏覽器驗證**

用 preview 工具啟動前端（`.claude/launch.json` 若無對應設定則先建立，`runtimeExecutable: "bun"`、`runtimeArgs: ["run", "dev"]`、`port: 5173`），以管理員身分登入後：

1. 確認側欄「系統管理」群組下出現「IP 管理」，且「網路」群組下已無此項。
2. 進入 `/ip-management`，確認頁首出現「建立子網設定」或「編輯子網設定」按鈕。
3. 點按鈕，確認表單卡片展開於統計列下方；點「取消」確認收合。
4. `read_console_messages` 確認無 React 警告或錯誤。
5. `resize_window` 切 mobile 與深色主題，確認 formGrid 收成單欄、輸入框在深色下可讀。
6. 截圖存證。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/system/ip-management/IpManagementPage.jsx && git commit -m "feat(frontend): IP 管理頁補回子網設定的建立/編輯/刪除入口"
```

---

## Self-Review

**Spec coverage：**

| Spec 章節 | 對應任務 |
|-----------|----------|
| 一、位置調整（側欄 + 目錄 + App.jsx） | Task 1 |
| 二、元件切分（SubnetConfigForm） | Task 3 Step 2 |
| 三、UI 與動線（頁首按鈕、展開、CTA、isAdmin） | Task 4 Step 1 |
| 四、表單欄位 | Task 3 Step 2 |
| 五、驗證與錯誤處理（required/pattern、CIDR 鎖定、toast） | Task 3 Step 2 + Task 4 Step 1 |
| 六、刪除（window.confirm + 危險區） | Task 3 Step 2（按鈕）+ Task 4 Step 1（handleDelete） |
| 七、測試（ipManagement.test.js） | Task 2 |

無遺漏。

**Placeholder scan：** 無 TBD／TODO；所有程式碼步驟都附完整可貼上的內容。

**Type consistency：** `SubnetConfigForm` 的 props（`config` / `cidrLocked` / `saving` / `deleting` / `onSubmit` / `onCancel` / `onDelete`）在 Task 3 定義、Task 4 呼叫端逐一對應一致；payload 欄位名與 `SubnetConfigCreate` 一致；`styles.btnDanger` / `styles.card` / `styles.fieldHint` 等 class 都在 Task 3 Step 1 的 SCSS 中定義。

**計畫外的順帶修正（已納入 Task 4）：** `EmptyState` 原本在「搜尋無結果」時也顯示「尚未設定子網」，加上 CTA 後會誤導，故改為三態。這是所修改程式碼本身的缺陷，屬必要修正。
