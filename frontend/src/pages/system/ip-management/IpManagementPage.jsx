import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import styles from "./IpManagementPage.module.scss";
import MIcon from "../../../components/MIcon";
import LoadingState from "../../../components/LoadingState/LoadingState";
import SubnetConfigForm from "./SubnetConfigForm";
import { useAuth } from "../../../contexts/AuthContext";
import SharedEmptyState from "../../../components/EmptyState/EmptyState";
import { IpManagementService } from "../../../services/ipManagement";
import { useConfirm } from "../../../components/ConfirmDialog/ConfirmProvider";
import { useToast } from "../../../hooks/useToast";
import useAutoRefresh from "../../../hooks/useAutoRefresh";
import PageHeader from "../../../components/PageHeader/PageHeader";

function EmptyState({ variant, canConfigure, onConfigure }) {
  const { t } = useTranslation("system");
  if (variant === "unconfigured") {
    return (
      <SharedEmptyState
        icon="lan"
        title={t("IpManagementPage.emptyUnconfigured")}
        action={
          canConfigure ? (
            <button type="button" className={styles.btnPrimary} onClick={onConfigure}>
              <MIcon name="add" size={18} />
              {t("IpManagementPage.createSubnetConfig")}
            </button>
          ) : null
        }
      />
    );
  }

  const isNoMatch = variant === "no-match";
  return (
    <SharedEmptyState
      icon={isNoMatch ? "search_off" : "inbox"}
      title={isNoMatch ? t("IpManagementPage.emptyNoMatch") : t("IpManagementPage.emptyNoData")}
    />
  );
}

function PurposeBadge({ purpose }) {
  const { t } = useTranslation("system");
  const PURPOSE_LABELS = {
    vm: "VM",
    lxc: "LXC",
    gateway_vm: "Gateway VM",
    subnet_gateway: t("IpManagementPage.purposeGateway"),
    reserved: t("IpManagementPage.purposeReserved"),
  };
  const label = PURPOSE_LABELS[purpose] ?? purpose ?? "—";
  return (
    <span className={`${styles.badge} ${styles[`badge_${purpose ?? "unknown"}`]}`}>
      {label}
    </span>
  );
}

export default function IpManagementPage() {
  const { t } = useTranslation("system");
  const toast = useToast();
  const confirm = useConfirm();
  const { user } = useAuth();
  const isAdmin = Boolean(user?.is_superuser || user?.role === "admin");

  const [allocations, setAllocations] = useState([]);
  const [subnet, setSubnet] = useState(null);
  const [status, setStatus] = useState(null);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  /** silent = true 時不觸發 loading 與錯誤提示，供背景自動刷新使用 */
  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [allocRes, subnetRes, statusRes] = await Promise.all([
        IpManagementService.listAllocations({ limit: 500 }),
        IpManagementService.getSubnet().catch(() => null),
        IpManagementService.getStatus().catch(() => null),
      ]);
      setAllocations(allocRes?.allocations ?? []);
      setSubnet(subnetRes ?? null);
      setStatus(statusRes ?? null);
    } catch (e) {
      if (!silent) toast.error(e?.message ?? t("IpManagementPage.toastLoadFailed"));
    } finally {
      if (!silent) setLoading(false);
    }
  }, [toast, t]);

  useEffect(() => { load(); }, [load]);
  /* 編輯中不背景刷新，避免表單被重新掛載而清空輸入 */
  useAutoRefresh(() => { if (!editing) load(true); });

  /* getSubnet 需要管理員權限，非管理員只能靠 status 判斷是否已設定 */
  const configured = Boolean(subnet) || Boolean(status?.configured);

  /* 已有 VM/LXC 佔用網段時後端不允許改 CIDR，先在表單擋下來 */
  const cidrLocked = useMemo(
    () => allocations.some((a) => a.purpose === "vm" || a.purpose === "lxc"),
    [allocations],
  );

  const stats = useMemo(() => {
    const total = subnet?.total_ips ?? status?.total_ips ?? 0;
    const used  = subnet?.used_ips  ?? status?.used_ips  ?? allocations.length;
    const free  = subnet?.available_ips ?? status?.available_ips ?? Math.max(0, total - used);
    return { total, used, free };
  }, [allocations, subnet, status]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return allocations;
    return allocations.filter(
      (a) =>
        (a.ip_address ?? "").toLowerCase().includes(q) ||
        (a.description ?? "").toLowerCase().includes(q) ||
        String(a.vmid ?? "").includes(q),
    );
  }, [allocations, filter]);

  const emptyVariant = !configured
    ? "unconfigured"
    : allocations.length === 0
      ? "no-data"
      : "no-match";

  async function handleSave(payload) {
    setSaving(true);
    try {
      await IpManagementService.upsertSubnet(payload);
      toast.success(t("IpManagementPage.toastSubnetSaved"));
      setEditing(false);
      await load();
    } catch (e) {
      toast.error(e?.message ?? t("IpManagementPage.toastSaveSubnetFailed"));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    const ok = await confirm({
      title: t("IpManagementPage.deleteSubnetTitle"),
      message: t("IpManagementPage.deleteSubnetMessage"),
      confirmText: t("IpManagementPage.delete"),
      danger: true,
    });
    if (!ok) return;
    setDeleting(true);
    try {
      await IpManagementService.deleteSubnet();
      toast.success(t("IpManagementPage.toastSubnetDeleted"));
      setEditing(false);
      await load();
    } catch (e) {
      toast.error(e?.message ?? t("IpManagementPage.toastDeleteSubnetFailed"));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className={styles.page}>
      <PageHeader title={t("IpManagementPage.pageTitle")} subtitle={t("IpManagementPage.pageSubtitle")}>
        {isAdmin && !editing && (
          <div className={styles.pageActions}>
            <button
              type="button"
              className={styles.btnPrimary}
              onClick={() => setEditing(true)}
            >
              <MIcon name={configured ? "edit" : "add"} size={18} />
              {configured ? t("IpManagementPage.editSubnetConfig") : t("IpManagementPage.createSubnetConfig")}
            </button>
          </div>
        )}
      </PageHeader>

      <div className={styles.statRow}>
        <div className={styles.statCard}>
          <div className={styles.statIcon}>
            <MIcon name="public" size={20} />
          </div>
          <div className={styles.statInfo}>
            <span className={styles.statLabel}>{t("IpManagementPage.statTotal")}</span>
            <span className={styles.statValue}>{stats.total}</span>
          </div>
        </div>
        <div className={styles.statCard}>
          <div className={`${styles.statIcon} ${styles.statIconOk}`}>
            <MIcon name="check_circle" size={20} />
          </div>
          <div className={styles.statInfo}>
            <span className={styles.statLabel}>{t("IpManagementPage.statAvailable")}</span>
            <span className={styles.statValue}>{stats.free}</span>
          </div>
        </div>
        <div className={styles.statCard}>
          <div className={`${styles.statIcon} ${styles.statIconBusy}`}>
            <MIcon name="lan" size={20} />
          </div>
          <div className={styles.statInfo}>
            <span className={styles.statLabel}>{t("IpManagementPage.statAllocated")}</span>
            <span className={styles.statValue}>{stats.used}</span>
          </div>
        </div>
      </div>

      {editing && (
        <SubnetConfigForm
          key={subnet?.updated_at ?? "new"}
          config={subnet}
          cidrLocked={cidrLocked}
          saving={saving}
          deleting={deleting}
          onSubmit={handleSave}
          onCancel={() => setEditing(false)}
          onDelete={handleDelete}
        />
      )}

      <div className={styles.toolbar}>
        <div className={styles.search}>
          <MIcon name="search" size={16} />
          <input
            type="text"
            className={styles.searchInput}
            placeholder={t("IpManagementPage.searchPlaceholder")}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        {subnet && (
          <span className={styles.muted}>
            {t("IpManagementPage.subnetLabel")} <code className={styles.code}>{subnet.cidr}</code> · Bridge: <code className={styles.code}>{subnet.bridge_name}</code>
          </span>
        )}
      </div>

      <div className={styles.content}>
        {loading ? (
          <LoadingState fullPage text={t("IpManagementPage.loading")} />
        ) : visible.length === 0 ? (
          <EmptyState
            variant={emptyVariant}
            canConfigure={isAdmin && !editing}
            onConfigure={() => setEditing(true)}
          />
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  {[t("IpManagementPage.colIpAddress"), t("IpManagementPage.colPurpose"), "VMID", t("IpManagementPage.colDescription"), t("IpManagementPage.colAllocatedAt")].map((col) => (
                    <th key={col} className={styles.th}>{col}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map((a) => (
                  <tr key={a.ip_address} className={styles.tr}>
                    <td className={styles.td}>
                      <div className={styles.nameCell}>
                        <div className={styles.nameIcon}>
                          <MIcon name="device_hub" size={18} />
                        </div>
                        <div>
                          <div className={styles.namePrimary}>{a.ip_address}</div>
                        </div>
                      </div>
                    </td>
                    <td className={styles.td}>
                      <PurposeBadge purpose={a.purpose} />
                    </td>
                    <td className={styles.td}>{a.vmid ?? "—"}</td>
                    <td className={styles.td}>{a.description ?? "—"}</td>
                    <td className={styles.td}>
                      {a.allocated_at
                        ? new Date(a.allocated_at).toLocaleString("zh-TW")
                        : "—"}
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
