import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import styles from "./settings.module.scss";
import LoadingState from "../../../components/LoadingState/LoadingState";
import { useToast } from "../../../hooks/useToast";
import { ProxmoxConfigService } from "../../../services/proxmoxConfig";
import PageHeader from "../../../components/PageHeader/PageHeader";

/**
 * 資源排程（系統管理 → 資源排程）：跨叢集共用的放置／超配／排程開機參數，
 * 存在 proxmox_config singleton。2026-09 從「系統設定」的分頁拆成獨立頁面。
 */

/**
 * PUT /proxmox-config 需要的完整欄位（password / ca_cert 另外處理）。
 *
 * ProxmoxConfigUpdate 是全量取代 schema：沒送出的欄位不是「維持原值」，
 * 而是套用 schema 預設值。所以這份清單必須涵蓋 singleton 的每一個可寫欄位，
 * 漏掉任何一個，存檔就會把該欄位默默重置成預設。
 *
 * 連線與叢集資源欄位（host / user / storage / pool / gateway…）已改由
 * 「PVE 連線」的新增·編輯表單管理，這裡保留只是為了原樣送回 singleton，
 * 讓排程設定能單獨儲存；UI 不再提供編輯入口。
 */
const UPDATE_KEYS = [
  "host", "user", "verify_ssl", "iso_storage", "data_storage",
  "api_timeout", "task_check_interval", "pool_name", "gateway_ip",
  "local_subnet", "default_node",
  "cpu_overcommit_ratio", "disk_overcommit_ratio",
  "placement_reassignment_cost", "placement_peak_cpu_margin",
  "placement_peak_memory_margin", "placement_loadavg_warn_per_core",
  "placement_loadavg_max_per_core", "placement_loadavg_penalty_weight",
  "placement_disk_contention_warn_share", "placement_disk_contention_high_share",
  "placement_disk_penalty_weight",
  "placement_cpu_peak_warn_share", "placement_cpu_peak_high_share",
  "placement_memory_peak_warn_share", "placement_memory_peak_high_share",
  "placement_resource_weight_cpu", "placement_resource_weight_memory",
  "placement_resource_weight_disk",
  "scheduled_boot_batch_size", "scheduled_boot_batch_interval_seconds",
  "scheduled_boot_lead_time_minutes", "window_grace_period_minutes",
  "practice_session_hours", "practice_warning_minutes",
  "expiry_warning_hours",
];

function buildFormFromConfig(config) {
  const form = {};
  for (const key of UPDATE_KEYS) form[key] = config?.[key] ?? "";
  form.password = "";
  form.ca_cert = "";
  return form;
}

function buildPayload(form) {
  const payload = {};
  for (const key of UPDATE_KEYS) {
    const value = form[key];
    payload[key] = value === "" ? null : value;
  }
  if (form.password) payload.password = form.password;
  if (form.ca_cert?.trim()) payload.ca_cert = form.ca_cert.trim();
  return payload;
}

/* ── 資源排程 ──────────────────────────────────────── */
function useSchedulerGroups(t) {
  return useMemo(() => [
    {
      title: t("SettingsPage.placementOvercommitTitle"),
      fields: [
        { key: "cpu_overcommit_ratio", label: t("SettingsPage.cpuOvercommitRatio"), step: 0.1 },
        { key: "disk_overcommit_ratio", label: t("SettingsPage.diskOvercommitRatio"), step: 0.1 },
        { key: "placement_reassignment_cost", label: t("SettingsPage.placementReassignmentCost"), step: 0.01 },
      ],
    },
    {
      title: t("SettingsPage.resourceThresholdsTitle"),
      fields: [
        { key: "placement_peak_cpu_margin", label: t("SettingsPage.placementPeakCpuMargin"), step: 0.01 },
        { key: "placement_peak_memory_margin", label: t("SettingsPage.placementPeakMemoryMargin"), step: 0.01 },
        { key: "placement_loadavg_warn_per_core", label: t("SettingsPage.placementLoadavgWarnPerCore"), step: 0.1 },
        { key: "placement_loadavg_max_per_core", label: t("SettingsPage.placementLoadavgMaxPerCore"), step: 0.1 },
        { key: "placement_loadavg_penalty_weight", label: t("SettingsPage.placementLoadavgPenaltyWeight"), step: 0.01 },
        { key: "placement_disk_contention_warn_share", label: t("SettingsPage.placementDiskContentionWarnShare"), step: 0.01 },
        { key: "placement_disk_contention_high_share", label: t("SettingsPage.placementDiskContentionHighShare"), step: 0.01 },
        { key: "placement_disk_penalty_weight", label: t("SettingsPage.placementDiskPenaltyWeight"), step: 0.01 },
        { key: "placement_cpu_peak_warn_share", label: t("SettingsPage.placementCpuPeakWarnShare"), step: 0.01 },
        { key: "placement_cpu_peak_high_share", label: t("SettingsPage.placementCpuPeakHighShare"), step: 0.01 },
        { key: "placement_memory_peak_warn_share", label: t("SettingsPage.placementMemoryPeakWarnShare"), step: 0.01 },
        { key: "placement_memory_peak_high_share", label: t("SettingsPage.placementMemoryPeakHighShare"), step: 0.01 },
        { key: "placement_resource_weight_cpu", label: t("SettingsPage.placementResourceWeightCpu"), step: 0.01 },
        { key: "placement_resource_weight_memory", label: t("SettingsPage.placementResourceWeightMemory"), step: 0.01 },
        { key: "placement_resource_weight_disk", label: t("SettingsPage.placementResourceWeightDisk"), step: 0.01 },
      ],
    },
    {
      title: t("SettingsPage.scheduledBootTitle"),
      fields: [
        { key: "scheduled_boot_batch_size", label: t("SettingsPage.scheduledBootBatchSize") },
        { key: "scheduled_boot_batch_interval_seconds", label: t("SettingsPage.scheduledBootBatchIntervalSeconds") },
        { key: "scheduled_boot_lead_time_minutes", label: t("SettingsPage.scheduledBootLeadTimeMinutes") },
        { key: "window_grace_period_minutes", label: t("SettingsPage.windowGracePeriodMinutes") },
        { key: "practice_session_hours", label: t("SettingsPage.practiceSessionHours") },
        { key: "practice_warning_minutes", label: t("SettingsPage.practiceWarningMinutes") },
        { key: "expiry_warning_hours", label: t("SettingsPage.expiryWarningHours") },
      ],
    },
  ], [t]);
}

function SchedulerForm({ form, setField, onSave, saving }) {
  const { t } = useTranslation("system");
  const SCHEDULER_GROUPS = useSchedulerGroups(t);
  return (
    <form className={styles.panelStack} onSubmit={onSave}>
      {SCHEDULER_GROUPS.map((group) => (
        <div key={group.title} className={styles.card}>
          <h2 className={styles.cardTitle}>{group.title}</h2>
          <div className={styles.formGrid}>
            {group.fields.map((f) => (
              <label key={f.key} className={styles.field}>
                <span>{f.label}</span>
                <input
                  type="number"
                  step={f.step ?? 1}
                  value={form[f.key]}
                  onChange={(e) => setField(f.key, Number(e.target.value))}
                />
              </label>
            ))}
          </div>
        </div>
      ))}

      <div className={styles.cardActions}>
        <button type="submit" className={styles.btnPrimary} disabled={saving}>
          {saving ? t("SettingsPage.saving") : t("SettingsPage.saveSchedulerSettings")}
        </button>
      </div>
    </form>
  );
}

/* ── Page ──────────────────────────────────────────── */
export default function SchedulerPage() {
  const { t } = useTranslation("system");
  const toast = useToast();
  const [form, setForm] = useState(buildFormFromConfig(null));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    ProxmoxConfigService.getConfig()
      .then((cfg) => setForm(buildFormFromConfig(cfg)))
      .catch((err) => toast.error(err?.message ?? t("SettingsPage.toastLoadSchedulerFailed")))
      .finally(() => setLoading(false));
  }, [toast, t]);

  const setField = useCallback((name, value) => {
    setForm((prev) => ({ ...prev, [name]: value }));
  }, []);

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const updated = await ProxmoxConfigService.updateConfig(buildPayload(form));
      setForm(buildFormFromConfig(updated));
      toast.success(t("SettingsPage.toastSettingsSaved"));
    } catch (err) {
      toast.error(err?.message ?? t("SettingsPage.toastSaveSettingsFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={styles.page}>
      <PageHeader title={t("SettingsPage.schedulerTitle")} subtitle={t("SettingsPage.schedulerSubtitle")} />
      <div className={styles.content}>
        {loading ? (
          <LoadingState fullPage text={t("SettingsPage.loadingSettings")} />
        ) : (
          <SchedulerForm form={form} setField={setField} onSave={handleSave} saving={saving} />
        )}
      </div>
    </div>
  );
}
