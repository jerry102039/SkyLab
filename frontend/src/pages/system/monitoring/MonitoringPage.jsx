import { Fragment, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import styles from "./MonitoringPage.module.scss";
import MIcon from "../../../components/MIcon";
import LoadingState from "../../../components/LoadingState/LoadingState";
import EmptyState from "../../../components/EmptyState/EmptyState";
import RrdChart from "../../../components/RrdChart/RrdChart";
import MiningIncidentsPanel from "./MiningIncidentsPanel";
import { MonitoringService } from "../../../services/monitoring";
import { useToast } from "../../../hooks/useToast";
import PageHeader from "../../../components/PageHeader/PageHeader";

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const tb = bytes / 1024 ** 4;
  if (tb >= 1) return `${tb.toFixed(2)} TB`;
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / 1024 ** 2;
  return `${mb.toFixed(0)} MB`;
}

function formatUptime(seconds, t) {
  if (!seconds) return "—";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  if (days > 0) return t("MonitoringPage.uptimeDaysHours", { days, hours });
  const minutes = Math.floor((seconds % 3600) / 60);
  return t("MonitoringPage.uptimeHoursMinutes", { hours, minutes });
}

/** 將 PVE 節點 RRD 原始點位轉為圖表資料（CPU%、記憶體%） */
function mapNodeRrd(points) {
  return (points ?? [])
    .filter((p) => typeof p.time === "number")
    .map((p) => ({
      time: new Date(p.time * 1000).toLocaleTimeString("zh-TW", {
        hour: "2-digit",
        minute: "2-digit",
      }),
      cpu: typeof p.cpu === "number" ? Number((p.cpu * 100).toFixed(2)) : null,
      memory:
        typeof p.memused === "number" && typeof p.memtotal === "number" && p.memtotal > 0
          ? Number(((p.memused / p.memtotal) * 100).toFixed(2))
          : null,
    }));
}

function UsageBar({ pct }) {
  return (
    <div className={styles.usageBar}>
      <div
        className={`${styles.usageFill} ${pct >= 90 ? styles.usageFill_danger : ""}`}
        style={{ width: `${Math.min(pct, 100)}%` }}
      />
    </div>
  );
}

function OverviewCard({ title, pct, detail }) {
  return (
    <div className={styles.overviewCard}>
      <div className={styles.overviewTop}>
        <div className={styles.overviewInfo}>
          <span className={styles.overviewLabel}>{title}</span>
          <span className={styles.overviewDetail}>{detail}</span>
        </div>
        <span className={styles.overviewValue}>
          {pct.toFixed(1)}
          <span className={styles.overviewUnit}>%</span>
        </span>
      </div>
      <UsageBar pct={pct} />
    </div>
  );
}

/** 節點展開後的趨勢圖（每 60 秒輪詢） */
function NodeTrends({ node, timeframe }) {
  const { t } = useTranslation("system");
  const RRD_SERIES = [
    { key: "cpu",    label: "CPU %",    color: "--color-info" },
    { key: "memory", label: t("MonitoringPage.memoryPercentLabel"), color: "--color-success" },
  ];
  const [data, setData] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const rrd = await MonitoringService.getNodeRrd(node, timeframe);
        if (!cancelled) setData(mapNodeRrd(rrd));
      } catch {
        if (!cancelled) setData([]);
      }
    };
    load();
    const timer = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [node, timeframe]);

  if (data === null) {
    return <LoadingState text={t("MonitoringPage.loadingTrends")} />;
  }

  return (
    <div className={styles.trendGrid}>
      {RRD_SERIES.map((s) => (
        <RrdChart
          key={s.key}
          title={s.label}
          data={data}
          series={[s]}
          unit="%"
          height={200}
        />
      ))}
    </div>
  );
}

function AlertsCard() {
  const { t } = useTranslation("system");
  const toast = useToast();
  const METRIC_LABELS = { cpu: "CPU", memory: t("MonitoringPage.memoryLabel"), disk: t("MonitoringPage.diskLabel") };
  const SCOPE_LABELS  = { cluster: t("MonitoringPage.scopeCluster"), node: t("MonitoringPage.scopeNode"), vm: "VM" };
  const [alerts, setAlerts] = useState(null);
  const [ackBusy, setAckBusy] = useState(null);

  const load = useCallback(async () => {
    try {
      setAlerts(await MonitoringService.listAlerts({ active: true }));
    } catch {
      setAlerts((prev) => prev ?? []);
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [load]);

  const handleAck = async (alertId) => {
    setAckBusy(alertId);
    try {
      await MonitoringService.ackAlert(alertId);
      await load();
    } catch (e) {
      toast.error(e?.message ?? t("MonitoringPage.toastAckFailed"));
    } finally {
      setAckBusy(null);
    }
  };

  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <div>
          <h2 className={styles.cardTitle}>
            <MIcon name="notifications" size={18} />
            {t("MonitoringPage.activeAlertsTitle")}
          </h2>
          <p className={styles.cardDesc}>{t("MonitoringPage.activeAlertsDesc")}</p>
        </div>
        {alerts && alerts.length > 0 && (
          <span className={styles.alertCount}>{alerts.length}</span>
        )}
      </div>

      {alerts === null ? (
        <LoadingState />
      ) : alerts.length === 0 ? (
        <EmptyState icon="notifications_off" title={t("MonitoringPage.emptyNoAlerts")} />
      ) : (
        <div className={styles.alertList}>
          {alerts.map((alert) => (
            <div key={alert.id} className={styles.alertRow}>
              <div className={styles.alertMain}>
                <MIcon name="warning" size={16} />
                <div>
                  <div className={styles.alertHead}>
                    <span className={styles.alertScope}>
                      {SCOPE_LABELS[alert.scope] ?? alert.scope}
                    </span>
                    <span className={styles.alertTarget}>{alert.target}</span>
                    <span className={styles.alertMetric}>
                      {METRIC_LABELS[alert.metric] ?? alert.metric} {alert.value.toFixed(0)}%
                    </span>
                    <span className={styles.alertThreshold}>
                      {t("MonitoringPage.thresholdSuffix", { threshold: alert.threshold.toFixed(0) })}
                    </span>
                  </div>
                  <p className={styles.alertTime}>
                    {new Date(alert.created_at).toLocaleString("zh-TW")}
                    {alert.acknowledged_at && ` · ${t("MonitoringPage.acknowledged")}`}
                  </p>
                </div>
              </div>
              {!alert.acknowledged_at && (
                <button
                  type="button"
                  className={styles.btnSecondary}
                  disabled={ackBusy === alert.id}
                  onClick={() => handleAck(alert.id)}
                >
                  <MIcon name="check" size={14} />
                  {t("MonitoringPage.acknowledge")}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TopVmTable({ title, entries, metric }) {
  const { t } = useTranslation("system");
  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>{title}</h2>
      </div>
      {entries.length === 0 ? (
        <EmptyState icon="dns" title={t("MonitoringPage.emptyNoRunningResources")} />
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.th}>VMID</th>
              <th className={styles.th}>{t("MonitoringPage.colName")}</th>
              <th className={styles.th}>{t("MonitoringPage.colNode")}</th>
              <th className={styles.th}>{t("MonitoringPage.colType")}</th>
              <th className={`${styles.th} ${styles.thRight}`}>
                {metric === "cpu" ? "CPU" : t("MonitoringPage.memoryLabel")}
              </th>
            </tr>
          </thead>
          <tbody>
            {entries.map((vm) => (
              <tr key={vm.vmid} className={styles.tr}>
                <td className={`${styles.td} ${styles.monoCell}`}>{vm.vmid}</td>
                <td className={styles.td}>{vm.name}</td>
                <td className={`${styles.td} ${styles.mutedCell}`}>{vm.node}</td>
                <td className={styles.td}>
                  <span className={styles.typeBadge}>
                    {vm.type === "qemu" ? "VM" : "LXC"}
                  </span>
                </td>
                <td className={`${styles.td} ${styles.numericCell}`}>
                  {metric === "cpu" ? `${(vm.cpu * 100).toFixed(1)}%` : formatBytes(vm.mem)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function MonitoringPage() {
  const { t } = useTranslation("system");
  const TIMEFRAMES = [
    { value: "hour", label: t("MonitoringPage.timeframeHour") },
    { value: "day",  label: t("MonitoringPage.timeframeDay") },
    { value: "week", label: t("MonitoringPage.timeframeWeek") },
  ];
  const [timeframe, setTimeframe] = useState("hour");
  const [expandedNode, setExpandedNode] = useState(null);
  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async (signal) => {
    try {
      setOverview(await MonitoringService.getOverview({ signal }));
      setError(false);
    } catch (err) {
      if (!err?.cancelled) setError(true);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    const timer = setInterval(() => load(), 30_000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [load]);

  if (loading) {
    return <LoadingState fullPage text={t("MonitoringPage.loadingOverview")} />;
  }

  if (error || !overview) {
    return (
      <div className={styles.page}>
        <div className={`${styles.card} ${styles.cardEmpty}`}>
          <MIcon name="warning" size={24} />
          <p>{t("MonitoringPage.errorFetchOverview")}</p>
        </div>
      </div>
    );
  }

  const cpuPct = overview.cpu_total > 0 ? (overview.cpu_used / overview.cpu_total) * 100 : 0;
  const memPct = overview.mem_total > 0 ? (overview.mem_used / overview.mem_total) * 100 : 0;
  const diskPct =
    overview.disk_total > 0 ? (overview.disk_used / overview.disk_total) * 100 : 0;

  return (
    <div className={styles.page}>
      <PageHeader title={t("MonitoringPage.pageTitle")} subtitle={t("MonitoringPage.pageSubtitle")}>
        <div className={styles.pageActions}>
          <div className={styles.segment}>
            {TIMEFRAMES.map((t) => (
              <button
                key={t.value}
                type="button"
                className={`${styles.segmentBtn} ${timeframe === t.value ? styles.segmentActive : ""}`}
                onClick={() => setTimeframe(t.value)}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </PageHeader>

      {/* 叢集用量卡片 */}
      <div className={styles.statRow}>
        <OverviewCard
          title={t("MonitoringPage.cpuUsage")}
          pct={cpuPct}
          detail={t("MonitoringPage.coresDetail", { used: overview.cpu_used.toFixed(1), total: overview.cpu_total })}
        />
        <OverviewCard
          title={t("MonitoringPage.memoryUsage")}
          pct={memPct}
          detail={`${formatBytes(overview.mem_used)} / ${formatBytes(overview.mem_total)}`}
        />
        <OverviewCard
          title={t("MonitoringPage.diskUsage")}
          pct={diskPct}
          detail={`${formatBytes(overview.disk_used)} / ${formatBytes(overview.disk_total)}`}
        />
        <div className={styles.overviewCard}>
          <div className={styles.overviewTop}>
            <div className={styles.overviewInfo}>
              <span className={styles.overviewLabel}>{t("MonitoringPage.runningStatus")}</span>
              <span className={styles.statusLine}>
                {t("MonitoringPage.nodesOnline")}{" "}
                <strong>
                  {overview.nodes_online}/{overview.nodes_total}
                </strong>
              </span>
              <span className={styles.statusLine}>
                {t("MonitoringPage.vmRunning")} <strong>{overview.vms_running}</strong>
                <span className={styles.mutedText}>
                  /{overview.vms_running + overview.vms_stopped}
                </span>
              </span>
              <span className={styles.statusLine}>
                {t("MonitoringPage.lxcRunning")} <strong>{overview.lxc_running}</strong>
                <span className={styles.mutedText}>
                  /{overview.lxc_running + overview.lxc_stopped}
                </span>
              </span>
            </div>
            <div className={styles.overviewIcon}>
              <MIcon name="monitor_heart" size={20} />
            </div>
          </div>
        </div>
      </div>

      {/* 活動警告 */}
      <AlertsCard />

      {/* 挖礦事件（模組 D，位置比照舊版監控頁） */}
      <MiningIncidentsPanel />

      {/* 節點用量 */}
      <div className={styles.card}>
        <div className={styles.cardHeader}>
          <div>
            <h2 className={styles.cardTitle}>{t("MonitoringPage.nodeUsageTitle")}</h2>
            <p className={styles.cardDesc}>{t("MonitoringPage.nodeUsageDesc")}</p>
          </div>
        </div>
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.th}>{t("MonitoringPage.colNode")}</th>
              <th className={styles.th}>{t("MonitoringPage.colStatus")}</th>
              <th className={`${styles.th} ${styles.thWide}`}>CPU</th>
              <th className={`${styles.th} ${styles.thWide}`}>{t("MonitoringPage.memoryLabel")}</th>
              <th className={`${styles.th} ${styles.thWide}`}>{t("MonitoringPage.diskLabel")}</th>
              <th className={`${styles.th} ${styles.thRight}`}>VM / LXC</th>
              <th className={styles.th}>{t("MonitoringPage.colUptime")}</th>
            </tr>
          </thead>
          <tbody>
            {overview.nodes.map((node) => {
              const online = node.status === "online";
              const nodeCpu = node.maxcpu > 0 ? node.cpu * 100 : 0;
              const nodeMem = node.maxmem > 0 ? (node.mem / node.maxmem) * 100 : 0;
              const nodeDisk = node.maxdisk > 0 ? (node.disk / node.maxdisk) * 100 : 0;
              const expanded = expandedNode === node.node;
              return (
                <Fragment key={node.node}>
                  <tr
                    className={`${styles.tr} ${styles.trClickable}`}
                    onClick={() => setExpandedNode(expanded ? null : node.node)}
                  >
                    <td className={styles.td}>
                      <span className={styles.nodeCell}>
                        <MIcon name={expanded ? "expand_more" : "chevron_right"} size={16} />
                        <MIcon name="dns" size={16} />
                        <strong>{node.node}</strong>
                        {node.connection_name && (
                          <span className={styles.typeBadge}>{node.connection_name}</span>
                        )}
                      </span>
                    </td>
                    <td className={styles.td}>
                      <span
                        className={`${styles.badge} ${online ? styles.badge_ok : styles.badge_err}`}
                      >
                        {online ? t("MonitoringPage.online") : node.status}
                      </span>
                    </td>
                    <td className={styles.td}>
                      <div className={styles.usageCell}>
                        <div className={styles.usageMeta}>
                          <span>{nodeCpu.toFixed(1)}%</span>
                          <span className={styles.mutedText}>{t("MonitoringPage.coresLabel", { count: node.maxcpu })}</span>
                        </div>
                        <UsageBar pct={nodeCpu} />
                      </div>
                    </td>
                    <td className={styles.td}>
                      <div className={styles.usageCell}>
                        <div className={styles.usageMeta}>
                          <span>{nodeMem.toFixed(1)}%</span>
                          <span className={styles.mutedText}>
                            {formatBytes(node.mem)} / {formatBytes(node.maxmem)}
                          </span>
                        </div>
                        <UsageBar pct={nodeMem} />
                      </div>
                    </td>
                    <td className={styles.td}>
                      <div className={styles.usageCell}>
                        <div className={styles.usageMeta}>
                          <span>{nodeDisk.toFixed(1)}%</span>
                          <span className={styles.mutedText}>
                            {formatBytes(node.disk)} / {formatBytes(node.maxdisk)}
                          </span>
                        </div>
                        <UsageBar pct={nodeDisk} />
                      </div>
                    </td>
                    <td className={`${styles.td} ${styles.numericCell}`}>
                      {node.vm_count}
                    </td>
                    <td className={`${styles.td} ${styles.mutedCell}`}>
                      {formatUptime(node.uptime, t)}
                    </td>
                  </tr>
                  {expanded && (
                    <tr className={styles.trExpand}>
                      <td colSpan={7} className={styles.tdExpand}>
                        <NodeTrends node={node.node} timeframe={timeframe} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Top VMs */}
      <div className={styles.topGrid}>
        <TopVmTable title={t("MonitoringPage.topCpuTitle")} entries={overview.top_cpu} metric="cpu" />
        <TopVmTable title={t("MonitoringPage.topMemTitle")} entries={overview.top_mem} metric="mem" />
      </div>
    </div>
  );
}
