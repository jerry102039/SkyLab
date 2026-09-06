import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import styles from "./AiApiKeysPage.module.scss";
import MIcon from "../../../components/MIcon";
import LoadingState from "../../../components/LoadingState/LoadingState";
import SharedEmptyState from "../../../components/EmptyState/EmptyState";
import { AiApiService } from "../../../services/aiApi";
import { useToast } from "../../../hooks/useToast";
import useAutoRefresh from "../../../hooks/useAutoRefresh";
import useDialogPresence from "../../../hooks/useDialogPresence";
import PageHeader from "../../../components/PageHeader/PageHeader";

const PAGE_SIZE = 50;

function fmtTime(iso) {
  return iso ? new Date(iso).toLocaleString("zh-TW") : "—";
}

function StatusBadge({ item }) {
  const { t } = useTranslation("ai");
  const isActive = item.status === "active";
  return (
    <span className={`${styles.badge} ${isActive ? styles.badge_active : styles.badge_inactive}`}>
      <span className={styles.dot} />
      {isActive ? t("AiApiKeysPage.statusActive") : t("AiApiKeysPage.statusInactive")}
    </span>
  );
}

function EmptyState() {
  const { t } = useTranslation("ai");
  return (
    <SharedEmptyState icon="vpn_key" title={t("AiApiKeysPage.emptyTitle")} />
  );
}

/* ── Delete dialog ── */
function DeleteDialog({ item, closing = false, onClose, onDone }) {
  const { t } = useTranslation("ai");
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  if (!item) return null;

  const handleDelete = async () => {
    setBusy(true);
    try {
      await AiApiService.revokeCredential(item.id);
      toast.success(t("AiApiKeysPage.deleteSuccess"));
      onClose();
      onDone();
    } catch (e) {
      toast.error(e?.message ?? t("AiApiKeysPage.deleteError"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={`${styles.dialogOverlay} ${closing ? styles.dialogOverlayOut : ""}`}
      onClick={() => { if (!busy) onClose(); }}
    >
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <div className={styles.dialogHeader}>
          <h3 className={styles.dialogTitle}>{t("AiApiKeysPage.deleteConfirmTitle")}</h3>
          <p className={styles.dialogDesc}>
            {t("AiApiKeysPage.deleteConfirmDesc", { name: item.api_key_name })}
          </p>
        </div>
        <div className={styles.dialogFooter}>
          <button type="button" className={styles.btnOutline} onClick={onClose} disabled={busy}>
            {t("AiApiKeysPage.cancel")}
          </button>
          <button type="button" className={styles.btnDanger} onClick={handleDelete} disabled={busy}>
            {busy ? t("AiApiKeysPage.deleting") : t("AiApiKeysPage.confirmDelete")}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function AiApiKeysPage() {
  const { t } = useTranslation("ai");
  const toast = useToast();
  const [statusFilter, setStatusFilter] = useState("all");
  const [userEmail, setUserEmail] = useState("");
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [deletingItem, setDeletingItem] = useState(null);
  const deleteDialog = useDialogPresence(deletingItem);

  function inactiveReasonLabel(reason) {
    if (!reason) return "—";
    return reason === "revoked" ? t("AiApiKeysPage.inactiveReasonRevoked") : t("AiApiKeysPage.inactiveReasonExpired");
  }

  /* ── counts ── */
  const [allCount, setAllCount] = useState(0);
  const [activeCount, setActiveCount] = useState(0);
  const [inactiveCount, setInactiveCount] = useState(0);

  /** silent = true 時不觸發 loading 與錯誤提示，供背景自動刷新使用 */
  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await AiApiService.listAllCredentials();
      const data = res?.data ?? [];
      setTotal(data.length);
      setAllCount(data.length);
      setActiveCount(data.filter((c) => c.status === "active").length);
      setInactiveCount(data.filter((c) => c.status === "inactive").length);

      // Client-side filtering
      let filtered = data;
      if (statusFilter !== "all") {
        filtered = filtered.filter((c) => c.status === statusFilter);
      }
      if (userEmail.trim()) {
        const q = userEmail.trim().toLowerCase();
        filtered = filtered.filter(
          (c) =>
            (c.user_email ?? "").toLowerCase().includes(q) ||
            (c.user_full_name ?? "").toLowerCase().includes(q),
        );
      }

      setTotal(filtered.length);
      // Paginate
      const start = page * PAGE_SIZE;
      setRows(filtered.slice(start, start + PAGE_SIZE));
    } catch (e) {
      if (!silent) toast.error(e?.message ?? t("AiApiKeysPage.loadError"));
    } finally {
      if (!silent) setLoading(false);
    }
  }, [statusFilter, userEmail, page, toast, t]);

  useEffect(() => { load(); }, [load]);
  useAutoRefresh(() => load(true));

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const COLS = [
    t("AiApiKeysPage.colUser"),
    t("AiApiKeysPage.colKeyName"),
    t("AiApiKeysPage.colKeyPrefix"),
    t("AiApiKeysPage.colStatus"),
    t("AiApiKeysPage.colInactiveReason"),
    t("AiApiKeysPage.colCreatedAt"),
    t("AiApiKeysPage.colExpiresAt"),
    t("AiApiKeysPage.colRevokedAt"),
    t("AiApiKeysPage.colActions"),
  ];

  return (
    <div className={styles.page}>
      <PageHeader title={t("AiApiKeysPage.pageTitle")} subtitle={t("AiApiKeysPage.pageSubtitle")} />

      {/* ── Stat cards ── */}
      <div className={styles.statRow}>
        <div className={styles.statCard}>
          <div className={styles.statIcon}><MIcon name="key" size={20} /></div>
          <div className={styles.statInfo}>
            <span className={styles.statLabel}>{t("AiApiKeysPage.statAll")}</span>
            <span className={styles.statValue}>{allCount}</span>
          </div>
        </div>
        <div className={styles.statCard}>
          <div className={`${styles.statIcon} ${styles.statIconOk}`}><MIcon name="check_circle" size={20} /></div>
          <div className={styles.statInfo}>
            <span className={styles.statLabel}>{t("AiApiKeysPage.statActive")}</span>
            <span className={styles.statValue}>{activeCount}</span>
          </div>
        </div>
        <div className={styles.statCard}>
          <div className={`${styles.statIcon} ${styles.statIconErr}`}><MIcon name="cancel" size={20} /></div>
          <div className={styles.statInfo}>
            <span className={styles.statLabel}>{t("AiApiKeysPage.statInactive")}</span>
            <span className={styles.statValue}>{inactiveCount}</span>
          </div>
        </div>
      </div>

      {/* 篩選就是兩個輸入框，標題與說明只是把畫面上看得到的事再講一次 */}
      <div className={styles.filterRow}>
        <select
          className={styles.filterSelect}
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value); setPage(0); }}
        >
          <option value="all">{t("AiApiKeysPage.filterAll")}</option>
          <option value="active">{t("AiApiKeysPage.filterActive")}</option>
          <option value="inactive">{t("AiApiKeysPage.filterInactive")}</option>
        </select>
        <input
          type="text"
          className={styles.filterInput}
          placeholder={t("AiApiKeysPage.filterEmailPlaceholder")}
          value={userEmail}
          onChange={(e) => { setUserEmail(e.target.value); setPage(0); }}
        />
      </div>

      {/* ── Table ── */}
      <div className={styles.content}>
        {loading ? (
          <LoadingState fullPage />
        ) : rows.length === 0 ? (
          <EmptyState />
        ) : (
          <>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    {COLS.map((col) => (
                      <th key={col} className={styles.th}>{col}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((item) => (
                    <tr key={item.id} className={styles.tr}>
                      <td className={styles.td}>
                        <div className={styles.userCell}>
                          <span className={styles.userName}>
                            {item.user_full_name
                              ? `${item.user_full_name} (${item.user_email || "—"})`
                              : (item.user_email ?? "—")}
                          </span>
                        </div>
                      </td>
                      <td className={styles.td}>{item.api_key_name}</td>
                      <td className={`${styles.td} ${styles.mono}`}>{item.api_key_prefix}</td>
                      <td className={styles.td}><StatusBadge item={item} /></td>
                      <td className={styles.td}>{inactiveReasonLabel(item.inactive_reason)}</td>
                      <td className={styles.td}>{fmtTime(item.created_at)}</td>
                      <td className={styles.td}>{fmtTime(item.expires_at)}</td>
                      <td className={styles.td}>{fmtTime(item.revoked_at)}</td>
                      <td className={styles.td}>
                        <button
                          type="button"
                          className={`${styles.actionBtn} ${styles.actionBtnDanger}`}
                          title={t("AiApiKeysPage.deleteAction")}
                          onClick={() => setDeletingItem(item)}
                        >
                          <MIcon name="delete" size={16} />
                          {t("AiApiKeysPage.deleteAction")}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* ── Pagination ── */}
            {totalPages > 1 && (
              <div className={styles.pagination}>
                <span className={styles.paginationInfo}>
                  {t("AiApiKeysPage.paginationInfo", { page: page + 1, totalPages, total })}
                </span>
                <div className={styles.paginationBtns}>
                  <button
                    type="button"
                    className={styles.btnOutline}
                    disabled={page === 0}
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                  >
                    {t("AiApiKeysPage.prevPage")}
                  </button>
                  <button
                    type="button"
                    className={styles.btnOutline}
                    disabled={page + 1 >= totalPages}
                    onClick={() => setPage((p) => (p + 1 >= totalPages ? p : p + 1))}
                  >
                    {t("AiApiKeysPage.nextPage")}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Delete dialog ── */}
      {deleteDialog.open && (
        <DeleteDialog
          item={deleteDialog.item}
          closing={deleteDialog.closing}
          onClose={() => setDeletingItem(null)}
          onDone={load}
        />
      )}
    </div>
  );
}
