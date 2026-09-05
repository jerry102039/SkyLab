import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../../contexts/AuthContext";
import styles from "./ResourcesPage.module.scss";
import MIcon from "../../../components/MIcon";
import PowerMenu from "../../../components/PowerMenu/PowerMenu";
import SharedEmptyState from "../../../components/EmptyState/EmptyState";
import { ResourcesService } from "../../../services/resources";
import {
  PENDING_POLL_INTERVAL,
  cancelVmRequest,
  fetchPendingResources,
  pendingSignature,
} from "../../../services/pendingResources";
import { useToast } from "../../../hooks/useToast";
import useAutoRefresh from "../../../hooks/useAutoRefresh";
import TerminalDialog from "./TerminalDialog";
import VncDialog from "./VncDialog";
import QuotaUsageBar from "../../../components/Teaching/QuotaUsageBar";
import PageHeader from "../../../components/PageHeader/PageHeader";
import { QuickPracticeService } from "../../../services/quickPractice";
import { buildEnvironmentGroups, groupedResourceKeys } from "../../../utils/environmentGroups";

/* ── Constants ── */
const STATUS_MAP = {
  scheduled:    { labelKey: "ResourcesPage.statusScheduled",     color: "info",    icon: "event"          },
  provisioning: { labelKey: "ResourcesPage.statusProvisioning",  color: "info",    icon: "settings"       },
  partial_failed:{ labelKey: "ResourcesPage.statusPartialFailed",color: "danger",  icon: "error_outline"  },
  running:      { labelKey: "ResourcesPage.statusRunning",       color: "success", icon: "play_circle"    },
  stopping:     { labelKey: "ResourcesPage.statusStopping",      color: "muted",   icon: "power_settings_new" },
  reclaiming:   { labelKey: "ResourcesPage.statusReclaiming",    color: "danger",  icon: "delete_sweep"   },
  stopped:      { labelKey: "ResourcesPage.statusStopped",       color: "muted",   icon: "stop_circle"    },
  paused:       { labelKey: "ResourcesPage.statusPaused",        color: "muted",   icon: "pause_circle"   },
  deleting:     { labelKey: "ResourcesPage.statusDeleting",      color: "danger",  icon: "hourglass_empty"},
  failed:       { labelKey: "ResourcesPage.statusFailed",        color: "danger",  icon: "error_outline"  },
  deleted:      { labelKey: "ResourcesPage.statusDeleted",       color: "danger",  icon: "delete_forever" },
  unknown:      { labelKey: "ResourcesPage.statusUnknown",       color: "muted",   icon: "help_outline"   },
};

const TYPE_MAP = {
  lxc:   { labelKey: "ResourcesPage.typeLxc", icon: "terminal" },
  qemu:  { labelKey: "ResourcesPage.typeQemu", icon: "computer" },
};

const API_BASE_URL = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");
const DESKTOP_CLIENT_DOWNLOAD_URL = `${API_BASE_URL}/api/v1/desktop-client/download`;

/* ── Helpers ── */
function formatDate(isoStr) {
  if (!isoStr) return null;
  return new Date(isoStr).toLocaleDateString("zh-TW", {
    year: "numeric", month: "2-digit", day: "2-digit",
  });
}

function formatDatetime(isoStr) {
  if (!isoStr) return null;
  return new Date(isoStr).toLocaleString("zh-TW", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

/* ── Primitive sub-components ── */
function StatusBadge({ status }) {
  const { t } = useTranslation("personal");
  const s = STATUS_MAP[status] ?? { label: status, color: "muted", icon: "help_outline" };
  return (
    <span className={`${styles.badge} ${styles[`badge_${s.color}`]}`}>
      {s.labelKey ? t(s.labelKey) : s.label}
    </span>
  );
}

/* ── Confirm Modal ── */
function ConfirmModal({ title, desc, confirmLabel, danger = false, loading = false, onConfirm, onClose }) {
  const { t } = useTranslation("personal");
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
            {t("ConfirmModal.cancel")}
          </button>
          <button
            type="button"
            className={danger ? styles.btnDanger : styles.btnPrimary}
            disabled={loading}
            onClick={onConfirm}
          >
            {loading ? t("ConfirmModal.processing") : (confirmLabel ?? t("ConfirmModal.confirm"))}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Creating placeholder row ── */

/** 依申請階段決定 placeholder 的狀態顯示（開通中 / 超時 / 失敗…） */
function getCreatingDisplay(req, t) {
  if (req.status === "pending") {
    return { label: t("CreatingRow.statusPendingReview"), color: "info", spin: true };
  }
  if (req.provisioning_status === "failed") {
    return { label: t("CreatingRow.statusProvisionFailed"), color: "danger", spin: false };
  }
  if (req.provisioning_status === "running") {
    return { label: t("CreatingRow.statusProvisioning"), color: "info", spin: true };
  }
  // approved 等待排程開機：start_at 已過但仍未開始建立 → 超時
  if (req.start_at && new Date(req.start_at).getTime() < Date.now()) {
    const overdueMin = Math.floor((Date.now() - new Date(req.start_at).getTime()) / 60_000);
    const overdueLabel = overdueMin >= 60
      ? t("CreatingRow.overdueHoursLabel", { count: Math.floor(overdueMin / 60) })
      : t("CreatingRow.overdueMinutesLabel", { count: overdueMin });
    return { label: t("CreatingRow.statusOverdue", { label: overdueLabel }), color: "danger", spin: false };
  }
  return { label: t("CreatingRow.statusScheduling"), color: "info", spin: true };
}

function formatMemory(memoryMb) {
  if (memoryMb == null) return null;
  return memoryMb >= 1024 ? `${memoryMb / 1024} GB` : `${memoryMb} MB`;
}

function CreatingRow({ request, onCancelled }) {
  const { t } = useTranslation("personal");
  const toast = useToast();
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const [cancelling, setCancelling]       = useState(false);

  const type    = TYPE_MAP[request.resource_type === "lxc" ? "lxc" : "qemu"];
  const display = getCreatingDisplay(request, t);
  // 開通流程一旦開始跑 Proxmox clone 就無法取消
  const canCancel = request.provisioning_status !== "running";

  async function handleCancel() {
    setCancelling(true);
    try {
      await cancelVmRequest(request.id);
      toast.success(t("CreatingRow.cancelRequestSuccess", { hostname: request.hostname }));
      setCancelConfirm(false);
      onCancelled();
    } catch (err) {
      toast.error(err?.message ?? t("CreatingRow.cancelRequestFailed"));
    } finally {
      setCancelling(false);
    }
  }

  const specs = [
    request.cores != null ? t("CreatingRow.coresLabel", { count: request.cores }) : null,
    formatMemory(request.memory),
  ].filter(Boolean).join(" / ");

  return <>
    <tr className={`${styles.tr} ${styles.pendingRow}`}>
      <td className={styles.td}>
        <div className={styles.nameCell}>
          <span className={styles.nameIcon}><MIcon name={type.icon} size={18} /></span>
          <div><strong>{request.hostname}</strong><small>{t(type.labelKey)} · {specs || t("CreatingRow.specsPending")}</small></div>
        </div>
      </td>
      <td className={styles.td}><div className={styles.envPrimary}>{t("CreatingRow.resourceRequestLabel")}</div><div className={styles.envSub}>{t("CreatingRow.creating")}</div></td>
      <td className={styles.td}>
        <span className={`${styles.badge} ${styles[`badge_${display.color}`]} ${styles.creatingBadge}`}>
          <span className={display.spin ? styles.spin : styles.badgeIcon}><MIcon name={display.spin ? "autorenew" : "error_outline"} size={12} /></span>{display.label}
        </span>
      </td>
      <td className={styles.td}><span className={styles.muted}>N/A</span></td>
      <td className={styles.td}>{formatDatetime(request.start_at) ?? formatDatetime(request.created_at)}</td>
      <td className={styles.td}>{request.assigned_node ?? request.desired_node ?? t("CreatingRow.notAssigned")}</td>
      <td className={styles.td}>
        <button type="button" className={styles.cancelBtn} disabled={!canCancel || cancelling} onClick={() => setCancelConfirm(true)}>
          <MIcon name="cancel" size={14} />{t("CreatingRow.cancelRequest")}
        </button>
      </td>
    </tr>
    {cancelConfirm && createPortal(
      <ConfirmModal
        title={t("CreatingRow.confirmCancelTitle")}
        desc={t("CreatingRow.confirmCancelDesc", { hostname: request.hostname })}
        confirmLabel={t("CreatingRow.confirmCancelLabel")}
        danger
        loading={cancelling}
        onConfirm={handleCancel}
        onClose={() => setCancelConfirm(false)}
      />,
      document.body,
    )}
  </>;
}

const LIVE_STATUSES = new Set(["running", "stopped", "paused"]);

function resourceRowKey(resource, index) {
  const parts = [
    resource.type || "resource",
    resource.node || "unknown-node",
    resource.vmid ?? resource.request_id ?? resource.name ?? "unknown",
  ];
  return `${parts.join(":")}:${index}`;
}

/* ── Resource row ── */
function ResourceRow({ resource, onUpdated, onDeleted }) {
  const { t } = useTranslation("personal");
  const navigate = useNavigate();
  const { user } = useAuth();
  /* VMID 是系統內部編號，僅管理員／老師看得到 */
  const showVmid = user?.is_superuser || user?.role === "admin" || user?.role === "teacher";
  const [actionLoading, setActionLoading] = useState(null);
  const [deleteConfirm, setDeleteConfirm]  = useState(false);
  const [deleting, setDeleting]            = useState(false);
  const [menuOpen, setMenuOpen]            = useState(false);
  const [menuClosing, setMenuClosing]      = useState(false);
  const [consoleOpen, setConsoleOpen]      = useState(false);
  const menuBtnRef = useRef(null);

  function closeMenu() {
    setMenuClosing(true);
    setTimeout(() => { setMenuOpen(false); setMenuClosing(false); }, 130);
  }

  const type    = TYPE_MAP[resource.type] ?? { label: resource.type, icon: "computer" };
  const isLxc   = resource.type === "lxc";
  const canControl = resource.can_control !== false && resource.vmid != null && resource.vmid > 0;
  const isLive  = canControl && LIVE_STATUSES.has(resource.status);

  async function handleControl(action) {
    setActionLoading(action);
    try {
      await ResourcesService[action](resource.vmid);
      onUpdated({ ...resource, status: action === "start" ? "running" : "stopped" });
    } finally {
      setActionLoading(null);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      await ResourcesService.delete(resource.vmid);
      onDeleted(resource.vmid);
    } finally {
      setDeleting(false);
      setDeleteConfirm(false);
    }
  }

  return <>
    <tr className={styles.tr} data-guide="resource-card">
      <td className={styles.td}>
        <div className={styles.nameCell}>
          <span className={styles.nameIcon}><MIcon name={type.icon} size={18} /></span>
          <div>
            {resource.vmid > 0
              ? <button type="button" className={styles.nameLink} onClick={() => navigate(`/my-resources/${resource.vmid}`)}>{resource.name}</button>
              : <strong>{resource.name}</strong>}
            <small>{t(type.labelKey)}{showVmid && resource.vmid > 0 ? t("ResourceRow.vmidSuffix", { vmid: resource.vmid }) : ""}</small>
          </div>
        </div>
      </td>
      <td className={styles.td}><div className={styles.envPrimary}>{resource.environment_type || "Custom"}</div><div className={styles.envSub}>{resource.os_info || "—"}</div></td>
      <td className={styles.td}><StatusBadge status={resource.status} /></td>
      <td className={styles.td}><span className={styles.mono}>{resource.ip_address ?? "N/A"}</span></td>
      <td className={styles.td}>{resource.expiry_date ? formatDate(resource.expiry_date) : <span className={styles.cardPeriodUnlimited}>{t("ResourceRow.unlimited")}</span>}</td>
      <td className={styles.td}>{resource.node ?? "—"}</td>
      <td className={styles.td}>
        {isLive ? <div className={styles.rowActions}>
          <button type="button" className={styles.terminalBtn} disabled={resource.status !== "running"} onClick={() => setConsoleOpen(true)} data-guide="resource-console">
            <MIcon name={isLxc ? "terminal" : "desktop_windows"} size={14} />{isLxc ? t("ResourceRow.terminal") : t("ResourceRow.console")}
          </button>
          {actionLoading && <MIcon name="hourglass_empty" size={16} />}
          <div className={styles.menuWrap}>
            {menuOpen && <PowerMenu resource={resource} actionLoading={actionLoading} onControl={handleControl} onDeleteClick={() => { closeMenu(); setDeleteConfirm(true); }} onClose={closeMenu} anchorRef={menuBtnRef} closing={menuClosing} />}
            <button ref={menuBtnRef} type="button" className={`${styles.menuBtn} ${menuOpen ? styles.menuBtnActive : ""}`} onClick={() => menuOpen ? closeMenu() : setMenuOpen(true)} title={t("ResourceRow.moreActions")}><MIcon name="more_vert" size={18} /></button>
          </div>
        </div> : <span className={styles.deletedNote}>{STATUS_MAP[resource.status]?.labelKey ? t(STATUS_MAP[resource.status].labelKey) : resource.status}</span>}
      </td>
    </tr>
    {deleteConfirm && createPortal(<ConfirmModal title={t("ResourceRow.confirmDeleteTitle")} desc={showVmid ? t("ResourceRow.confirmDeleteDescWithVmid", { name: resource.name, vmid: resource.vmid }) : t("ResourceRow.confirmDeleteDescNoVmid", { name: resource.name })} confirmLabel={t("ResourceRow.confirmDeleteLabel")} danger loading={deleting} onConfirm={handleDelete} onClose={() => setDeleteConfirm(false)} />, document.body)}
    {consoleOpen && isLxc && createPortal(<TerminalDialog resource={resource} onClose={() => setConsoleOpen(false)} />, document.body)}
    {consoleOpen && !isLxc && createPortal(<VncDialog resource={resource} onClose={() => setConsoleOpen(false)} />, document.body)}
  </>;
}

function EnvironmentMachineRow({ machine, groupStatus, onUpdated }) {
  const { t } = useTranslation("personal");
  const toast = useToast();
  const type = TYPE_MAP[machine.type] ?? { label: machine.type, icon: "computer" };
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const resource = machine.resource;
  const isLxc = machine.type === "lxc";
  const environmentReady = ["running", "active"].includes(groupStatus);
  const canControl = Boolean(
    environmentReady && resource?.vmid && resource.can_control !== false,
  );
  const canOpen = canControl && resource.status === "running";
  const controlAction = resource?.status === "running" ? "shutdown" : "start";

  async function handleControl() {
    if (!canControl || actionLoading) return;
    setActionLoading(true);
    try {
      await ResourcesService[controlAction](resource.vmid);
      const status = controlAction === "start" ? "running" : "stopped";
      onUpdated({ ...resource, status });
      toast.success(controlAction === "start" ? t("EnvironmentMachineRow.startCommandSent") : t("EnvironmentMachineRow.shutdownCommandSent"));
    } catch (error) {
      toast.error(error?.message ?? t("EnvironmentMachineRow.controlFailed"));
    } finally {
      setActionLoading(false);
    }
  }

  return <>
    <tr className={`${styles.tr} ${styles.environmentMachineRow}`}>
    <td className={styles.td}><div className={`${styles.nameCell} ${styles.environmentMachineName}`}><span className={styles.machineBranch}>└</span><div><strong>{machine.name}</strong><small>{machine.role} · {t(type.labelKey ?? type.label)}</small></div></div></td>
    <td className={styles.td}><div className={styles.envPrimary}>{machine.os}</div><div className={styles.envSub}>{machine.resource ? t("EnvironmentMachineRow.resourceConnected") : t("EnvironmentMachineRow.creating")}</div></td>
    <td className={styles.td}><StatusBadge status={machine.status} /></td>
    <td className={styles.td}><span className={styles.mono}>{machine.ip}</span></td>
    <td className={styles.td}><span className={styles.muted}>{t("EnvironmentMachineRow.managedByEnvironment")}</span></td>
    <td className={styles.td}>{machine.node}</td>
    <td className={styles.td}><div className={styles.rowActions}><button type="button" className={styles.terminalBtn} disabled={!canOpen} title={canOpen ? (isLxc ? t("EnvironmentMachineRow.terminal") : t("EnvironmentMachineRow.console")) : t("EnvironmentMachineRow.notReadyTitle")} onClick={() => setConsoleOpen(true)}><MIcon name={isLxc ? "terminal" : "desktop_windows"} size={14} />{isLxc ? t("EnvironmentMachineRow.terminal") : t("EnvironmentMachineRow.console")}</button><button type="button" className={styles.terminalBtn} disabled={!canControl || actionLoading || !["running", "stopped"].includes(resource?.status)} onClick={handleControl}><MIcon name={actionLoading ? "hourglass_empty" : controlAction === "start" ? "play_arrow" : "power_settings_new"} size={14} />{controlAction === "start" ? t("EnvironmentMachineRow.start") : t("EnvironmentMachineRow.shutdown")}</button></div></td>
    </tr>
    {consoleOpen && isLxc && createPortal(<TerminalDialog resource={resource} onClose={() => setConsoleOpen(false)} />, document.body)}
    {consoleOpen && !isLxc && createPortal(<VncDialog resource={resource} onClose={() => setConsoleOpen(false)} />, document.body)}
  </>;
}

function EnvironmentGroupRows({ group, onUpdated, onEnded }) {
  const { t } = useTranslation("personal");
  const [expanded, setExpanded] = useState(true);
  const [ending, setEnding] = useState(false);
  const [endConfirm, setEndConfirm] = useState(false);
  const toast = useToast();
  const canEnd = group.kind === "quick_practice" && !["reclaiming", "reclaimed"].includes(group.status);

  async function endPractice() {
    setEnding(true);
    try {
      await QuickPracticeService.endSession(group.id);
      toast.success(t("EnvironmentGroupRows.endPracticeSuccess"));
      setEndConfirm(false);
      onEnded?.();
    } catch (error) {
      toast.error(error?.message ?? t("EnvironmentGroupRows.endPracticeFailed"));
    } finally {
      setEnding(false);
    }
  }

  return <>
    <tr
      className={`${styles.tr} ${styles.environmentGroupRow}`}
      onClick={(event) => {
        /* 整列都可以開合，但列內的按鈕（結束練習、名稱區的 toggle）各自處理自己的點擊 */
        if (event.target.closest("button")) return;
        setExpanded((value) => !value);
      }}
    >
      <td className={styles.td}><button type="button" className={styles.environmentToggle} aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}><MIcon name={expanded ? "expand_more" : "chevron_right"} size={20} /><span><strong>{group.kindLabel}｜{group.title}</strong><small>{t("EnvironmentGroupRows.machineCount", { count: group.machines.length })}</small></span></button></td>
      <td className={styles.td}><div className={styles.envPrimary}>{group.kind === "course" ? t("EnvironmentGroupRows.courseEnv") : t("EnvironmentGroupRows.quickPracticeEnv")}</div><div className={styles.envSub}>{t("EnvironmentGroupRows.groupOverview")}</div></td>
      <td className={styles.td}><StatusBadge status={group.status} /></td>
      <td className={styles.td}><span className={styles.muted}>{t("EnvironmentGroupRows.expandToView")}</span></td>
      <td className={styles.td}><strong className={styles.environmentTiming}>{group.timingLabel}</strong></td>
      <td className={styles.td}>{group.nodeLabel}</td>
      <td className={styles.td}><div className={styles.groupActions}>
        {canEnd
          ? <button type="button" className={styles.terminalBtn} disabled={ending} onClick={() => setEndConfirm(true)}><MIcon name="stop_circle" size={14} />{ending ? t("EnvironmentGroupRows.ending") : t("EnvironmentGroupRows.endPractice")}</button>
          : <span className={styles.muted}>{t("EnvironmentGroupRows.expandToView")}</span>}
      </div></td>
    </tr>
    {expanded && group.machines.map((machine) => <EnvironmentMachineRow key={machine.id} machine={machine} groupStatus={group.status} onUpdated={onUpdated} />)}
    {endConfirm && createPortal(<ConfirmModal title={t("EnvironmentGroupRows.confirmEndTitle")} desc={t("EnvironmentGroupRows.confirmEndDesc")} confirmLabel={t("EnvironmentGroupRows.endPractice")} danger loading={ending} onConfirm={endPractice} onClose={() => setEndConfirm(false)} />, document.body)}
  </>;
}

/* ── Skeleton ── */
function SkeletonRow() {
  return <tr className={styles.tr} aria-hidden>{[0, 1, 2, 3, 4, 5, 6].map((column) => <td key={column} className={styles.td}><div className={`${styles.skeleton} ${styles.skRow}`} style={{ width: column === 0 ? "75%" : "60%", height: 14 }} /></td>)}</tr>;
}

/* ── Empty / Error states ── */
function EmptyState() {
  const { t } = useTranslation("personal");
  return <SharedEmptyState icon="dns" title={t("ResourcesPage.emptyTitle")} />;
}

function ErrorState({ onRetry }) {
  const { t } = useTranslation("personal");
  return (
    <EmptyState
      icon="error_outline"
      title={t("ResourcesPage.errorTitle")}
      action={
        <button type="button" className={styles.btnSecondary} onClick={onRetry}>
          <MIcon name="refresh" size={16} />
          {t("ResourcesPage.retry")}
        </button>
      }
    />
  );
}

/* ── Page ── */
export default function ResourcesPage() {
  const { t } = useTranslation("personal");
  const navigate = useNavigate();
  const [resources, setResources] = useState([]);
  const [quickSessions, setQuickSessions] = useState([]);
  const [pending, setPending]     = useState([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState(false);
  const pendingSigRef = useRef(null);

  /** silent = true 時不觸發 skeleton / error state，供背景同步使用 */
  const fetchResources = useCallback(async (silent = false, signal) => {
    if (!silent) {
      setLoading(true);
      setError(false);
    }
    try {
      const [data, sessions] = await Promise.all([
        ResourcesService.list({ signal }),
        QuickPracticeService.listMySessions({ signal }).catch(() => []),
      ]);
      setResources(data ?? []);
      setQuickSessions(sessions ?? []);
    } catch (err) {
      if (!silent && !err?.cancelled) setError(true);
    } finally {
      if (!silent && !signal?.aborted) setLoading(false);
    }
  }, []);

  /** 輪詢建立中的申請；階段變化（開通完成／失敗／取消）時靜默刷新資源列表 */
  const refreshPending = useCallback(async () => {
    try {
      const items = await fetchPendingResources();
      setPending(items);
      const sig = pendingSignature(items);
      if (pendingSigRef.current !== null && sig !== pendingSigRef.current) {
        fetchResources(true);
      }
      pendingSigRef.current = sig;
    } catch {
      // 輪詢失敗靜默忽略，下一輪再試
    }
  }, [fetchResources]);

  useEffect(() => {
    const controller = new AbortController();
    fetchResources(false, controller.signal);
    return () => controller.abort();
  }, [fetchResources]);

  useEffect(() => {
    refreshPending();
    const timer = setInterval(refreshPending, PENDING_POLL_INTERVAL);
    return () => clearInterval(timer);
  }, [refreshPending]);

  useAutoRefresh(() => fetchResources(true));

  function handleUpdated(updated) {
    setResources((prev) => prev.map((r) => r.vmid === updated.vmid ? updated : r));
  }

  function handleDeleted(vmid) {
    setResources((prev) => prev.filter((r) => r.vmid !== vmid));
  }

  // 建立中申請會同時出現在 pending 與資源 API；先移除 placeholder，避免重複列。
  const pendingRequestIds = new Set(pending.map((request) => String(request.id)));
  const resourcesForDisplay = resources.filter((resource) => !(
    resource.is_placeholder
    && resource.request_id != null
    && pendingRequestIds.has(String(resource.request_id))
  ));
  const environmentGroups = buildEnvironmentGroups(resourcesForDisplay, quickSessions);
  const grouped = groupedResourceKeys(environmentGroups);
  const visibleResources = resourcesForDisplay.filter((resource) => (
    !grouped.vmids.has(resource.vmid)
    && !grouped.requestIds.has(String(resource.request_id))
  ));
  const visiblePending = pending.filter((request) => !grouped.requestIds.has(String(request.id)));

  return (
    <div className={styles.page}>
      <PageHeader title={t("ResourcesPage.title")} subtitle={t("ResourcesPage.subtitle")}>
        <div className={styles.pageActions}>
          <a
            className={styles.btnSecondary}
            href={DESKTOP_CLIENT_DOWNLOAD_URL}
          >
            <MIcon name="download" size={16} />
            {t("ResourcesPage.downloadDesktopClient")}
          </a>
          <button
            type="button"
            className={styles.btnPrimary}
            onClick={() => navigate("/my-requests", { state: { create: true } })}
          >
            <MIcon name="add" size={16} />
            {t("ResourcesPage.requestResource")}
          </button>
        </div>
      </PageHeader>

      {/* 我的配額用量（模組 E） */}
      <QuotaUsageBar />

      <div className={styles.content}>
        {error ? (
          <ErrorState onRetry={() => fetchResources()} />
        ) : !loading && visibleResources.length === 0 && visiblePending.length === 0 && environmentGroups.length === 0 ? (
          <EmptyState />
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <colgroup>
                <col />
                <col className={styles.colEnv} />
                <col className={styles.colStatus} />
                <col className={styles.colIp} />
                <col className={styles.colExpiry} />
                <col className={styles.colNode} />
                <col className={styles.colActions} />
              </colgroup>
              <thead>
                <tr><th className={styles.th}>{t("ResourcesPage.colName")}</th><th className={styles.th}>{t("ResourcesPage.colEnvironment")}</th><th className={styles.th}>{t("ResourcesPage.colStatus")}</th><th className={styles.th}>{t("ResourcesPage.colIp")}</th><th className={styles.th}>{t("ResourcesPage.colExpiry")}</th><th className={styles.th}>{t("ResourcesPage.colNode")}</th><th className={styles.th}>{t("ResourcesPage.colActions")}</th></tr>
              </thead>
              <tbody>
                {loading ? [0, 1, 2].map((i) => <SkeletonRow key={i} />) : <>
                  {environmentGroups.map((group) => <EnvironmentGroupRows key={group.id} group={group} onUpdated={handleUpdated} onEnded={() => fetchResources(true)} />)}
                  {visiblePending.map((req) => <CreatingRow key={`creating:${req.id}`} request={req} onCancelled={refreshPending} />)}
                  {visibleResources.map((r, index) => <ResourceRow key={resourceRowKey(r, index)} resource={r} onUpdated={handleUpdated} onDeleted={handleDeleted} />)}
                </>}
              </tbody>
            </table>
          </div>
        )}
      </div>

    </div>
  );
}
