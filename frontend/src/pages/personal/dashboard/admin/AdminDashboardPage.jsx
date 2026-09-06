import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import AiPveChat from "../../../../components/AiPveChat/AiPveChat";
import MIcon from "../../../../components/MIcon";
import { useAuth } from "../../../../contexts/AuthContext";
import { AiApiService } from "../../../../services/aiApi";
import { BatchProvisionService } from "../../../../services/batchProvision";
import { JobsService } from "../../../../services/jobs";
import { MonitoringService } from "../../../../services/monitoring";
import { SpecChangeRequestsService } from "../../../../services/specChangeRequests";
import { VmRequestsService } from "../../../../services/vmRequests";
import styles from "./AdminDashboardPage.module.scss";
import PageHeader from "../../../../components/PageHeader/PageHeader";
import i18n from "../../../../i18n";

export function countRows(response) {
  if (Array.isArray(response)) return response.length;
  if (Number.isFinite(response?.count)) return response.count;
  if (Number.isFinite(response?.total)) return response.total;
  if (Array.isArray(response?.data)) return response.data.length;
  if (Array.isArray(response?.items)) return response.items.length;
  return 0;
}

const defaultT = (key) => i18n.t(key, { ns: "personal" });

export function buildAdminIssues(checks, t = defaultT) {
  const issues = [];
  if (checks.alerts > 0) issues.push({ key: "alerts", tone: "danger", icon: "error", title: t("AdminDashboardPage.issueAlertsTitle"), description: t("AdminDashboardPage.issueAlertsDesc"), count: checks.alerts, path: "/monitoring" });
  if (checks.failedJobs > 0) issues.push({ key: "jobs", tone: "danger", icon: "error_outline", title: t("AdminDashboardPage.issueJobsTitle"), description: t("AdminDashboardPage.issueJobsDesc"), count: checks.failedJobs, path: "/jobs" });
  if (checks.requests > 0) issues.push({ key: "requests", tone: "info", icon: "pending_actions", title: t("AdminDashboardPage.issueRequestsTitle"), description: t("AdminDashboardPage.issueRequestsDesc"), count: checks.requests, path: "/request-review" });
  if (checks.batches > 0) issues.push({ key: "batches", tone: "info", icon: "library_add_check", title: t("AdminDashboardPage.issueBatchesTitle"), description: t("AdminDashboardPage.issueBatchesDesc"), count: checks.batches, path: "/batch-review" });
  if (checks.aiRequests > 0) issues.push({ key: "ai", tone: "info", icon: "rate_review", title: t("AdminDashboardPage.issueAiTitle"), description: t("AdminDashboardPage.issueAiDesc"), count: checks.aiRequests, path: "/ai-api-review" });
  if (checks.unavailable > 0) issues.push({ key: "unavailable", tone: "muted", icon: "cloud_off", title: t("AdminDashboardPage.issueUnavailableTitle"), description: t("AdminDashboardPage.issueUnavailableDesc"), count: checks.unavailable, path: "/monitoring" });
  return issues;
}

export function normalizeAssistantPrompt(value) {
  return String(value ?? "").trim();
}

export default function AdminDashboardPage() {
  const { t } = useTranslation("personal");
  const navigate = useNavigate();
  const { user } = useAuth();
  const [assistantPrompt, setAssistantPrompt] = useState("");
  const [conversationPrompt, setConversationPrompt] = useState("");
  /* 放大模式：對話佔滿版面，上面的「需要前往確認」暫時收起來 */
  const [focusMode, setFocusMode] = useState(false);
  const [checks, setChecks] = useState({ alerts: 0, failedJobs: 0, requests: 0, batches: 0, aiRequests: 0, unavailable: 0 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    async function loadChecks() {
      setLoading(true);
      const settled = await Promise.allSettled([
        VmRequestsService.listAll("pending"),
        SpecChangeRequestsService.listAll({ status: "pending" }),
        BatchProvisionService.listPending(),
        AiApiService.listAllRequests(),
        JobsService.list({ statuses: ["failed", "blocked"], historyDays: 7, limit: 50 }),
        MonitoringService.listAlerts({ active: true, limit: 100 }),
      ]);
      if (!active) return;
      const value = (index) => settled[index].status === "fulfilled" ? settled[index].value : null;
      const unavailable = settled.filter((result) => result.status === "rejected").length;
      const aiPending = value(3)?.data?.filter((request) => request.status === "pending").length ?? 0;
      setChecks({
        requests: countRows(value(0)) + countRows(value(1)),
        batches: countRows(value(2)),
        aiRequests: aiPending,
        failedJobs: countRows(value(4)),
        alerts: countRows(value(5)),
        unavailable,
      });
      setLoading(false);
    }
    loadChecks();
    return () => { active = false; };
  }, []);

  const issues = useMemo(() => buildAdminIssues(checks, t), [checks, t]);
  const name = user?.full_name?.trim() || user?.email?.split("@")[0] || t("AdminDashboardPage.defaultName");

  function resetAssistant() {
    setConversationPrompt("");
    setAssistantPrompt("");
    setFocusMode(false);
  }

  function openAssistant(event) {
    event.preventDefault();
    const prompt = normalizeAssistantPrompt(assistantPrompt);
    if (!prompt) return;
    setConversationPrompt(prompt);
  }

  const suggestions = [
    t("AdminDashboardPage.suggestion1"),
    t("AdminDashboardPage.suggestion2"),
    t("AdminDashboardPage.suggestion3"),
  ];

  return <div className={`${styles.page} ${focusMode ? styles.pageFocused : ""}`}>
    <PageHeader title={t("AdminDashboardPage.greeting", { name })} subtitle={t("AdminDashboardPage.subtitle")} />

    {!focusMode && <section className={styles.attention} aria-labelledby="admin-attention-title">
      <div className={styles.sectionHeading}><div><span className={styles.eyebrow}>{t("AdminDashboardPage.priorityLabel")}</span><h2 id="admin-attention-title">{t("AdminDashboardPage.attentionTitle")}</h2></div><button type="button" onClick={() => navigate("/monitoring")}>{t("AdminDashboardPage.openMonitoring")}<MIcon name="arrow_forward" size={16} /></button></div>
      {loading ? <div className={styles.checking}><MIcon name="sync" size={20} />{t("AdminDashboardPage.checking")}</div> : issues.length ? <div className={styles.issueList}>{issues.map((issue) => <button type="button" key={issue.key} className={styles[`issue_${issue.tone}`]} onClick={() => navigate(issue.path)}><span className={styles.issueIcon}><MIcon name={issue.icon} size={20} /></span><span><strong>{issue.title}</strong><small>{issue.description}</small></span><em>{issue.count}</em><MIcon name="arrow_forward" size={18} /></button>)}</div> : <div className={styles.allClear}><span><MIcon name="check_circle" size={21} /></span><div><strong>{t("AdminDashboardPage.allClearTitle")}</strong><p>{t("AdminDashboardPage.allClearDesc")}</p></div></div>}
    </section>}

    <section className={`${styles.assistantSection} ${conversationPrompt ? styles.assistantSectionExpanded : ""} ${focusMode ? styles.assistantSectionFocused : ""}`} aria-labelledby="admin-assistant-title">
      <div className={styles.assistantHero}>
        <div className={styles.assistantIntro}>
          <span className={styles.assistantIcon}><MIcon name="support_agent" size={28} /></span>
          <div>
            <span className={styles.assistantLabel}>{t("AdminDashboardPage.assistantLabel")}</span>
            <h2 id="admin-assistant-title">{t("AdminDashboardPage.assistantTitle")}</h2>
            {/* 對話開始後這段說明就沒有作用了，版面留給對話 */}
            {!conversationPrompt && <p>{t("AdminDashboardPage.assistantIntro")}</p>}
          </div>
        </div>
        {conversationPrompt && (
          <div className={styles.assistantActions}>
            {/* 問問題時把上面那區暫時收起來，對話拿到整個版面；隨時可以回去 */}
            <button type="button" className={styles.assistantReset} onClick={() => setFocusMode((value) => !value)}>
              <MIcon name={focusMode ? "close_fullscreen" : "open_in_full"} size={16} />
              {focusMode ? t("AdminDashboardPage.backToOverview") : t("AdminDashboardPage.expandChat")}
            </button>
            <button type="button" className={styles.assistantReset} onClick={resetAssistant}>
              <MIcon name="refresh" size={16} />
              {t("AdminDashboardPage.askAgain")}
            </button>
          </div>
        )}
        {!conversationPrompt && <form className={styles.assistantForm} onSubmit={openAssistant}>
          <div className={styles.assistantInput}>
            <MIcon name="terminal" size={21} />
            <textarea value={assistantPrompt} onChange={(event) => setAssistantPrompt(event.target.value)} placeholder={t("AdminDashboardPage.promptPlaceholder")} rows={2} autoComplete="off" />
            <button type="submit" disabled={!assistantPrompt.trim()}><span>{t("AdminDashboardPage.startAsking")}</span><MIcon name="arrow_downward" size={18} /></button>
          </div>
          <div className={styles.assistantFooter}>
            <span>{t("AdminDashboardPage.suggestionsLabel")}</span>
            {suggestions.map((suggestion) => <button type="button" key={suggestion} onClick={() => setAssistantPrompt(suggestion)}>{suggestion}</button>)}
          </div>
        </form>}
      </div>
      {conversationPrompt && <AiPveChat initialPrompt={conversationPrompt} compact={!focusMode} fill={focusMode} />}
    </section>

  </div>;
}
