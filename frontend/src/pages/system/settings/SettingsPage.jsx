import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import styles from "./SettingsPage.module.scss";
import MIcon from "../../../components/MIcon";
import LoadingState from "../../../components/LoadingState/LoadingState";
import { useConfirm } from "../../../components/ConfirmDialog/ConfirmProvider";
import EmptyState from "../../../components/EmptyState/EmptyState";
import { useToast } from "../../../hooks/useToast";
import { ProxmoxConfigService } from "../../../services/proxmoxConfig";
import GovernanceTab from "./GovernanceTab";
import LdapTab from "./LdapTab";
import PageHeader from "../../../components/PageHeader/PageHeader";

/**
 * PUT /proxmox-config 需要的完整欄位（password / ca_cert 另外處理）。
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
  "placement_peak_cpu_margin",
  "placement_peak_memory_margin", "placement_loadavg_warn_per_core",
  "placement_loadavg_max_per_core", "placement_loadavg_penalty_weight",
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

/* ── PVE 多連線管理 ─────────────────────────────────── */
const EMPTY_CONNECTION_FORM = {
  name: "",
  host: "",
  port: 8006,
  user: "root@pam",
  password: "",
  verify_ssl: false,
  ca_cert: "",
  api_timeout: 30,
  pool_name: "SkyLab",
  iso_storage: "local",
  data_storage: "local-lvm",
  task_check_interval: 2,
  gateway_ip: "",
  local_subnet: "",
  default_node: "",
  enabled: true,
  is_default: false,
};

/** 編輯既有連線時，把 API 回傳的連線資料轉成表單狀態 */
function connectionToForm(conn) {
  return {
    ...EMPTY_CONNECTION_FORM,
    name: conn.name,
    host: conn.host,
    port: conn.port,
    user: conn.user,
    verify_ssl: conn.verify_ssl,
    api_timeout: conn.api_timeout,
    pool_name: conn.pool_name ?? "",
    iso_storage: conn.iso_storage ?? "",
    data_storage: conn.data_storage ?? "",
    task_check_interval: conn.task_check_interval ?? 2,
    gateway_ip: conn.gateway_ip ?? "",
    local_subnet: conn.local_subnet ?? "",
    default_node: conn.default_node ?? "",
    enabled: conn.enabled,
    is_default: conn.is_default,
  };
}

function ConnectionForm({ initial, isEdit, saving, onSubmit, onCancel }) {
  const { t } = useTranslation("system");
  const [form, setForm] = useState(initial);
  const set = (name, value) => setForm((prev) => ({ ...prev, [name]: value }));

  function handleSubmit(e) {
    e.preventDefault();
    const payload = {
      name: form.name.trim(),
      host: form.host.trim(),
      port: Number(form.port) || 8006,
      user: form.user.trim(),
      verify_ssl: Boolean(form.verify_ssl),
      api_timeout: Number(form.api_timeout) || 30,
      pool_name: form.pool_name.trim() || "SkyLab",
      iso_storage: form.iso_storage.trim() || "local",
      data_storage: form.data_storage.trim() || "local-lvm",
      task_check_interval: Number(form.task_check_interval) || 2,
      gateway_ip: form.gateway_ip.trim() || null,
      local_subnet: form.local_subnet.trim() || null,
      default_node: form.default_node.trim() || null,
      enabled: Boolean(form.enabled),
      is_default: Boolean(form.is_default),
    };
    if (isEdit) {
      payload.password = form.password ? form.password : null;
      payload.ca_cert = form.ca_cert?.trim() ? form.ca_cert.trim() : null;
    } else {
      payload.password = form.password;
      if (form.ca_cert?.trim()) payload.ca_cert = form.ca_cert.trim();
    }
    onSubmit(payload);
  }

  return (
    <form className={styles.card} onSubmit={handleSubmit}>
      <h2 className={styles.cardTitle}>{isEdit ? t("SettingsPage.editConnection") : t("SettingsPage.addConnection")}</h2>
      <h3 className={styles.sectionTitle}>{t("SettingsPage.connectionSettingsTitle")}</h3>
      <div className={styles.formGrid}>
        <label className={styles.field}>
          <span>{t("SettingsPage.connectionName")}</span>
          <input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder={t("SettingsPage.connectionNamePlaceholder")} required />
        </label>
        <label className={styles.field}>
          <span>Host *</span>
          <input value={form.host} onChange={(e) => set("host", e.target.value)} placeholder={t("SettingsPage.hostPlaceholder")} required />
        </label>
        <label className={styles.field}>
          <span>Port</span>
          <input type="number" min={1} max={65535} value={form.port} onChange={(e) => set("port", e.target.value)} />
        </label>
        <label className={styles.field}>
          <span>{t("SettingsPage.apiUser")}</span>
          <input value={form.user} onChange={(e) => set("user", e.target.value)} placeholder="root@pam" required />
        </label>
        <label className={styles.field}>
          <span>{t("SettingsPage.password")}{isEdit ? t("SettingsPage.leaveBlankUnchanged") : " *"}</span>
          <input
            type="password"
            value={form.password}
            onChange={(e) => set("password", e.target.value)}
            placeholder={isEdit ? t("SettingsPage.passwordSetPlaceholder") : t("SettingsPage.pvePasswordPlaceholder")}
            required={!isEdit}
          />
        </label>
        <label className={styles.field}>
          <span>{t("SettingsPage.apiTimeoutSeconds")}</span>
          <input type="number" min={1} max={300} value={form.api_timeout} onChange={(e) => set("api_timeout", e.target.value)} />
        </label>
      </div>
      <label className={styles.checkRow}>
        <input type="checkbox" checked={Boolean(form.verify_ssl)} onChange={(e) => set("verify_ssl", e.target.checked)} />
        <span>{t("SettingsPage.verifySslCert")}</span>
      </label>
      {form.verify_ssl && (
        <label className={styles.field}>
          <span>{t("SettingsPage.caCertPem")}{isEdit ? t("SettingsPage.leaveBlankUnchanged") : ""}</span>
          <textarea
            rows={5}
            value={form.ca_cert}
            onChange={(e) => set("ca_cert", e.target.value)}
            placeholder="-----BEGIN CERTIFICATE-----"
            spellCheck={false}
          />
        </label>
      )}

      <h3 className={styles.sectionTitle}>{t("SettingsPage.clusterResourceSettingsTitle")}</h3>
      <p className={styles.cardDesc}>
        {t("SettingsPage.clusterResourceSettingsDesc")}
      </p>
      <div className={styles.formGrid}>
        <label className={styles.field}>
          <span>{t("SettingsPage.poolName")}</span>
          <input value={form.pool_name} onChange={(e) => set("pool_name", e.target.value)} placeholder="SkyLab" />
        </label>
        <label className={styles.field}>
          <span>ISO Storage</span>
          <input value={form.iso_storage} onChange={(e) => set("iso_storage", e.target.value)} placeholder="local" />
        </label>
        <label className={styles.field}>
          <span>Data Storage</span>
          <input value={form.data_storage} onChange={(e) => set("data_storage", e.target.value)} placeholder="local-lvm" />
        </label>
        <label className={styles.field}>
          <span>{t("SettingsPage.taskCheckInterval")}</span>
          <input
            type="number"
            min={1}
            max={60}
            value={form.task_check_interval}
            onChange={(e) => set("task_check_interval", e.target.value)}
          />
        </label>
        <label className={styles.field}>
          <span>Gateway IP</span>
          <input value={form.gateway_ip} onChange={(e) => set("gateway_ip", e.target.value)} placeholder={t("SettingsPage.optional")} />
        </label>
        <label className={styles.field}>
          <span>{t("SettingsPage.localSubnet")}</span>
          <input value={form.local_subnet} onChange={(e) => set("local_subnet", e.target.value)} placeholder={t("SettingsPage.localSubnetPlaceholder")} />
        </label>
        <label className={styles.field}>
          <span>{t("SettingsPage.defaultNode")}</span>
          <input value={form.default_node} onChange={(e) => set("default_node", e.target.value)} placeholder={t("SettingsPage.defaultNodePlaceholder")} />
        </label>
      </div>

      <div className={styles.toggleGrid}>
        <label className={styles.checkRow}>
          <input type="checkbox" checked={Boolean(form.enabled)} onChange={(e) => set("enabled", e.target.checked)} />
          <span>{t("SettingsPage.enableThisConnection")}</span>
        </label>
        <label className={styles.checkRow}>
          <input type="checkbox" checked={Boolean(form.is_default)} onChange={(e) => set("is_default", e.target.checked)} />
          <span>{t("SettingsPage.setAsDefaultConnection")}</span>
        </label>
      </div>
      <div className={styles.cardActions}>
        <button type="button" className={styles.btnSecondary} onClick={onCancel}>{t("SettingsPage.cancel")}</button>
        <button type="submit" className={styles.btnPrimary} disabled={saving}>
          {saving ? t("SettingsPage.saving") : t("SettingsPage.saveConnection")}
        </button>
      </div>
    </form>
  );
}

function ConnectionsSection({ connections, loading, onRefresh }) {
  const { t } = useTranslation("system");
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(null); // null | "new" | connection 物件
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState(null);

  async function handleSubmit(payload) {
    setSaving(true);
    try {
      if (editing === "new") {
        await ProxmoxConfigService.createConnection(payload);
        toast.success(t("SettingsPage.toastConnectionAdded"));
      } else {
        await ProxmoxConfigService.updateConnection(editing.id, payload);
        toast.success(t("SettingsPage.toastConnectionUpdated"));
      }
      setEditing(null);
      onRefresh();
    } catch (err) {
      toast.error(err?.message ?? t("SettingsPage.toastSaveConnectionFailed"));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(conn) {
    const ok = await confirm({
      title: t("SettingsPage.deleteConnectionTitle"),
      message: t("SettingsPage.deleteConnectionMessage", { name: conn.name }),
      confirmText: t("SettingsPage.delete"),
      danger: true,
    });
    if (!ok) return;
    setBusyId(conn.id);
    try {
      await ProxmoxConfigService.deleteConnection(conn.id);
      toast.success(t("SettingsPage.toastConnectionDeleted"));
      onRefresh();
    } catch (err) {
      toast.error(err?.message ?? t("SettingsPage.toastDeleteConnectionFailed"));
    } finally {
      setBusyId(null);
    }
  }

  async function handleTest(conn) {
    setBusyId(conn.id);
    try {
      const res = await ProxmoxConfigService.testConnectionById(conn.id);
      if (res.success) toast.success(res.message || t("SettingsPage.toastConnectSuccess"));
      else toast.error(res.message || t("SettingsPage.toastConnectFailed"));
    } catch (err) {
      toast.error(err?.message ?? t("SettingsPage.toastConnectTestFailed"));
    } finally {
      setBusyId(null);
    }
  }

  async function handleSync(conn) {
    setBusyId(conn.id);
    try {
      const res = await ProxmoxConfigService.syncConnection(conn.id);
      if (res.success) {
        toast.success(t("SettingsPage.toastSyncComplete", { nodes: res.nodes?.length ?? 0, storage: res.storage_count ?? 0 }));
        onRefresh();
      } else {
        toast.error(res.error || t("SettingsPage.toastSyncFailed"));
      }
    } catch (err) {
      toast.error(err?.message ?? t("SettingsPage.toastSyncFailed"));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className={styles.panelStack}>
      <div className={styles.card}>
        <div className={styles.cardHead}>
          <h2 className={styles.cardTitle}>{t("SettingsPage.connectionsListTitle")}</h2>
          <button type="button" className={styles.btnSecondary} onClick={() => setEditing("new")}>
            <MIcon name="add" size={16} />
            {t("SettingsPage.addConnection")}
          </button>
        </div>
        {loading ? (
          <LoadingState text={t("SettingsPage.loadingConnections")} />
        ) : connections.length === 0 ? (
          <p className={styles.cardDesc}>
            {t("SettingsPage.noConnectionsYet")}
          </p>
        ) : (
          <div className={styles.list}>
            {connections.map((conn) => (
              <div key={conn.id} className={styles.nodeRow}>
                <div className={styles.rowMain}>
                  <span className={styles.rowName}>
                    {conn.name}
                    {conn.is_default && <span className={`${styles.badge} ${styles.badge_info}`}>{t("SettingsPage.default")}</span>}
                    {!conn.enabled && <span className={`${styles.badge} ${styles.badge_danger}`}>{t("SettingsPage.disabled")}</span>}
                  </span>
                  <span className={styles.rowMeta}>
                    {conn.host}:{conn.port} · {conn.user} · {t("SettingsPage.nodeCount", { count: conn.node_count })}
                  </span>
                </div>
                <button type="button" className={styles.btnSecondary} disabled={busyId === conn.id} onClick={() => handleTest(conn)}>
                  <MIcon name="wifi_tethering" size={16} />
                  {t("SettingsPage.test")}
                </button>
                <button type="button" className={styles.btnSecondary} disabled={busyId === conn.id} onClick={() => handleSync(conn)}>
                  <MIcon name="sync" size={16} />
                  {t("SettingsPage.sync")}
                </button>
                <button type="button" className={styles.btnSecondary} disabled={busyId === conn.id} onClick={() => setEditing(conn)}>
                  <MIcon name="edit" size={16} />
                  {t("SettingsPage.edit")}
                </button>
                <button type="button" className={styles.btnSecondary} disabled={busyId === conn.id} onClick={() => handleDelete(conn)}>
                  <MIcon name="delete" size={16} />
                  {t("SettingsPage.delete")}
                </button>
              </div>
            ))}
          </div>
        )}
        <p className={styles.cardHint}>
          {t("SettingsPage.nodeMetricsHintPrefix")}{" "}
          <Link to="/monitoring" className={styles.inlineLink}>{t("SettingsPage.nodeMetricsHintLink")}</Link>
          {" "}{t("SettingsPage.nodeMetricsHintSuffix")}
        </p>
      </div>

      {editing !== null && (
        <ConnectionForm
          key={editing === "new" ? "new" : editing.id}
          isEdit={editing !== "new"}
          saving={saving}
          initial={
            editing === "new" ? EMPTY_CONNECTION_FORM : connectionToForm(editing)
          }
          onSubmit={handleSubmit}
          onCancel={() => setEditing(null)}
        />
      )}
    </div>
  );
}

/* ── 資源排程 ──────────────────────────────────────── */
function useSchedulerGroups(t) {
  return useMemo(() => [
    {
      title: t("SettingsPage.placementOvercommitTitle"),
      fields: [
        { key: "cpu_overcommit_ratio", label: t("SettingsPage.cpuOvercommitRatio"), step: 0.1 },
        { key: "disk_overcommit_ratio", label: t("SettingsPage.diskOvercommitRatio"), step: 0.1 },
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

function SchedulerTab({ form, setField, onSave, saving }) {
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

/* ── 節點管理 ──────────────────────────────────────── */
function NodesTab() {
  const { t } = useTranslation("system");
  const toast = useToast();
  const [nodes, setNodes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // node id
  const [editForm, setEditForm] = useState({ host: "", port: 8006, priority: 0 });
  const [saving, setSaving] = useState(false);

  const fetchNodes = useCallback(() => {
    setLoading(true);
    ProxmoxConfigService.getNodes()
      .then(setNodes)
      .catch((err) => toast.error(err?.message ?? t("SettingsPage.toastLoadNodesFailed")))
      .finally(() => setLoading(false));
  }, [toast, t]);

  useEffect(() => {
    fetchNodes();
  }, [fetchNodes]);

  function startEdit(node) {
    setEditing(node.id);
    setEditForm({ host: node.host, port: node.port, priority: node.priority });
  }

  async function saveEdit(node) {
    setSaving(true);
    try {
      const updated = await ProxmoxConfigService.updateNode(node.id, {
        host: editForm.host.trim(),
        port: Number(editForm.port) || 8006,
        priority: Number(editForm.priority) || 0,
        enabled: node.enabled ?? true,
      });
      setNodes((prev) => prev.map((n) => (n.id === node.id ? updated : n)));
      toast.success(t("SettingsPage.toastNodeUpdated"));
      setEditing(null);
    } catch (err) {
      toast.error(err?.message ?? t("SettingsPage.toastUpdateNodeFailed"));
    } finally {
      setSaving(false);
    }
  }

  async function toggleEnabled(node, enabled) {
    setSaving(true);
    try {
      const updated = await ProxmoxConfigService.updateNode(node.id, {
        host: node.host,
        port: node.port,
        priority: node.priority,
        enabled,
      });
      setNodes((prev) => prev.map((n) => (n.id === node.id ? updated : n)));
      toast.success(
        enabled ? t("SettingsPage.toastNodeEnabled", { name: node.name }) : t("SettingsPage.toastNodeDisabled", { name: node.name })
      );
    } catch (err) {
      toast.error(err?.message ?? t("SettingsPage.toastUpdateNodeFailed"));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <LoadingState text={t("SettingsPage.loadingNodes")} />;
  if (nodes.length === 0) {
    return (
      <EmptyState icon="lock" title={t("SettingsPage.emptyNoNodeData")} />
    );
  }

  return (
    <div className={styles.list}>
      {nodes.map((node) => (
        <div key={node.id ?? node.name} className={styles.nodeRow}>
          <div className={styles.rowMain}>
            <span className={styles.rowName}>
              {node.name}
              {node.is_primary && <span className={`${styles.badge} ${styles.badge_info}`}>{t("SettingsPage.primaryNode")}</span>}
              {node.enabled === false && (
                <span className={`${styles.badge} ${styles.badge_danger}`}>{t("SettingsPage.disabled")}</span>
              )}
            </span>
            <span className={styles.rowMeta}>
              {node.host}:{node.port} · Priority {node.priority}
              {node.enabled === false && ` · ${t("SettingsPage.notAcceptingNewVms")}`}
            </span>
          </div>
          <span className={`${styles.badge} ${node.is_online ? styles.badge_success : styles.badge_danger}`}>
            {node.is_online ? t("SettingsPage.online") : t("SettingsPage.offline")}
          </span>
          <label className={styles.checkRow} title={t("SettingsPage.disableNodeHint")}>
            <input
              type="checkbox"
              checked={node.enabled !== false}
              disabled={saving || node.id == null}
              onChange={(e) => toggleEnabled(node, e.target.checked)}
            />
            <span>{t("SettingsPage.enable")}</span>
          </label>
          {editing === node.id ? (
            <div className={styles.nodeEdit}>
              <input
                value={editForm.host}
                onChange={(e) => setEditForm((p) => ({ ...p, host: e.target.value }))}
                placeholder="Host"
              />
              <input
                type="number"
                value={editForm.port}
                onChange={(e) => setEditForm((p) => ({ ...p, port: e.target.value }))}
                placeholder="Port"
              />
              <input
                type="number"
                value={editForm.priority}
                onChange={(e) => setEditForm((p) => ({ ...p, priority: e.target.value }))}
                placeholder="Priority"
              />
              <button type="button" className={styles.btnPrimary} disabled={saving} onClick={() => saveEdit(node)}>
                {saving ? "..." : t("SettingsPage.save")}
              </button>
              <button type="button" className={styles.btnSecondary} onClick={() => setEditing(null)}>
                {t("SettingsPage.cancel")}
              </button>
            </div>
          ) : (
            <button type="button" className={styles.btnSecondary} onClick={() => startEdit(node)} disabled={node.id == null}>
              <MIcon name="edit" size={16} />
              {t("SettingsPage.edit")}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/* ── Storage ───────────────────────────────────────── */
function StorageTab() {
  const { t } = useTranslation("system");
  const toast = useToast();
  const [storages, setStorages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState(null);

  useEffect(() => {
    ProxmoxConfigService.getStorages()
      .then(setStorages)
      .catch((err) => toast.error(err?.message ?? t("SettingsPage.toastLoadStorageFailed")))
      .finally(() => setLoading(false));
  }, [toast, t]);

  // 只有一組 PVE 連線時不必再標註連線名稱
  const multiConnection = useMemo(
    () => new Set(storages.map((s) => s.connection_id ?? null)).size > 1,
    [storages],
  );

  async function save(storage, patch) {
    setSavingId(storage.id);
    try {
      const updated = await ProxmoxConfigService.updateStorage(storage.id, {
        enabled: patch.enabled ?? storage.enabled,
        speed_tier: patch.speed_tier ?? storage.speed_tier,
        user_priority: patch.user_priority ?? storage.user_priority,
      });
      setStorages((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      const nodeCount = updated.node_names?.length ?? 1;
      toast.success(
        updated.is_shared && nodeCount > 1
          ? t("SettingsPage.toastStorageUpdatedMultiNode", { storage: storage.storage, count: nodeCount })
          : t("SettingsPage.toastStorageUpdated", { storage: storage.storage }),
      );
    } catch (err) {
      toast.error(err?.message ?? t("SettingsPage.toastUpdateStorageFailed"));
    } finally {
      setSavingId(null);
    }
  }

  if (loading) return <LoadingState text={t("SettingsPage.loadingStorage")} />;
  if (storages.length === 0) {
    return (
      <EmptyState icon="storage" title={t("SettingsPage.emptyNoStorageConfig")} />
    );
  }

  return (
    <div className={styles.list}>
      {storages.map((storage) => (
        <div key={storage.id} className={styles.storageRow}>
          <div className={styles.rowMain}>
            <span className={styles.rowName}>
              {storage.storage}
              {multiConnection && storage.connection_name && (
                <span className={`${styles.badge} ${styles.badge_muted}`}>{storage.connection_name}</span>
              )}
              {storage.is_shared ? (
                <span
                  className={`${styles.badge} ${styles.badge_info}`}
                  title={(storage.node_names ?? []).join("、")}
                >
                  {t("SettingsPage.sharedNodeCount", { count: storage.node_names?.length ?? 1 })}
                </span>
              ) : (
                <span className={`${styles.badge} ${styles.badge_muted}`}>{storage.node_name}</span>
              )}
            </span>
            <span className={styles.rowMeta}>
              {storage.storage_type ?? "?"} · {Math.round(storage.used_gb)} / {Math.round(storage.total_gb)} GB ·
              {" "}{[storage.can_vm && "VM", storage.can_lxc && "LXC", storage.can_iso && "ISO", storage.can_backup && "Backup"].filter(Boolean).join(" / ") || t("SettingsPage.noPurpose")}
            </span>
          </div>
          <select
            value={storage.speed_tier}
            disabled={savingId === storage.id}
            onChange={(e) => save(storage, { speed_tier: e.target.value })}
            className={styles.inlineSelect}
          >
            <option value="nvme">NVMe</option>
            <option value="ssd">SSD</option>
            <option value="hdd">HDD</option>
            <option value="unknown">{t("SettingsPage.unknown")}</option>
          </select>
          <input
            type="number"
            className={styles.inlineInput}
            title={t("SettingsPage.userPriorityTitle")}
            value={storage.user_priority}
            disabled={savingId === storage.id}
            onChange={(e) => save(storage, { user_priority: Number(e.target.value) || 0 })}
          />
          <label className={styles.checkRow}>
            <input
              type="checkbox"
              checked={storage.enabled}
              disabled={savingId === storage.id}
              onChange={(e) => save(storage, { enabled: e.target.checked })}
            />
            <span>{t("SettingsPage.enable")}</span>
          </label>
        </div>
      ))}
    </div>
  );
}

/* ── Page ──────────────────────────────────────────── */
export default function SettingsPage() {
  const { t } = useTranslation("system");
  const toast = useToast();
  const TABS = [
    { key: "pve",       label: t("SettingsPage.tabPve"),       icon: "device_hub"    },
    { key: "scheduler", label: t("SettingsPage.tabScheduler"), icon: "settings_input_component" },
    { key: "governance", label: t("SettingsPage.tabGovernance"), icon: "policy"        },
    { key: "ldap",      label: "LDAP",      icon: "badge"         },
    { key: "nodes",     label: t("SettingsPage.tabNodes"),     icon: "lock"          },
    { key: "storage",   label: "Storage",   icon: "storage"       },
  ];
  const [activeTab, setActiveTab] = useState("pve");
  const [form, setForm] = useState(buildFormFromConfig(null));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [connections, setConnections] = useState([]);
  const [connectionsLoading, setConnectionsLoading] = useState(true);

  useEffect(() => {
    ProxmoxConfigService.getConfig()
      .then((cfg) => setForm(buildFormFromConfig(cfg)))
      .catch((err) => toast.error(err?.message ?? t("SettingsPage.toastLoadSchedulerFailed")))
      .finally(() => setLoading(false));
  }, [toast, t]);

  const fetchConnections = useCallback(() => {
    setConnectionsLoading(true);
    ProxmoxConfigService.listConnections()
      .then(setConnections)
      .catch((err) => toast.error(err?.message ?? t("SettingsPage.toastLoadConnectionsFailed")))
      .finally(() => setConnectionsLoading(false));
  }, [toast, t]);

  useEffect(() => {
    fetchConnections();
  }, [fetchConnections]);

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
      {/* ── 頁首 ── */}
      <PageHeader title={t("SettingsPage.pageTitle")} subtitle={t("SettingsPage.pageSubtitle")}>

        {/* ── Tabs ── */}
        <div className={styles.tabs}>
          {TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              className={`${styles.tab} ${activeTab === tab.key ? styles.tabActive : ""}`}
              onClick={() => setActiveTab(tab.key)}
            >
              <MIcon name={tab.icon} size={16} />
              {tab.label}
            </button>
          ))}
        </div>
      </PageHeader>

      {/* ── 內容 ── */}
      <div className={styles.content}>
        {loading ? (
          <LoadingState fullPage text={t("SettingsPage.loadingSettings")} />
        ) : (
          <>
            {activeTab === "pve" && (
              <ConnectionsSection
                connections={connections}
                loading={connectionsLoading}
                onRefresh={fetchConnections}
              />
            )}
            {activeTab === "scheduler" && (
              <SchedulerTab form={form} setField={setField} onSave={handleSave} saving={saving} />
            )}
            {activeTab === "governance" && <GovernanceTab />}
            {activeTab === "ldap" && <LdapTab />}
            {activeTab === "nodes" && <NodesTab />}
            {activeTab === "storage" && <StorageTab />}
          </>
        )}
      </div>
    </div>
  );
}
