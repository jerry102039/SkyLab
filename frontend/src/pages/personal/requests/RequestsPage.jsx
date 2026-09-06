import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../../../contexts/AuthContext";
import styles from "./RequestsPage.module.scss";
import { VmRequestsService } from "../../../services/vmRequests";
import { CONSUMED_REQUEST_MARKERS, isConsumedRequest } from "../../../services/pendingResources";
import {
  SpecChangeRequestsService,
  canApplySpecRequest,
  canCancelSpecRequest,
  specRequestChangeLabel,
  specRequestDisplayStatus,
} from "../../../services/specChangeRequests";
import { useToast } from "../../../hooks/useToast";
import useAutoRefresh from "../../../hooks/useAutoRefresh";
import RequestFormPage from "./RequestFormPage";
import MIcon from "../../../components/MIcon";
import SharedEmptyState from "../../../components/EmptyState/EmptyState";
import PageHeader from "../../../components/PageHeader/PageHeader";

/* ── Constants ── */
const STATUS_MAP = {
  pending:   { label: "審核中", color: "info"    },
  approved:  { label: "已核准", color: "success" },
  rejected:  { label: "已拒絕", color: "danger"  },
  cancelled: { label: "已取消", color: "muted"   },
  expired:   { label: "已過期", color: "muted"   },
};

const RESOURCE_TYPE_MAP = {
  lxc: { label: "容器 (LXC)", icon: "terminal" },
  vm:  { label: "虛擬機 (VM)", icon: "computer" },
};

/* 開通成功後 VMRequest.status 仍停留在 approved（後端只把 vmid 寫回），
   所以「重試／撤銷」必須同時看 vmid：vmid 已存在代表機器已開出來，
   重試會把使用者關機的 VM 重新開機、撤銷會讓 request 與活著的資源脫鉤。 */
function canRetry(req) {
  return (
    req.status === "approved" &&
    req.vmid == null &&
    req.provisioning_status === "failed"
  );
}

function canCancel(req) {
  return (
    req.status === "pending" ||
    (req.status === "approved" && req.vmid == null)
  );
}

/* 機器已建立（vmid 已寫回）但排程器後續維運失敗：
   後端 retry 會拒絕這種狀態，只能到「我的資源」操作或刪除該機器 */
function isProvisionedButFailed(req) {
  return (
    req.status === "approved" &&
    req.vmid != null &&
    req.provisioning_status === "failed"
  );
}
/* 機器已建立但暫時開不了機（如 GPU 記憶體不足），排程器持續重試中 */
function isWaitingForResources(req) {
  return (
    req.status === "approved" &&
    req.vmid != null &&
    req.provisioning_status !== "failed" &&
    Boolean(req.resource_warning)
  );
}

/* approved 在 UI 上再依開通進度細分（vmid 為空時 provisioning_status 反映開通流程） */
function getDisplayStatus(req) {
  if (req.status === "approved") {
    if (req.vmid != null) {
      if (req.provisioning_status === "failed") return { label: "機器異常", color: "danger" };
      if (isWaitingForResources(req)) return { label: "等待資源釋出", color: "warning" };
      return { label: "已開通", color: "success" };
    }
    if (req.provisioning_status === "failed") return { label: "開通失敗", color: "danger" };
    if (req.provisioning_status === "running") return { label: "開通中", color: "info" };
    return { label: "已核准", color: "success" };
  }
  return STATUS_MAP[req.status] ?? { label: req.status, color: "muted" };
}

const VIEW_LIST   = "list";
const VIEW_CREATE = "create";

const LIST_COLUMNS = ["資源", "系統", "規格", "申請時間", "狀態", "操作"];
const SPEC_COLUMNS = ["機器", "變更內容", "申請時間", "狀態", "操作"];
/* 套用中（關機 → 改規格 → 開機）約 1～3 分鐘，比 30 秒自動刷新更勤地跟進度 */
const SPEC_APPLY_POLL_MS = 5000;

/* ── Helpers ── */
function formatDatetime(isoStr) {
  if (!isoStr) return null;
  return new Date(isoStr).toLocaleString("zh-TW", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

function formatDate(isoStr) {
  if (!isoStr) return "—";
  return new Date(isoStr).toLocaleDateString("zh-TW", {
    year: "numeric", month: "2-digit", day: "2-digit",
  });
}

function getOsDisplay(req) {
  if (req.os_info) return req.os_info;
  if (req.ostemplate) {
    const filename = req.ostemplate.split("/").pop() ?? req.ostemplate;
    return filename.replace(/\.tar\.\w+$/, "").replace(/\.tar$/, "");
  }
  return null;
}

function getFormInfoItems(req) {
  const items = [];
  if (req.username)             items.push({ label: "帳號",   value: req.username });
  if (req.gpu_mapping_id)       items.push({ label: "GPU",    value: req.gpu_mapping_id });
  return items;
}

function getMemDisplay(memMB) {
  if (memMB % 1024 === 0) return `${memMB / 1024} GB`;
  return `${(memMB / 1024).toFixed(1)} GB`;
}

/* ── Primitive sub-components ── */
function StatusBadge({ req }) {
  const s = getDisplayStatus(req);
  return (
    <span className={`${styles.badge} ${styles[`badge_${s.color}`]}`}>
      {s.label}
    </span>
  );
}

function InfoRow({ icon, label, value }) {
  if (!value) return null;
  return (
    <div className={styles.infoRow}>
      <span className={styles.infoLabel}>
        <MIcon name={icon} size={12} />
        {label}
      </span>
      <span className={styles.infoValue}>{value}</span>
    </div>
  );
}

function getSpecDisplay(req) {
  return `${req.cores} 核 / ${getMemDisplay(req.memory)} / ${req.storage}`;
}

/* ── Confirm Modal ── */
function ConfirmModal({ title, desc, confirmLabel = "確定", danger = false, loading = false, onConfirm, onClose }) {
  const [closing, setClosing] = useState(false);

  function close() {
    if (closing) return;
    setClosing(true);
  }

  function handleAnimationEnd() {
    if (closing) onClose();
  }

  return (
    <div
      className={`${styles.modalOverlay} ${closing ? styles.modalOverlayOut : ""}`}
      onClick={close}
      onAnimationEnd={handleAnimationEnd}
    >
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <span className={styles.modalTitle}>{title}</span>
        {desc && <p className={styles.modalDesc}>{desc}</p>}
        <div className={styles.modalActions}>
          <button type="button" className={styles.btnSecondary} onClick={close}>
            取消
          </button>
          <button
            type="button"
            className={danger ? styles.btnDanger : styles.btnPrimary}
            disabled={loading}
            onClick={onConfirm}
          >
            {loading ? "處理中…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── RequestRow ── */
function RequestRow({ req, onUpdated }) {
  const toast = useToast();
  const navigate = useNavigate();
  const { user } = useAuth();
  /* VMID 是系統內部編號，僅管理員／老師看得到 */
  const showVmid = user?.is_superuser || user?.role === "admin" || user?.role === "teacher";
  const [expanded, setExpanded]           = useState(false);
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const [cancelling, setCancelling]       = useState(false);
  const [retrying, setRetrying]           = useState(false);

  const type      = RESOURCE_TYPE_MAP[req.resource_type] ?? { label: req.resource_type, icon: "computer" };
  const osDisplay = getOsDisplay(req);
  const formItems = getFormInfoItems(req);
  const startFmt  = formatDatetime(req.start_at);
  const endFmt    = formatDatetime(req.end_at);

  const showRejection = req.status === "rejected" && req.review_comment;
  const showFailure =
    (canRetry(req) || isProvisionedButFailed(req)) && req.provisioning_error;
  const showWaiting = isWaitingForResources(req);
  const hasDetail =
    formItems.length > 0 || req.reason || startFmt || showRejection ||
    showFailure || showWaiting;
  const hasAction = canRetry(req) || canCancel(req) || isProvisionedButFailed(req);

  async function handleCancel() {
    setCancelling(true);
    try {
      const updated = await VmRequestsService.cancel(req.id);
      onUpdated(updated);
      toast.success(`已撤銷申請「${req.hostname}」`);
    } catch (err) {
      toast.error(err?.message ?? "撤銷失敗，請稍後再試。");
    } finally {
      setCancelling(false);
      setCancelConfirm(false);
    }
  }

  async function handleRetry() {
    setRetrying(true);
    try {
      const updated = await VmRequestsService.retry(req.id);
      onUpdated(updated);
      toast.success("已重新觸發開通，進度將自動更新");
    } catch (err) {
      toast.error(err?.message ?? "重試失敗，請稍後再試。");
    } finally {
      setRetrying(false);
    }
  }

  return (
    <>
      <tr
        className={`${styles.tr} ${hasDetail ? styles.trClickable : ""} ${expanded ? styles.trExpanded : ""}`}
        onClick={hasDetail ? (event) => {
          /* 整列都可以開合，列內的按鈕（重試、撤銷…）各自處理自己的點擊 */
          if (event.target.closest("button")) return;
          setExpanded((v) => !v);
        } : undefined}
      >
        <td className={styles.td}>
          <div className={styles.nameCell}>
            {hasDetail ? (
              <button
                type="button"
                className={styles.expandBtn}
                aria-expanded={expanded}
                aria-label={expanded ? "收合詳細資訊" : "展開詳細資訊"}
                onClick={() => setExpanded((v) => !v)}
              >
                <MIcon name={expanded ? "expand_more" : "chevron_right"} size={16} />
              </button>
            ) : (
              <span className={styles.expandPlaceholder} aria-hidden="true" />
            )}
            <div className={styles.nameMeta}>
              <span className={styles.namePrimary}>{req.hostname}</span>
              <span className={styles.nameSub}>
                {type.label}
                {showVmid && req.vmid != null && ` · 編號 ${req.vmid}`}
              </span>
            </div>
          </div>
        </td>
        <td className={styles.td}>
          <span className={styles.osCell}>{osDisplay ?? "—"}</span>
        </td>
        <td className={styles.td}>
          <span className={styles.specCell}>{getSpecDisplay(req)}</span>
        </td>
        <td className={styles.td}>{formatDate(req.created_at)}</td>
        <td className={styles.td}><StatusBadge req={req} /></td>
        <td className={styles.td}>
          <div className={styles.rowActions}>
            {!hasAction && <span className={styles.emptyAction}>—</span>}
            {canRetry(req) && (
              <button type="button" className={styles.retryBtn} disabled={retrying} onClick={handleRetry}>
                <MIcon name="refresh" size={13} />
                {retrying ? "…" : "重試"}
              </button>
            )}
            {canCancel(req) && (
              <button type="button" className={styles.cancelBtn} onClick={() => setCancelConfirm(true)}>
                <MIcon name="close" size={13} />
                撤銷
              </button>
            )}
            {isProvisionedButFailed(req) && (
              <button type="button" className={styles.retryBtn} onClick={() => navigate("/my-resources")}>
                <MIcon name="inventory_2" size={13} />
                前往我的資源
              </button>
            )}
          </div>
        </td>
      </tr>

      {expanded && (
        <tr className={styles.detailTr}>
          <td className={styles.detailTd} colSpan={LIST_COLUMNS.length}>
            <div className={styles.detailBody}>
              {formItems.map(({ label, value }) => (
                <InfoRow key={label} icon="tune" label={label} value={value} />
              ))}
              <InfoRow icon="chat_bubble_outline" label="申請原因" value={req.reason} />
              <InfoRow
                icon="calendar_month"
                label="預約期間"
                value={startFmt ? `${startFmt}${endFmt ? ` ~ ${endFmt}` : ""}` : null}
              />
              {showRejection && (
                <div className={styles.reviewComment}>
                  <MIcon name="comment" size={13} />
                  <span>{req.review_comment}</span>
                </div>
              )}
              {showFailure && (
                <div className={styles.reviewComment}>
                  <MIcon name="error_outline" size={13} />
                  <span>
                    {req.provisioning_error}
                    {isProvisionedButFailed(req) &&
                      "（機器已建立，此申請無法重試；請到「我的資源」開機或刪除這台機器。）"}
                  </span>
                </div>
              )}
              {showWaiting && (
                <div className={styles.reviewComment}>
                  <MIcon name="hourglass_empty" size={13} />
                  <span>{req.resource_warning}</span>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}

      {cancelConfirm && (
        <ConfirmModal
          title="確定撤銷申請？"
          desc={`申請「${req.hostname}」撤銷後無法復原。`}
          confirmLabel="撤銷申請"
          danger
          loading={cancelling}
          onConfirm={handleCancel}
          onClose={() => setCancelConfirm(false)}
        />
      )}
    </>
  );
}

/* ── 規格調整申請列 ── */
function SpecRequestRow({ req, onUpdated }) {
  const toast = useToast();
  const { user } = useAuth();
  const showVmid = user?.is_superuser || user?.role === "admin" || user?.role === "teacher";
  const [expanded, setExpanded]         = useState(false);
  const [applyConfirm, setApplyConfirm] = useState(false);
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const [busy, setBusy]                 = useState(false);

  const display    = specRequestDisplayStatus(req);
  const showApply  = canApplySpecRequest(req);
  const showCancel = canCancelSpecRequest(req);
  const hasAction  = showApply || showCancel;
  /* 機器刪除時系統會把處理中的申請自動取消，備註是系統標記不是審核人留言 */
  const deletedByMachine = CONSUMED_REQUEST_MARKERS.includes(req.review_comment);
  const reviewNote =
    !deletedByMachine &&
    req.review_comment &&
    !["Cancelled by requester", "Cancelled by admin"].includes(req.review_comment)
      ? req.review_comment
      : null;
  const applyNote = req.apply_error || null;
  const hasDetail = Boolean(req.reason || reviewNote || applyNote || deletedByMachine || req.applied_at);

  async function handleApply() {
    setBusy(true);
    try {
      const res = await SpecChangeRequestsService.apply(req.id);
      onUpdated(res.request);
      toast.success("已開始套用新規格，完成後狀態會自動更新");
    } catch (err) {
      toast.error(err?.message ?? "套用失敗，請稍後再試。");
    } finally {
      setBusy(false);
      setApplyConfirm(false);
    }
  }

  async function handleCancel() {
    setBusy(true);
    try {
      const updated = await SpecChangeRequestsService.cancel(req.id);
      onUpdated(updated);
      toast.success("已撤銷規格調整申請");
    } catch (err) {
      toast.error(err?.message ?? "撤銷失敗，請稍後再試。");
    } finally {
      setBusy(false);
      setCancelConfirm(false);
    }
  }

  return (
    <>
      <tr
        className={`${styles.tr} ${hasDetail ? styles.trClickable : ""} ${expanded ? styles.trExpanded : ""}`}
        onClick={hasDetail ? (event) => {
          if (event.target.closest("button")) return;
          setExpanded((v) => !v);
        } : undefined}
      >
        <td className={styles.td}>
          <div className={styles.nameCell}>
            {hasDetail ? (
              <button
                type="button"
                className={styles.expandBtn}
                aria-expanded={expanded}
                aria-label={expanded ? "收合詳細資訊" : "展開詳細資訊"}
                onClick={() => setExpanded((v) => !v)}
              >
                <MIcon name={expanded ? "expand_more" : "chevron_right"} size={16} />
              </button>
            ) : (
              <span className={styles.expandPlaceholder} aria-hidden="true" />
            )}
            <div className={styles.nameMeta}>
              <span className={styles.namePrimary}>{req.resource_name || `機器 ${req.vmid}`}</span>
              <span className={styles.nameSub}>
                規格調整
                {showVmid && ` · 編號 ${req.vmid}`}
              </span>
            </div>
          </div>
        </td>
        <td className={styles.td}>
          <span className={styles.specCell}>{specRequestChangeLabel(req)}</span>
        </td>
        <td className={styles.td}>{formatDate(req.created_at)}</td>
        <td className={styles.td}>
          <span className={`${styles.badge} ${styles[`badge_${display.color}`]}`}>{display.label}</span>
        </td>
        <td className={styles.td}>
          <div className={styles.rowActions}>
            {!hasAction && <span className={styles.emptyAction}>—</span>}
            {showApply && (
              <button type="button" className={styles.applyBtn} disabled={busy} onClick={() => setApplyConfirm(true)}>
                <MIcon name="play_arrow" size={13} />
                {display.key === "ready" ? "套用" : "重新套用"}
              </button>
            )}
            {showCancel && (
              <button type="button" className={styles.cancelBtn} disabled={busy} onClick={() => setCancelConfirm(true)}>
                <MIcon name="close" size={13} />
                撤銷
              </button>
            )}
          </div>
        </td>
      </tr>

      {expanded && (
        <tr className={styles.detailTr}>
          <td className={styles.detailTd} colSpan={SPEC_COLUMNS.length}>
            <div className={styles.detailBody}>
              <InfoRow icon="chat_bubble_outline" label="申請原因" value={req.reason} />
              <InfoRow icon="event_available" label="套用時間" value={formatDatetime(req.applied_at)} />
              {reviewNote && (
                <div className={styles.reviewComment}>
                  <MIcon name="comment" size={13} />
                  <span>{reviewNote}</span>
                </div>
              )}
              {deletedByMachine && (
                <div className={styles.reviewComment}>
                  <MIcon name="info" size={13} />
                  <span>機器已刪除，申請已自動取消。</span>
                </div>
              )}
              {applyNote && (
                <div className={styles.reviewComment}>
                  <MIcon name={req.applied_at ? "warning" : "error_outline"} size={13} />
                  <span>{applyNote}</span>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}

      {applyConfirm && (
        <ConfirmModal
          title="套用新規格？"
          desc="若機器正在執行，系統會先關機、套用規格後再自動開機（容器的 CPU／記憶體可線上生效，不會重開）。過程約 1～3 分鐘無法使用，請先儲存機器內的工作。"
          confirmLabel="關機並套用"
          loading={busy}
          onConfirm={handleApply}
          onClose={() => setApplyConfirm(false)}
        />
      )}

      {cancelConfirm && (
        <ConfirmModal
          title="確定撤銷規格調整申請？"
          desc="撤銷後若還需要調整，需重新送出申請並再次審核。"
          confirmLabel="撤銷申請"
          danger
          loading={busy}
          onConfirm={handleCancel}
          onClose={() => setCancelConfirm(false)}
        />
      )}
    </>
  );
}

/* ── Skeleton ── */
function SkeletonRow() {
  return (
    <tr className={styles.tr} aria-hidden>
      <td className={styles.td}>
        <div className={styles.nameCell}>
          <span className={styles.expandPlaceholder} aria-hidden="true" />
          <div className={styles.nameMeta}>
            <div className={`${styles.skeleton} ${styles.skRow}`} style={{ width: 110, height: 13 }} />
            <div className={`${styles.skeleton} ${styles.skRow}`} style={{ width: 70, height: 10 }} />
          </div>
        </div>
      </td>
      <td className={styles.td}>
        <div className={`${styles.skeleton} ${styles.skRow}`} style={{ width: 90, height: 12 }} />
      </td>
      <td className={styles.td}>
        <div className={`${styles.skeleton} ${styles.skRow}`} style={{ width: 130, height: 12 }} />
      </td>
      <td className={styles.td}>
        <div className={`${styles.skeleton} ${styles.skRow}`} style={{ width: 80, height: 12 }} />
      </td>
      <td className={styles.td}>
        <div className={`${styles.skeleton} ${styles.skBadge}`} />
      </td>
      <td className={styles.td}>
        <div className={`${styles.skeleton} ${styles.skRow}`} style={{ width: 60, height: 12 }} />
      </td>
    </tr>
  );
}

/* ── Empty / Error states ── */
function EmptyState({ onCreateClick }) {
  return (
    <SharedEmptyState
      icon="description"
      title="尚無申請紀錄"
      action={
        <button type="button" className={styles.btnPrimary} onClick={onCreateClick}>
          <MIcon name="add" size={16} />
          立即申請
        </button>
      }
    />
  );
}

function ErrorState({ onRetry }) {
  return (
    <EmptyState
      icon="error_outline"
      title="載入失敗"
      action={
        <button type="button" className={styles.btnSecondary} onClick={onRetry}>
          <MIcon name="refresh" size={16} />
          重試
        </button>
      }
    />
  );
}

/* ── Page ── */
export default function RequestsPage() {
  /* 其他頁（如快速建立的「完整設定」）可用 navigate("/my-requests", { state: { create: true } }) 直接開表單 */
  const location = useLocation();
  const [requests, setRequests] = useState([]);
  const [specRequests, setSpecRequests] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(false);
  const [view, setView]         = useState(location.state?.create ? VIEW_CREATE : VIEW_LIST);
  const [returning, setReturning] = useState(false);
  /* AI 助手談完需求後會把推薦配置一起帶過來 */
  const [pendingPrefill, setPendingPrefill] = useState(location.state?.prefill ?? null);

  /** silent = true 時不觸發 loading / error state，供背景自動刷新使用 */
  const fetchRequests = useCallback(async (silent = false) => {
    if (!silent) {
      setLoading(true);
      setError(false);
    }
    try {
      const [res, specRes] = await Promise.all([
        VmRequestsService.list(),
        /* 規格調整申請載入失敗不拖垮主列表 */
        SpecChangeRequestsService.listMy().catch(() => null),
      ]);
      // 機器已被刪除／轉範本的申請單只留做稽核，不顯示
      setRequests((res.data ?? []).filter((r) => !isConsumedRequest(r)));
      if (specRes) setSpecRequests(specRes.data ?? []);
    } catch {
      if (!silent) setError(true);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (view === "list") fetchRequests();
  }, [view, fetchRequests]);

  /* 已經停在本頁時 useState 的初值不會再跑一次，所以導覽助手在這頁按步驟
     只會換掉 location.state。兩個方向都要跟：帶 create 就開表單，沒帶就回列表
     （流程裡的「等待審核」指的就是列表，按了不能沒反應）。 */
  useEffect(() => {
    setView(location.state?.create ? VIEW_CREATE : VIEW_LIST);
    if (location.state?.prefill) setPendingPrefill(location.state.prefill);
  }, [location.key, location.state?.create, location.state?.prefill]);

  useAutoRefresh(() => {
    if (view === "list") fetchRequests(true);
  });

  const specApplying = specRequests.some((r) => r.apply_status === "applying");
  useEffect(() => {
    if (view !== VIEW_LIST || !specApplying) return undefined;
    const timer = setInterval(() => fetchRequests(true), SPEC_APPLY_POLL_MS);
    return () => clearInterval(timer);
  }, [view, specApplying, fetchRequests]);

  function handleUpdated(updated) {
    setRequests((prev) => prev.map((r) => r.id === updated.id ? updated : r));
  }

  function handleSpecUpdated(updated) {
    setSpecRequests((prev) => prev.map((r) => r.id === updated.id ? updated : r));
  }

  if (view === VIEW_CREATE) {
    return (
      <RequestFormPage
        key="create"
        className={styles.animSlideInRight}
        initialPrefill={pendingPrefill}
        onBack={() => { setReturning(true); setView(VIEW_LIST); setPendingPrefill(null); }}
      />
    );
  }

  return (
    <div
      className={`${styles.page} ${returning ? styles.animSlideInLeft : ""}`}
      onAnimationEnd={returning ? () => setReturning(false) : undefined}
    >
      <PageHeader title="我的申請" subtitle="管理你的虛擬機與容器申請">
        <button type="button" className={styles.btnPrimary} onClick={() => setView(VIEW_CREATE)} data-guide="request-create">
          <MIcon name="add" size={16} />
          申請資源
        </button>
      </PageHeader>

      <div className={styles.content} data-guide="request-list">
        {error ? (
          <ErrorState onRetry={fetchRequests} />
        ) : !loading && requests.length === 0 && specRequests.length === 0 ? (
          <EmptyState onCreateClick={() => setView(VIEW_CREATE)} />
        ) : (
          <>
            {(loading || requests.length > 0) && (
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      {LIST_COLUMNS.map((column) => (
                        <th key={column} className={styles.th}>{column}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {loading
                      ? [0, 1, 2, 3].map((i) => <SkeletonRow key={i} />)
                      : requests.map((r) => (
                          <RequestRow key={r.id} req={r} onUpdated={handleUpdated} />
                        ))}
                  </tbody>
                </table>
              </div>
            )}

            {!loading && specRequests.length > 0 && (
              <section className={styles.subSection}>
                <h2 className={styles.sectionTitle}>規格調整申請</h2>
                <p className={styles.sectionDesc}>
                  審核通過後由你自己按「套用」：執行中的虛擬機會先關機、套用新規格後再自動開機。
                </p>
                <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        {SPEC_COLUMNS.map((column) => (
                          <th key={column} className={styles.th}>{column}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {specRequests.map((r) => (
                        <SpecRequestRow key={r.id} req={r} onUpdated={handleSpecUpdated} />
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
