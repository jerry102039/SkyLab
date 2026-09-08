import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import MIcon from "../MIcon";
import useAutoRefresh from "../../hooks/useAutoRefresh";
import { MonitoringService } from "../../services/monitoring";
import styles from "./PveOperationsQuickLook.module.scss";

const GUEST_SCOPES = new Set(["qemu", "lxc"]);
const QUICK_LOOK_REFRESH_INTERVAL_MS = 30_000;

export function quickLookIssuePath(issue) {
  if (issue?.vmid != null && GUEST_SCOPES.has(issue.scope)) {
    return `/resource-mgmt/${issue.vmid}`;
  }
  return "/monitoring";
}

export function formatQuickLookTime(value, locale) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function statusIcon(status) {
  if (status === "critical") return "error";
  if (status === "warning") return "warning";
  if (status === "unknown") return "help_outline";
  return "check_circle";
}

function statusKey(status) {
  if (status === "critical") return "critical";
  if (status === "warning") return "warning";
  if (status === "healthy") return "healthy";
  return "unknown";
}

function issueDescription(issue, t) {
  if (issue.kind === "node_offline") {
    return t("AdminDashboardPage.pveIssueNodeOffline");
  }
  const signals = (issue.signals ?? [])
    .map((signal) => `${t(`AdminDashboardPage.pveMetric${signal.metric}`)} ${Number(signal.value).toFixed(0)}%`)
    .join(" · ");
  return signals || t("AdminDashboardPage.pveIssueOverloaded");
}

export default function PveOperationsQuickLook() {
  const { t, i18n } = useTranslation("personal");
  const navigate = useNavigate();
  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);
  const inFlightRef = useRef(false);
  const lastRefreshAtRef = useRef(0);

  const load = useCallback(async ({ silent = false, signal } = {}) => {
    const now = Date.now();
    if (
      silent &&
      now - lastRefreshAtRef.current < QUICK_LOOK_REFRESH_INTERVAL_MS
    ) {
      return;
    }
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    lastRefreshAtRef.current = now;
    if (!silent) setRefreshing(true);
    try {
      const next = await MonitoringService.getOverview({ signal });
      if (!signal?.aborted) {
        setOverview(next);
        setError(false);
      }
    } catch (err) {
      if (!err?.cancelled && !signal?.aborted) setError(true);
    } finally {
      inFlightRef.current = false;
      if (!signal?.aborted) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load({ signal: controller.signal });
    return () => controller.abort();
  }, [load]);

  useAutoRefresh(() => load({ silent: true }), QUICK_LOOK_REFRESH_INTERVAL_MS);

  const status = statusKey(overview?.overall_status);
  const dataStatus = overview?.data_status ?? "fresh";
  const issues = overview?.issues ?? [];
  const summaries = overview ? [
    {
      key: "nodes",
      icon: "dns",
      label: t("AdminDashboardPage.pveNodes"),
      value: `${overview.nodes_online}/${overview.nodes_total}`,
      saturated: `${overview.nodes_saturated ?? 0}/${overview.nodes_total}`,
      path: "/monitoring",
    },
    {
      key: "vms",
      icon: "desktop_windows",
      label: "VM",
      value: `${overview.vms_running}/${overview.vms_running + overview.vms_stopped}`,
      saturated: `${overview.vms_saturated ?? 0}/${overview.vms_running + overview.vms_stopped}`,
      path: "/resource-mgmt",
    },
    {
      key: "lxc",
      icon: "view_agenda",
      label: "LXC",
      value: `${overview.lxc_running}/${overview.lxc_running + overview.lxc_stopped}`,
      saturated: `${overview.lxc_saturated ?? 0}/${overview.lxc_running + overview.lxc_stopped}`,
      path: "/resource-mgmt",
    },
  ] : [];

  return (
    <section className={styles.quickLook} aria-labelledby="pve-quick-look-title">
      <header className={styles.header}>
        <div>
          <h3 id="pve-quick-look-title">{t("AdminDashboardPage.pveQuickLookTitle")}</h3>
          <span className={styles.updatedAt}>
            {overview
              ? t("AdminDashboardPage.pveUpdatedAt", {
                time: formatQuickLookTime(overview.collected_at, i18n.language),
              })
              : t("AdminDashboardPage.pveNotChecked")}
          </span>
        </div>
        <button
          type="button"
          className={styles.refreshButton}
          onClick={() => load()}
          disabled={loading || refreshing}
        >
          <MIcon name="refresh" size={16} className={refreshing ? styles.spin : ""} />
          <span>{t("AdminDashboardPage.pveRefresh")}</span>
        </button>
      </header>

      {loading && !overview ? (
        <div className={styles.loading} role="status">
          <MIcon name="sync" size={19} className={styles.spin} />
          <span>{t("AdminDashboardPage.pveChecking")}</span>
        </div>
      ) : error && !overview ? (
        <div className={styles.errorState} role="alert">
          <MIcon name="cloud_off" size={20} />
          <span>{t("AdminDashboardPage.pveLoadError")}</span>
          <button type="button" onClick={() => load()} disabled={refreshing}>
            {t("AdminDashboardPage.pveRetry")}
          </button>
        </div>
      ) : (
        <>
          <div className={`${styles.statusBanner} ${styles[`status_${status}`]}`} aria-live="polite">
            <MIcon name={statusIcon(status)} size={19} />
            <span className={styles.statusTitle}>
              <strong>{t(`AdminDashboardPage.pveStatus${status[0].toUpperCase()}${status.slice(1)}`)}</strong>
            </span>
            <span className={styles.statusSummary}>
              {status === "unknown"
                ? t("AdminDashboardPage.pveDataUnavailable")
                : dataStatus === "stale"
                ? t("AdminDashboardPage.pveDataStale")
                : dataStatus === "partial"
                ? t("AdminDashboardPage.pveDataPartial")
                : issues.length
                ? t("AdminDashboardPage.pveAttentionCount", { count: issues.length })
                : t("AdminDashboardPage.pveNoIssues")}
            </span>
          </div>

          {status !== "unknown" && (
            <h4 className={styles.operatingHeading}>
              <MIcon name="play_circle" size={15} />
              {t("AdminDashboardPage.pveOperatingNow")}
            </h4>
          )}

          <div className={styles.summaryList}>
            {summaries.map((summary) => (
              <button
                type="button"
                className={styles.summaryRow}
                key={summary.key}
                onClick={() => navigate(summary.path)}
              >
                <span className={styles.summaryLabel}>
                  <MIcon name={summary.icon} size={16} />
                  <span>{summary.label}</span>
                </span>
                <strong>{summary.value}</strong>
                <span className={styles.saturated}>
                  {t("AdminDashboardPage.pveSaturated", { count: summary.saturated })}
                </span>
                <MIcon name="arrow_forward" size={16} />
              </button>
            ))}
          </div>

          {issues.length > 0 ? (
            <div className={styles.issueList} aria-live="polite">
              <div className={styles.issueHeading}>
                <span>{t("AdminDashboardPage.pveIssueHeading")}</span>
                {issues.length > 3 && (
                  <button type="button" onClick={() => navigate("/monitoring")}>
                    {t("AdminDashboardPage.pveViewAll", { count: issues.length })}
                  </button>
                )}
              </div>
              {issues.slice(0, 3).map((issue) => (
                <button
                  type="button"
                  className={`${styles.issueRow} ${styles[`issue_${issue.severity}`]}`}
                  key={`${issue.kind}-${issue.scope}-${issue.vmid ?? issue.target}`}
                  onClick={() => navigate(quickLookIssuePath(issue))}
                >
                  <MIcon name={issue.severity === "critical" ? "error" : "warning"} size={17} />
                  <span>
                    <strong>{issue.target}</strong>
                    <small>{issueDescription(issue, t)}</small>
                  </span>
                  <MIcon name="arrow_forward" size={16} />
                </button>
              ))}
            </div>
          ) : (
            <p className={styles.clearMessage}>{t("AdminDashboardPage.pveClearMessage")}</p>
          )}

          {(error || dataStatus === "stale" || dataStatus === "partial") && overview && (
            <p className={styles.staleMessage} role="status">
              <MIcon name="sync_problem" size={15} />
              {dataStatus === "partial"
                ? t("AdminDashboardPage.pvePartialMessage")
                : t("AdminDashboardPage.pveStaleMessage")}
            </p>
          )}
        </>
      )}
    </section>
  );
}
