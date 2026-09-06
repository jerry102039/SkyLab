import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import styles from "./AiMonitoringPage.module.scss";
import MIcon from "../../../components/MIcon";
import LoadingState from "../../../components/LoadingState/LoadingState";
import SharedEmptyState from "../../../components/EmptyState/EmptyState";
import { AiMonitoringService } from "../../../services/aiMonitoring";
import { useToast } from "../../../hooks/useToast";
import useAutoRefresh from "../../../hooks/useAutoRefresh";
import PageHeader from "../../../components/PageHeader/PageHeader";

function presetToRange(preset) {
  const end = new Date();
  const start = new Date();
  const days = preset === "7d" ? 7 : preset === "30d" ? 30 : 90;
  start.setDate(start.getDate() - days);
  return { startDate: start.toISOString(), endDate: end.toISOString() };
}

function fmtTime(iso) {
  return iso ? new Date(iso).toLocaleString("zh-TW") : "—";
}

function formatTokens(n) {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatDuration(ms) {
  if (ms == null) return "—";
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

function formatModelDisplay(modelName) {
  if (!modelName) return "—";
  const trimmed = modelName.trim();
  if (!trimmed) return "—";

  const match = trimmed.match(/models--([^/]+)--([^/]+)/);
  if (!match) return trimmed;

  return `${match[1]}/${match[2]}`;
}

function isOkStatus(status) {
  return (
    status === "success" ||
    status === 200 ||
    status === "200" ||
    status === "ok"
  );
}

function EmptyState({ icon, title }) {
  return <SharedEmptyState icon={icon} title={title} />;
}

function StatusBadge({ status }) {
  const { t } = useTranslation("ai");
  const ok = isOkStatus(status);
  return (
    <span className={`${styles.badge} ${ok ? styles.badge_ok : styles.badge_err}`}>
      <span className={styles.dot} />
      {ok ? t("AiMonitoringPage.statusSuccess") : t("AiMonitoringPage.statusFail")}
    </span>
  );
}

function UserCell({ email, fullName, fallback }) {
  return (
    <div className={styles.userCell}>
      <div className={styles.userName}>{fullName || fallback || "—"}</div>
      {email ? <div className={styles.userEmail}>{email}</div> : null}
    </div>
  );
}

function CallTypeCell({ callType, formatCallType }) {
  const label = formatCallType(callType);
  return (
    <div className={styles.callTypeCell}>
      <div className={styles.callTypeLabel}>{label}</div>
      {callType && label !== callType ? (
        <div className={styles.callTypeKey}>{callType}</div>
      ) : null}
    </div>
  );
}

export default function AiMonitoringPage() {
  const { t } = useTranslation("ai");
  const toast = useToast();
  const [preset, setPreset] = useState("7d");
  const [tab, setTab] = useState("proxy");
  const [query, setQuery] = useState("");
  const [statsData, setStatsData] = useState(null);
  const [proxyCalls, setProxyCalls] = useState([]);
  const [templateCalls, setTemplateCalls] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);

  const PRESETS = [
    { value: "7d",  label: t("AiMonitoringPage.preset7d") },
    { value: "30d", label: t("AiMonitoringPage.preset30d") },
    { value: "90d", label: t("AiMonitoringPage.preset90d") },
  ];

  const TABS = [
    { key: "proxy",    label: t("AiMonitoringPage.tabProxy"),    icon: "swap_horiz" },
    { key: "template", label: t("AiMonitoringPage.tabTemplate"), icon: "auto_awesome" },
    { key: "users",    label: t("AiMonitoringPage.tabUsers"),    icon: "groups" },
  ];

  const PROXY_COLS = [
    t("AiMonitoringPage.colTime"), t("AiMonitoringPage.colUser"), t("AiMonitoringPage.colModel"),
    t("AiMonitoringPage.colType"), t("AiMonitoringPage.colInput"), t("AiMonitoringPage.colOutput"),
    t("AiMonitoringPage.colDuration"), t("AiMonitoringPage.colStatus"),
  ];
  const TPL_COLS = [
    t("AiMonitoringPage.colTime"), t("AiMonitoringPage.colUser"), t("AiMonitoringPage.colCallType"),
    t("AiMonitoringPage.colModel"), t("AiMonitoringPage.colPreset"), t("AiMonitoringPage.colInput"),
    t("AiMonitoringPage.colOutput"), t("AiMonitoringPage.colDuration"), t("AiMonitoringPage.colStatus"),
  ];
  const USER_COLS = [
    t("AiMonitoringPage.colUser"), t("AiMonitoringPage.colCallCount"), t("AiMonitoringPage.colTokensTotal"),
    t("AiMonitoringPage.colAvgLatency"), t("AiMonitoringPage.colFailRate"),
  ];

  const CALL_TYPE_LABELS = {
    recommend: t("AiMonitoringPage.callTypeRecommend"),
    chat: t("AiMonitoringPage.callTypeChat"),
    ai_nav: t("AiMonitoringPage.callTypeAiNav"),
    tj_rubric: t("AiMonitoringPage.callTypeTjRubric"),
    tj_chat: t("AiMonitoringPage.callTypeTjChat"),
    tj_script_gen: t("AiMonitoringPage.callTypeTjScriptGen"),
    tj_script_review: t("AiMonitoringPage.callTypeTjScriptReview"),
    tj_result_ai: t("AiMonitoringPage.callTypeTjResultAi"),
  };

  function formatCallType(callType) {
    if (!callType) return "—";
    return CALL_TYPE_LABELS[callType] ?? callType;
  }

  /** silent = true 時不觸發 loading 與錯誤提示，供背景自動刷新使用 */
  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const range = presetToRange(preset);
      const [s, p, tpl, u] = await Promise.all([
        AiMonitoringService.stats(range),
        AiMonitoringService.listProxyCalls({ ...range, limit: 100 }),
        AiMonitoringService.listTemplateCalls({ ...range, limit: 100 }),
        AiMonitoringService.listUsersUsage({ ...range, limit: 100 }),
      ]);
      setStatsData(s);
      setProxyCalls(p?.data ?? []);
      setTemplateCalls(tpl?.data ?? []);
      setUsers(u?.data ?? []);
    } catch (e) {
      if (!silent) toast.error(e?.message ?? t("AiMonitoringPage.loadError"));
    } finally {
      if (!silent) setLoading(false);
    }
  }, [preset, toast, t]);

  useEffect(() => { load(); }, [load]);
  useAutoRefresh(() => load(true));

  const stats = useMemo(() => {
    if (!statsData) {
      return { totalCalls: 0, totalTokens: 0, successRate: 100, avgLatency: 0 };
    }
    const totalCalls = (statsData.proxy_total_calls ?? 0) + (statsData.template_total_calls ?? 0);
    const totalTokens =
      (statsData.proxy_total_input_tokens ?? 0) +
      (statsData.proxy_total_output_tokens ?? 0) +
      (statsData.template_total_input_tokens ?? 0) +
      (statsData.template_total_output_tokens ?? 0);
    const successRate = statsData.success_rate ?? 100;
    const avgLatency = statsData.avg_latency_ms ?? 0;
    return { totalCalls, totalTokens, successRate, avgLatency };
  }, [statsData]);

  const visibleCalls = useMemo(() => {
    const source = tab === "proxy" ? proxyCalls : templateCalls;
    const q = query.trim().toLowerCase();
    if (!q) return source;
    return source.filter(
      (c) =>
        (c.user_email ?? "").toLowerCase().includes(q) ||
        (c.user_full_name ?? "").toLowerCase().includes(q) ||
        (c.model_name ?? "").toLowerCase().includes(q) ||
        (c.call_type ?? "").toLowerCase().includes(q) ||
        formatCallType(c.call_type).toLowerCase().includes(q) ||
        (c.request_type ?? "").toLowerCase().includes(q) ||
        (c.preset ?? "").toLowerCase().includes(q),
    );
  }, [proxyCalls, templateCalls, tab, query]);

  const visibleUsers = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter(
      (u) =>
        (u.user_email ?? "").toLowerCase().includes(q) ||
        (u.user_full_name ?? "").toLowerCase().includes(q),
    );
  }, [users, query]);

  return (
    <div className={styles.page}>
      <PageHeader title={t("AiMonitoringPage.pageTitle")} subtitle={t("AiMonitoringPage.pageSubtitle")}>
        <div className={styles.pageActions}>
          <div className={styles.segment}>
            {PRESETS.map((p) => (
              <button
                key={p.value}
                type="button"
                className={`${styles.segmentBtn} ${preset === p.value ? styles.segmentActive : ""}`}
                onClick={() => setPreset(p.value)}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </PageHeader>

      <div className={styles.statRow}>
        <div className={styles.statCard}>
          <div className={styles.statIcon}>
            <MIcon name="swap_calls" size={20} />
          </div>
          <div className={styles.statInfo}>
            <span className={styles.statLabel}>{t("AiMonitoringPage.statCallCount")}</span>
            <span className={styles.statValue}>{stats.totalCalls}</span>
          </div>
        </div>
        <div className={styles.statCard}>
          <div className={`${styles.statIcon} ${styles.statIconAccent}`}>
            <MIcon name="bolt" size={20} />
          </div>
          <div className={styles.statInfo}>
            <span className={styles.statLabel}>{t("AiMonitoringPage.statTokensTotal")}</span>
            <span className={styles.statValue}>{formatTokens(stats.totalTokens)}</span>
          </div>
        </div>
        <div className={styles.statCard}>
          <div className={`${styles.statIcon} ${styles.statIconOk}`}>
            <MIcon name="task_alt" size={20} />
          </div>
          <div className={styles.statInfo}>
            <span className={styles.statLabel}>{t("AiMonitoringPage.statSuccessRate")}</span>
            <span className={styles.statValue}>{stats.successRate}%</span>
          </div>
        </div>
        <div className={styles.statCard}>
          <div className={`${styles.statIcon} ${styles.statIconBusy}`}>
            <MIcon name="timer" size={20} />
          </div>
          <div className={styles.statInfo}>
            <span className={styles.statLabel}>{t("AiMonitoringPage.statAvgLatency")}</span>
            <span className={styles.statValue}>{formatDuration(stats.avgLatency)}</span>
          </div>
        </div>
      </div>

      <div className={styles.tabs}>
        {TABS.map((tItem) => (
          <button
            key={tItem.key}
            type="button"
            className={`${styles.tab} ${tab === tItem.key ? styles.tabActive : ""}`}
            onClick={() => setTab(tItem.key)}
          >
            <MIcon name={tItem.icon} size={16} />
            {tItem.label}
          </button>
        ))}
      </div>

      <div className={styles.toolbar}>
        <div className={styles.search}>
          <MIcon name="search" size={16} />
          <input
            type="text"
            className={styles.searchInput}
            placeholder={tab === "users" ? t("AiMonitoringPage.searchPlaceholderUsers") : t("AiMonitoringPage.searchPlaceholderCalls")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      <div className={styles.content}>
        {loading ? (
          <LoadingState fullPage />
        ) : tab === "users" ? (
          visibleUsers.length === 0 ? (
            <EmptyState
              icon="groups"
              title={t("AiMonitoringPage.emptyUsersTitle")}
            />
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    {USER_COLS.map((c) => (
                      <th key={c} className={styles.th}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visibleUsers.map((u) => {
                    const totalCalls = (u.proxy_calls ?? 0) + (u.template_calls ?? 0);
                    const totalTokens =
                      (u.proxy_input_tokens ?? 0) +
                      (u.proxy_output_tokens ?? 0) +
                      (u.template_input_tokens ?? 0) +
                      (u.template_output_tokens ?? 0);
                    return (
                      <tr key={u.user_id} className={styles.tr}>
                        <td className={styles.td}>
                          <UserCell
                            email={u.user_email}
                            fullName={u.user_full_name}
                            fallback={u.user_id}
                          />
                        </td>
                        <td className={styles.td}>{totalCalls}</td>
                        <td className={styles.td}>{formatTokens(totalTokens)}</td>
                        <td className={styles.td}>—</td>
                        <td className={styles.td}>—</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        ) : visibleCalls.length === 0 ? (
          <EmptyState
            icon="analytics"
            title={t("AiMonitoringPage.emptyCallsTitle")}
          />
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  {(tab === "proxy" ? PROXY_COLS : TPL_COLS).map((c) => (
                    <th key={c} className={styles.th}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visibleCalls.map((c) => (
                  <tr key={c.id} className={styles.tr}>
                    <td className={styles.td}>{fmtTime(c.created_at)}</td>
                    <td className={styles.td}>
                      <UserCell
                        email={c.user_email}
                        fullName={c.user_full_name}
                        fallback={c.user_id}
                      />
                    </td>
                    {tab === "proxy" ? (
                      <>
                        <td className={`${styles.td} ${styles.monoCell}`} title={c.model_name}>
                          {formatModelDisplay(c.model_name)}
                        </td>
                        <td className={styles.td}>{c.request_type ?? "—"}</td>
                        <td className={`${styles.td} ${styles.numericCell}`}>{formatTokens(c.input_tokens ?? 0)}</td>
                        <td className={`${styles.td} ${styles.numericCell}`}>{formatTokens(c.output_tokens ?? 0)}</td>
                      </>
                    ) : (
                      <>
                        <td className={styles.td}>
                          <CallTypeCell callType={c.call_type} formatCallType={formatCallType} />
                        </td>
                        <td className={`${styles.td} ${styles.monoCell}`} title={c.model_name}>
                          {formatModelDisplay(c.model_name)}
                        </td>
                        <td className={styles.td}>{c.preset ?? "—"}</td>
                        <td className={`${styles.td} ${styles.numericCell}`}>{formatTokens(c.input_tokens ?? 0)}</td>
                        <td className={`${styles.td} ${styles.numericCell}`}>{formatTokens(c.output_tokens ?? 0)}</td>
                      </>
                    )}
                    <td className={`${styles.td} ${styles.numericCell}`}>{formatDuration(c.request_duration_ms)}</td>
                    <td className={styles.td}>
                      <StatusBadge status={c.status} />
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
