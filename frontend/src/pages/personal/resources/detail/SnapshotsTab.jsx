import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import styles from "./ResourceDetailPage.module.scss";
import MIcon from "../../../../components/MIcon";
import LoadingState from "../../../../components/LoadingState/LoadingState";
import EmptyState from "../../../../components/EmptyState/EmptyState";
import { ResourcesService } from "../../../../services/resources";
import { useToast } from "../../../../hooks/useToast";
import useDialogPresence from "../../../../hooks/useDialogPresence";
import { focusInvalidField } from "../../../../utils/focusField";

const INIT_SNAPSHOT_NAME = "skylab-init";

/** 輕量確認 dialog（比照 ResourcesPage 的 ConfirmModal 行為） */
function ConfirmModal({ title, desc, confirmLabel, danger = false, loading = false, closing = false, onConfirm, onClose }) {
  const { t } = useTranslation("personal");
  return (
    <div
      className={`${styles.modalOverlay} ${closing ? styles.modalOverlayOut : ""}`}
      onClick={onClose}
    >
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <span className={styles.modalTitle}>{title}</span>
        {desc && <p className={styles.modalDesc}>{desc}</p>}
        <div className={styles.modalActions}>
          <button type="button" className={styles.btnSecondary} onClick={onClose}>
            {t("ConfirmModal.cancel")}
          </button>
          <button
            type="button"
            className={danger ? styles.btnDanger : styles.btnPrimary}
            disabled={loading}
            onClick={onConfirm}
          >
            {loading ? t("ConfirmModal.processing") : (confirmLabel ?? t("ConfirmModal.confirm"))}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function SnapshotsTab({ vmid }) {
  const { t } = useTranslation("personal");
  const toast = useToast();
  const [snapshots, setSnapshots] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [resetConfirm, setResetConfirm] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [rollbackTarget, setRollbackTarget] = useState(null);
  const [snapname, setSnapname] = useState("");
  const [nameInvalid, setNameInvalid] = useState(false);
  const snapnameRef = useRef(null);
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const createDialog    = useDialogPresence(createOpen);
  const resetDialog     = useDialogPresence(resetConfirm);
  const rollbackDialog  = useDialogPresence(rollbackTarget);
  const deleteDialog    = useDialogPresence(deleteTarget);

  const load = useCallback(async () => {
    try {
      setSnapshots(await ResourcesService.listSnapshots(vmid));
    } catch (e) {
      toast.error(e?.message ?? t("SnapshotsTab.loadFailed"));
      setSnapshots((prev) => prev ?? []);
    }
  }, [vmid, toast, t]);

  useEffect(() => {
    load();
  }, [load]);

  const hasInitSnapshot = (snapshots ?? []).some((s) => s.name === INIT_SNAPSHOT_NAME);

  const run = async (fn, successMsg, after) => {
    setBusy(true);
    try {
      await fn();
      toast.success(successMsg);
      after?.();
      await load();
    } catch (e) {
      toast.error(e?.message ?? t("SnapshotsTab.operationFailed"));
    } finally {
      setBusy(false);
    }
  };

  const handleCreate = () => {
    if (!snapname.trim()) {
      setNameInvalid(true);
      focusInvalidField(snapnameRef.current);
      return;
    }
    run(
      () =>
        ResourcesService.createSnapshot(vmid, {
          snapname: snapname.trim(),
          description: description || undefined,
          vmstate: false,
        }),
      t("SnapshotsTab.snapshotCreating"),
      () => {
        setCreateOpen(false);
        setSnapname("");
        setNameInvalid(false);
        setDescription("");
      },
    );
  };

  if (snapshots === null) return <LoadingState />;

  return (
    <div className={styles.tabStack}>
      <div className={styles.card}>
        <div className={styles.cardHeader}>
          <div>
            <h2 className={styles.cardTitle}>{t("SnapshotsTab.title")}</h2>
            <p className={styles.cardDesc}>{t("SnapshotsTab.desc")}</p>
          </div>
          <div className={styles.headerActions}>
            <button
              type="button"
              className={styles.btnSecondary}
              disabled={!hasInitSnapshot || busy}
              title={hasInitSnapshot ? undefined : t("SnapshotsTab.noInitSnapshotHint")}
              onClick={() => setResetConfirm(true)}
            >
              <MIcon name="restart_alt" size={14} />
              {t("SnapshotsTab.oneClickReset")}
            </button>
            {!hasInitSnapshot && (
              <button
                type="button"
                className={styles.btnSecondary}
                disabled={busy}
                onClick={() =>
                  run(() => ResourcesService.createInitSnapshot(vmid), t("SnapshotsTab.initSnapshotCreated"))
                }
              >
                {t("SnapshotsTab.createInitSnapshot")}
              </button>
            )}
            <button
              type="button"
              className={styles.btnPrimary}
              onClick={() => { setNameInvalid(false); setCreateOpen(true); }}
            >
              <MIcon name="add" size={14} />
              {t("SnapshotsTab.createSnapshot")}
            </button>
          </div>
        </div>

        {snapshots.length === 0 ? (
          <EmptyState icon="photo_camera" title={t("SnapshotsTab.emptyTitle")} />
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.th}>{t("SnapshotsTab.colName")}</th>
                <th className={styles.th}>{t("SnapshotsTab.colDesc")}</th>
                <th className={styles.th}>{t("SnapshotsTab.colCreatedAt")}</th>
                <th className={`${styles.th} ${styles.thRight}`}>{t("SnapshotsTab.colActions")}</th>
              </tr>
            </thead>
            <tbody>
              {snapshots.map((snap) => (
                <tr key={snap.name} className={styles.tr}>
                  <td className={styles.td}>
                    <span className={styles.snapName}>
                      {snap.name}
                      {snap.name === INIT_SNAPSHOT_NAME && (
                        <span className={`${styles.badge} ${styles.badge_info}`}>
                          <MIcon name="verified_user" size={12} />
                          {t("SnapshotsTab.protected")}
                        </span>
                      )}
                    </span>
                  </td>
                  <td className={`${styles.td} ${styles.mutedCell}`}>
                    {snap.description || "—"}
                  </td>
                  <td className={`${styles.td} ${styles.mutedCell}`}>
                    {snap.snaptime
                      ? new Date(snap.snaptime * 1000).toLocaleString("zh-TW")
                      : "—"}
                  </td>
                  <td className={`${styles.td} ${styles.tdRight}`}>
                    <button
                      type="button"
                      className={styles.btnSecondary}
                      disabled={busy}
                      onClick={() => setRollbackTarget(snap.name)}
                    >
                      <MIcon name="history" size={14} />
                      {t("SnapshotsTab.restore")}
                    </button>
                    {snap.name !== INIT_SNAPSHOT_NAME && (
                      <button
                        type="button"
                        className={styles.btnDangerOutline}
                        disabled={busy}
                        onClick={() => setDeleteTarget(snap.name)}
                      >
                        <MIcon name="delete_outline" size={14} />
                        {t("SnapshotsTab.delete")}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {createDialog.open && (
        <div
          className={`${styles.modalOverlay} ${createDialog.closing ? styles.modalOverlayOut : ""}`}
          onClick={() => setCreateOpen(false)}
        >
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <span className={styles.modalTitle}>{t("SnapshotsTab.createSnapshotTitle")}</span>
            <p className={styles.modalDesc}>{t("SnapshotsTab.createSnapshotDesc")}</p>
            <div className={`${styles.field} ${nameInvalid ? styles.fieldInvalid : ""}`}>
              <label htmlFor="snap-name">{t("SnapshotsTab.nameLabel")}</label>
              <input
                id="snap-name"
                ref={snapnameRef}
                type="text"
                placeholder="snap-2026-07-04"
                aria-invalid={nameInvalid}
                value={snapname}
                onChange={(e) => { setSnapname(e.target.value); setNameInvalid(false); }}
              />
            </div>
            <div className={styles.field}>
              <label htmlFor="snap-desc">{t("SnapshotsTab.descLabel")}</label>
              <textarea
                id="snap-desc"
                rows={3}
                placeholder={t("SnapshotsTab.descPlaceholder")}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <div className={styles.modalActions}>
              <button
                type="button"
                className={styles.btnSecondary}
                onClick={() => setCreateOpen(false)}
              >
                {t("SnapshotsTab.cancel")}
              </button>
              <button
                type="button"
                className={styles.btnPrimary}
                disabled={busy}
                onClick={handleCreate}
              >
                {busy ? t("SnapshotsTab.creating") : t("SnapshotsTab.create")}
              </button>
            </div>
          </div>
        </div>
      )}

      {resetDialog.open && (
        <ConfirmModal
          title={t("SnapshotsTab.resetConfirmTitle")}
          desc={t("SnapshotsTab.resetConfirmDesc")}
          confirmLabel={t("SnapshotsTab.reset")}
          danger
          loading={busy}
          closing={resetDialog.closing}
          onConfirm={() =>
            run(() => ResourcesService.resetToInit(vmid), t("SnapshotsTab.resetTaskQueued"), () =>
              setResetConfirm(false),
            )
          }
          onClose={() => setResetConfirm(false)}
        />
      )}

      {rollbackDialog.open && (
        <ConfirmModal
          title={t("SnapshotsTab.rollbackConfirmTitle", { name: rollbackDialog.item })}
          desc={t("SnapshotsTab.rollbackConfirmDesc")}
          confirmLabel={t("SnapshotsTab.restore")}
          danger
          loading={busy}
          closing={rollbackDialog.closing}
          onConfirm={() =>
            run(
              () => ResourcesService.rollbackSnapshot(vmid, rollbackDialog.item),
              t("SnapshotsTab.rollbackStarted"),
              () => setRollbackTarget(null),
            )
          }
          onClose={() => setRollbackTarget(null)}
        />
      )}

      {deleteDialog.open && (
        <ConfirmModal
          title={t("SnapshotsTab.deleteConfirmTitle", { name: deleteDialog.item })}
          desc={t("SnapshotsTab.deleteConfirmDesc")}
          confirmLabel={t("SnapshotsTab.delete")}
          danger
          loading={busy}
          closing={deleteDialog.closing}
          onConfirm={() =>
            run(
              () => ResourcesService.deleteSnapshot(vmid, deleteDialog.item),
              t("SnapshotsTab.snapshotDeleted"),
              () => setDeleteTarget(null),
            )
          }
          onClose={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
