import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../contexts/AuthContext";
import { AuthStorage } from "../../services/auth";
import { CoursesService } from "../../services/courses";
import { connectJobsWebSocket, JobsService } from "../../services/jobs";
import JobDetailDialog from "./JobDetailDialog";
import { JOB_KIND_LABEL_KEYS } from "./JobRow";

const NOTIFY_ONLY_MINE_KEY = "jobs:notifyOnlyMine";

/* 沿用學生首頁提醒中心時代的 key，保留使用者既有的已讀紀錄 */
function reminderStorageKey(user) {
  return `skylab:student-reminders:v1:${user?.id ?? user?.email ?? "student"}`;
}

function loadReadReminderIds(user) {
  try {
    const stored = JSON.parse(window.localStorage.getItem(reminderStorageKey(user)) ?? "[]");
    return Array.isArray(stored) ? stored : [];
  } catch {
    return [];
  }
}

/* 從 running/pending/blocked → 終態時觸發 toast */
const TERMINAL_STATUSES = new Set(["completed", "failed", "blocked", "cancelled"]);

function notifyJobTransition(job, prevStatus, onView, t) {
  // 第一次看到（prev undefined）且本來就是終態 → 不通知（避免重整時轟炸）
  if (prevStatus === undefined) return;
  if (prevStatus === job.status) return;
  if (!TERMINAL_STATUSES.has(job.status)) return;

  const kindLabel = JOB_KIND_LABEL_KEYS[job.kind] ? t(JOB_KIND_LABEL_KEYS[job.kind]) : job.kind;
  const action = { label: t("JobsProvider.viewAction"), onClick: () => onView(job.id) };
  const description = job.title;

  switch (job.status) {
    case "completed":
      toast.success(t("JobsProvider.jobCompleted", { kindLabel }), { description, action });
      break;
    case "failed":
      toast.error(t("JobsProvider.jobFailed", { kindLabel }), { description: job.message ?? description, action });
      break;
    case "blocked":
      toast.warning(t("JobsProvider.jobBlocked", { kindLabel }), { description: job.message ?? description, action });
      break;
    case "cancelled":
      toast(t("JobsProvider.jobCancelled", { kindLabel }), { description, action });
      break;
  }
}

const JobsContext = createContext(null);

/** 任務狀態（執行中清單、通知設定、開詳情），由 JobsProvider 提供 */
export function useJobs() {
  return useContext(JobsContext);
}

/**
 * 全站任務狀態來源（無 UI）：
 * - /ws/jobs WebSocket 即時推送為主，REST 每 15 秒輪詢為 fallback
 * - 任務進入終態（完成／失敗／受阻／取消）時彈 toast，不論當前頁面
 * - 掛載共用的 JobDetailDialog；顯示用的按鈕（JobsButton）放在 Sidebar 底部
 */
export default function JobsProvider({ children }) {
  const { t } = useTranslation("components");
  const { user } = useAuth();
  const [items, setItems] = useState(null); // 執行中任務；null = 尚未載入
  const [focusJobId, setFocusJobId] = useState(null);
  const [notifyOnlyMine, setNotifyOnlyMineState] = useState(
    () => localStorage.getItem(NOTIFY_ONLY_MINE_KEY) === "1",
  );
  const [reminders, setReminders] = useState(null); // 提醒；null = 尚未載入
  const [readReminderIds, setReadReminderIds] = useState(() => loadReadReminderIds(user));

  const isAdmin = Boolean(user?.is_superuser || user?.role === "admin");
  const myUserId = user?.id ?? null;
  // 使用 ref 送進 WS callback，避免 closure 抓舊設定導致 effect 重連
  const filterRef = useRef({ enabled: false, myUserId: null });
  filterRef.current = { enabled: notifyOnlyMine && isAdmin, myUserId };
  // 上一次 WS snapshot 中各 job 的狀態，用於 diff 觸發 toast
  const prevStatusMapRef = useRef(null);

  /* REST fallback：每 15 秒抓一次執行中任務（WS 為主） */
  const load = useCallback(async () => {
    try {
      const res = await JobsService.list({ statuses: ["running"], limit: 200, historyDays: 30 });
      setItems(res?.items ?? []);
    } catch {
      // 靜默失敗，維持現有畫面；WS 重連後會補上
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(() => {
      if (!document.hidden) load();
    }, 15000);
    return () => clearInterval(timer);
  }, [load]);

  /* WebSocket 即時推送 */
  useEffect(() => {
    const token = AuthStorage.getAccessToken();
    if (!token) return;
    return connectJobsWebSocket(token, (snapshot) => {
      const all = snapshot?.items ?? [];
      setItems(all.filter((j) => j.status === "running"));

      // /ws/jobs 的 snapshot 會附帶個人提醒（約每 30 秒重算一次）；
      // 缺欄位（舊後端）時維持 REST 載入的結果
      if (Array.isArray(snapshot?.reminders)) setReminders(snapshot.reminders);

      // ── Diff: 比對上一次 snapshot 的狀態，發 toast ──
      const prev = prevStatusMapRef.current;
      const next = new Map();
      for (const j of all) next.set(j.id, j.status);
      // 只在已建立 baseline 後才比對（首次連線當下視為基準，不要彈通知）
      if (prev !== null) {
        const { enabled, myUserId } = filterRef.current;
        for (const j of all) {
          // admin 開「只通知自己」：跳過非本人的 job
          if (enabled && j.user_id !== myUserId) continue;
          notifyJobTransition(j, prev.get(j.id), setFocusJobId, t);
        }
      }
      prevStatusMapRef.current = next;
    });
  }, []);

  /* 提醒（機器期限、審核結果、近期課堂任務）：登入後載入一次，popover 開啟時再刷新 */
  const refreshReminders = useCallback(async () => {
    try {
      const res = await CoursesService.listReminders();
      setReminders(Array.isArray(res) ? res : []);
    } catch {
      // 靜默失敗：沒有提醒權限或暫時取不到時，維持現有清單
      setReminders((current) => current ?? []);
    }
  }, []);

  /* 依身分（而非 user 物件引用）重載：token refresh 會換新 user 物件，不該重打 API */
  useEffect(() => {
    refreshReminders();
    setReadReminderIds(loadReadReminderIds(user));
  }, [refreshReminders, user?.id]);

  const persistReadReminderIds = useCallback((ids) => {
    setReadReminderIds(ids);
    try {
      window.localStorage.setItem(reminderStorageKey(user), JSON.stringify(ids));
    } catch {
      // localStorage 不可用時，已讀狀態僅本次瀏覽生效
    }
  }, [user]);

  const markReminderRead = useCallback((id) => {
    setReadReminderIds((current) => {
      if (current.includes(id)) return current;
      const next = [...current, id];
      try {
        window.localStorage.setItem(reminderStorageKey(user), JSON.stringify(next));
      } catch {
        // 同上，靜默降級
      }
      return next;
    });
  }, [user]);

  const markAllRemindersRead = useCallback(() => {
    persistReadReminderIds((reminders ?? []).map((item) => item.id));
  }, [persistReadReminderIds, reminders]);

  const setNotifyOnlyMine = useCallback((next) => {
    setNotifyOnlyMineState(next);
    try {
      localStorage.setItem(NOTIFY_ONLY_MINE_KEY, next ? "1" : "0");
    } catch {
      // localStorage 不可用時該設定僅本次瀏覽生效
    }
  }, []);

  return (
    <JobsContext.Provider
      value={{
        items,
        isAdmin,
        notifyOnlyMine,
        setNotifyOnlyMine,
        openJob: setFocusJobId,
        reminders,
        readReminderIds,
        refreshReminders,
        markReminderRead,
        markAllRemindersRead,
      }}
    >
      {children}
      <JobDetailDialog jobId={focusJobId} onClose={() => setFocusJobId(null)} />
    </JobsContext.Provider>
  );
}
