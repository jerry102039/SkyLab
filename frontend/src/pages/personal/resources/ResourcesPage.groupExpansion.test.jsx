// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import ResourcesPage from "./ResourcesPage";
import { createTestQueryClient, withQueryClient } from "../../../queries/testing";

/** 環境群組的開合記在本機：收起後離開頁面再回來，不會又被全部展開 */

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  listMySessions: vi.fn(),
  listRequests: vi.fn(),
  buildEnvironmentGroups: vi.fn(),
  t: (key) => key,
}));

vi.mock("../../../services/resources", () => ({ ResourcesService: { list: mocks.list } }));
vi.mock("../../../services/quickPractice", () => ({ QuickPracticeService: { listMySessions: mocks.listMySessions } }));
vi.mock("../../../services/vmRequests", () => ({ VmRequestsService: { list: mocks.listRequests } }));
vi.mock("../../../utils/environmentGroups", () => ({
  buildEnvironmentGroups: mocks.buildEnvironmentGroups,
  groupedResourceKeys: (groups = []) => ({
    requestIds: new Set(groups.flatMap((g) => g.machines.map((m) => String(m.requestId)))),
    vmids: new Set(groups.flatMap((g) => g.machines.map((m) => m.vmid))),
  }),
}));
vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn() }));
vi.mock("react-i18next", async (importOriginal) => ({
  ...await importOriginal(),
  useTranslation: () => ({ t: mocks.t }),
}));
vi.mock("../../../contexts/AuthContext", () => ({ useAuth: () => ({ user: { id: "u1", role: "student" } }) }));
vi.mock("../../../hooks/useToast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock("../../../components/ConfirmDialog/ConfirmProvider", () => ({ useConfirm: () => vi.fn() }));
vi.mock("../../../components/PageHeader/PageHeader", () => ({ default: () => null }));
vi.mock("../../../components/QuotaUsageBar/QuotaUsageBar", () => ({ default: () => null }));
vi.mock("../../../components/MachineKindBadge/MachineKindBadge", () => ({ default: () => null }));

let root;
let host;
let client;

async function flush() {
  await act(async () => {
    /* TanStack Query 以 macrotask 批次通知，先等一個 timer tick */
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

async function renderPage() {
  await act(async () => { root.render(withQueryClient(<ResourcesPage />, client)); });
  await flush();
}

/* 離開頁面再回來：卸載後用同一份快取重新掛載 */
async function remountPage() {
  act(() => root.unmount());
  root = createRoot(host);
  await renderPage();
}

function rowOf(text) {
  return [...host.querySelectorAll("tr")].find((row) => row.textContent.includes(text));
}

function toggleOf(title) {
  return rowOf(title).querySelector('button[aria-label="EnvironmentGroupRows.toggleAria"]');
}

const group = (id, title, vmid) => ({
  id,
  kind: "course",
  title,
  status: "active",
  timingLabel: "—",
  nodeLabel: "pve1",
  machines: [{ id: `m-${vmid}`, name: `machine-${vmid}`, vmid, requestId: vmid, status: "stopped", os: "Ubuntu", resource: { vmid } }],
});

beforeEach(() => {
  vi.resetAllMocks();
  window.localStorage.clear();
  client = createTestQueryClient();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  mocks.list.mockResolvedValue([]);
  mocks.listMySessions.mockResolvedValue([]);
  mocks.listRequests.mockResolvedValue({ data: [] });
  mocks.buildEnvironmentGroups.mockReturnValue([group("course-a", "課程 A", 101), group("course-b", "課程 B", 102)]);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  window.localStorage.clear();
});

describe("ResourcesPage environment group expansion", () => {
  test("a collapsed group stays collapsed after leaving and returning, and an expanded one stays expanded", async () => {
    await renderPage();
    // 沒記過的群組照舊展開
    expect(rowOf("machine-101")).toBeTruthy();
    expect(rowOf("machine-102")).toBeTruthy();

    await act(async () => { toggleOf("課程 A").click(); });
    expect(rowOf("machine-101")).toBeUndefined();

    await remountPage();
    expect(toggleOf("課程 A").getAttribute("aria-expanded")).toBe("false");
    expect(rowOf("machine-101")).toBeUndefined();
    expect(rowOf("machine-102")).toBeTruthy();

    await act(async () => { toggleOf("課程 A").click(); });
    await remountPage();
    expect(rowOf("machine-101")).toBeTruthy();
  });

  test("clicking the group row background toggles and remembers too", async () => {
    await renderPage();
    await act(async () => { rowOf("課程 B").querySelector("td").click(); });
    expect(rowOf("machine-102")).toBeUndefined();

    await remountPage();
    expect(rowOf("machine-102")).toBeUndefined();
    expect(rowOf("machine-101")).toBeTruthy();
  });
});
