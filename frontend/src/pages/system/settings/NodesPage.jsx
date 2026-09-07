import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import styles from "./settings.module.scss";
import MIcon from "../../../components/MIcon";
import LoadingState from "../../../components/LoadingState/LoadingState";
import EmptyState from "../../../components/EmptyState/EmptyState";
import { useToast } from "../../../hooks/useToast";
import { ProxmoxConfigService } from "../../../services/proxmoxConfig";
import PageHeader from "../../../components/PageHeader/PageHeader";

/**
 * 節點管理（系統管理 → 節點管理）：各 PVE 節點的啟用狀態、連線位址與放置優先度。
 * 節點清單由「PVE 連線」的同步動作更新。2026-09 從「系統設定」的分頁拆成獨立頁面。
 */

/* ── 節點管理 ──────────────────────────────────────── */
function NodeList() {
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

/* ── Page ──────────────────────────────────────────── */
export default function NodesPage() {
  const { t } = useTranslation("system");
  return (
    <div className={styles.page}>
      <PageHeader title={t("SettingsPage.nodesTitle")} subtitle={t("SettingsPage.nodesSubtitle")} />
      <div className={styles.content}>
        <NodeList />
      </div>
    </div>
  );
}
