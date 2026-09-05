import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import styles from "./ResourceDetailPage.module.scss";
import MIcon from "../../../../components/MIcon";
import OverviewTab from "./OverviewTab";
import MonitoringTab from "./MonitoringTab";
import SpecificationsTab from "./SpecificationsTab";
import SnapshotsTab from "./SnapshotsTab";
import AuditLogsTab from "./AuditLogsTab";
import AdvancedSettingsTab from "./AdvancedSettingsTab";
import PageHeader from "../../../../components/PageHeader/PageHeader";

const TABS = [
  { key: "overview",       labelKey: "ResourceDetailPage.tabOverview", icon: "info" },
  { key: "monitoring",     labelKey: "ResourceDetailPage.tabMonitoring", icon: "monitor_heart" },
  { key: "specifications", labelKey: "ResourceDetailPage.tabSpecifications", icon: "tune" },
  { key: "snapshots",      labelKey: "ResourceDetailPage.tabSnapshots", icon: "photo_camera" },
  { key: "auditLogs",      labelKey: "ResourceDetailPage.tabAuditLogs", icon: "receipt_long" },
  { key: "advanced",       labelKey: "ResourceDetailPage.tabAdvanced", icon: "settings" },
];

/**
 * 資源詳情頁。backTo 由路由決定（/my-resources 或 /resource-mgmt）。
 */
export default function ResourceDetailPage({ backTo = "/my-resources" }) {
  const { t } = useTranslation("personal");
  const navigate = useNavigate();
  const params = useParams();
  const vmid = Number.parseInt(params.vmid, 10);
  const [tab, setTab] = useState("overview");

  return (
    <div className={styles.page}>
      <PageHeader
        leading={
          <button
            type="button"
            className={styles.backBtn}
            onClick={() => navigate(backTo)}
            title={t("ResourceDetailPage.backToList")}
          >
            <MIcon name="arrow_back" size={20} />
          </button>
        }
        title={<>{t("ResourceDetailPage.title")} <span className={styles.vmidText}>#{vmid}</span></>}
      />

      <div className={styles.tabs}>
        {TABS.map((tabDef) => (
          <button
            key={tabDef.key}
            type="button"
            className={`${styles.tab} ${tab === tabDef.key ? styles.tabActive : ""}`}
            onClick={() => setTab(tabDef.key)}
          >
            <MIcon name={tabDef.icon} size={16} />
            {t(tabDef.labelKey)}
          </button>
        ))}
      </div>

      <div className={styles.content}>
        {tab === "overview"       && <OverviewTab vmid={vmid} />}
        {tab === "monitoring"     && <MonitoringTab vmid={vmid} />}
        {tab === "specifications" && <SpecificationsTab vmid={vmid} />}
        {tab === "snapshots"      && <SnapshotsTab vmid={vmid} />}
        {tab === "auditLogs"      && <AuditLogsTab vmid={vmid} />}
        {tab === "advanced"       && <AdvancedSettingsTab vmid={vmid} />}
      </div>
    </div>
  );
}
