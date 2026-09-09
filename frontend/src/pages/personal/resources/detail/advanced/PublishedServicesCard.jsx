/**
 * PublishedServicesCard — 對外服務
 * 一列＝VM 裡的一個 port 怎麼對外：用網址（反向代理）、用對外 port（NAT）、或只開放防火牆。
 * 新增／編輯都走共用的 ConnectionDialog（鎖定「網際網路 → 這台」），三種模式同一條後端路徑。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import styles from "../ResourceDetailPage.module.scss";
import MIcon from "../../../../../components/MIcon";
import LoadingState from "../../../../../components/LoadingState/LoadingState";
import ConnectionDialog, { INTERNET_KEY } from "../../../../../components/ConnectionDialog/ConnectionDialog";
import useDialogPresence from "../../../../../hooks/useDialogPresence";
import { useToast } from "../../../../../hooks/useToast";
import { listPublishedServices, unpublishService } from "../../../../../services/firewall";

function modeMeta(mode) {
  if (mode === "domain") return { icon: "language", badge: "badge_info", labelKey: "PublishedServicesCard.modeDomain" };
  if (mode === "port_forward") return { icon: "swap_horiz", badge: "badge_ok", labelKey: "PublishedServicesCard.modePortForward" };
  return { icon: "shield", badge: "badge_muted", labelKey: "PublishedServicesCard.modeFirewallOnly" };
}

export default function PublishedServicesCard({ vmid, resource, canManage, refreshKey, onChanged }) {
  const { t } = useTranslation("personal");
  const toast = useToast();
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [modal, setModal] = useState(null); // { kind: "edit", service? } | { kind: "delete", service }
  const modalPresence = useDialogPresence(modal);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setServices((await listPublishedServices(vmid)) ?? []);
    } catch (err) {
      toast.error(err?.message ?? t("PublishedServicesCard.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [vmid, toast, t]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const running = resource?.status === "running";
  const createHint = useMemo(() => {
    if (!canManage) return t("PublishedServicesCard.ownerOnly");
    if (!running) return t("PublishedServicesCard.vmMustBeRunning");
    return "";
  }, [canManage, running, t]);

  function handleDialogDone(result) {
    toast.success(result?.kind === "replace" ? t("PublishedServicesCard.updated") : t("PublishedServicesCard.published"));
    setModal(null);
    load();
    onChanged?.();
  }

  async function handleDelete() {
    if (!modal?.service) return;
    setDeleting(true);
    try {
      await unpublishService(vmid, { port: modal.service.port, protocol: modal.service.protocol });
      toast.success(t("PublishedServicesCard.unpublished"));
      setModal(null);
      await load();
      onChanged?.();
    } catch (err) {
      toast.error(err?.message ?? t("PublishedServicesCard.deleteFailed"));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <div>
          <h2 className={styles.cardTitle}>
            <MIcon name="public" size={18} />
            {t("PublishedServicesCard.title")}
          </h2>
          <p className={styles.cardDesc}>{t("PublishedServicesCard.desc")}</p>
        </div>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.btnPrimary}
            disabled={Boolean(createHint)}
            title={createHint}
            onClick={() => setModal({ kind: "edit" })}
          >
            <MIcon name="add" size={16} />
            {t("PublishedServicesCard.add")}
          </button>
        </div>
      </div>
      <div className={styles.cardBody}>
        {createHint && (
          <p className={styles.rpHint}>
            <MIcon name="info" size={14} />
            {createHint}
          </p>
        )}
        {loading ? (
          <LoadingState text={t("PublishedServicesCard.loading")} />
        ) : services.length === 0 ? (
          <p className={styles.mutedText}>{t("PublishedServicesCard.empty")}</p>
        ) : (
          <div className={styles.rpList}>
            {services.map((svc) => {
              const meta = modeMeta(svc.mode);
              return (
                <div key={`${svc.port}/${svc.protocol}`} className={styles.rpItem}>
                  <div className={styles.rpMain}>
                    <span className={styles.rpDomain}>
                      {svc.mode === "domain"
                        ? svc.domain
                        : svc.mode === "port_forward"
                          ? t("PublishedServicesCard.forwardSummary", { external: svc.external_port, port: svc.port, protocol: svc.protocol })
                          : t("PublishedServicesCard.firewallOnlySummary", { port: svc.port, protocol: svc.protocol })}
                    </span>
                    <span className={styles.rpMeta}>
                      <span className={`${styles.badge} ${styles[meta.badge]}`}>
                        <MIcon name={meta.icon} size={11} /> {t(meta.labelKey)}
                      </span>
                      {t("PublishedServicesCard.internalPort", { port: svc.port, protocol: svc.protocol.toUpperCase() })}
                      {svc.mode === "domain" && svc.enable_https && (
                        <span className={`${styles.badge} ${styles.badge_ok}`}>
                          <MIcon name="lock" size={11} /> HTTPS
                        </span>
                      )}
                      {!svc.firewall_rule_present && (
                        <span className={`${styles.badge} ${styles.badge_err}`} title={t("PublishedServicesCard.missingRuleHint")}>
                          <MIcon name="warning" size={11} /> {t("PublishedServicesCard.missingRule")}
                        </span>
                      )}
                    </span>
                  </div>
                  {svc.url && (
                    <a className={styles.rpOpen} href={svc.url} target="_blank" rel="noreferrer">
                      <MIcon name="open_in_new" size={14} />
                      {t("PublishedServicesCard.open")}
                    </a>
                  )}
                  {canManage && (
                    <div className={styles.rpActions}>
                      <button
                        type="button"
                        className={styles.rpIconBtn}
                        title={t("PublishedServicesCard.edit")}
                        disabled={!running}
                        onClick={() => setModal({ kind: "edit", service: svc })}
                      >
                        <MIcon name="edit" size={16} />
                      </button>
                      <button
                        type="button"
                        className={`${styles.rpIconBtn} ${styles.rpIconBtnDanger}`}
                        title={t("PublishedServicesCard.unpublish")}
                        onClick={() => setModal({ kind: "delete", service: svc })}
                      >
                        <MIcon name="delete" size={16} />
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 新增／編輯：共用對話框自己 portal 到 body */}
      {modalPresence.item?.kind === "edit" && (
        <ConnectionDialog
          fixedVmid={vmid}
          fixedName={resource?.name}
          initialSource={INTERNET_KEY}
          service={modalPresence.item.service}
          closing={modalPresence.closing}
          onClose={() => setModal(null)}
          onDone={handleDialogDone}
          onChanged={() => { load(); onChanged?.(); }}
        />
      )}
      {/* 撤下確認：卡片有 overflow:hidden + backdrop-filter，要 portal 到 body 才能蓋住整頁 */}
      {modalPresence.item?.kind === "delete" &&
        createPortal(
          <div
            className={`${styles.modalOverlay} ${modalPresence.closing ? styles.modalOverlayOut : ""}`}
            onMouseDown={() => setModal(null)}
          >
            <div className={styles.modal} onMouseDown={(e) => e.stopPropagation()}>
              <h2 className={styles.modalTitle}>{t("PublishedServicesCard.unpublishTitle")}</h2>
              <p className={styles.modalDesc}>
                {t("PublishedServicesCard.unpublishDesc", {
                  target: modalPresence.item.service.domain
                    ?? `${modalPresence.item.service.port}/${modalPresence.item.service.protocol}`,
                })}
              </p>
              <div className={styles.modalActions}>
                <button type="button" className={styles.btnSecondary} onClick={() => setModal(null)}>
                  {t("PublishedServicesCard.cancel")}
                </button>
                <button type="button" className={styles.btnDanger} disabled={deleting} onClick={handleDelete}>
                  {deleting ? t("PublishedServicesCard.deleting") : t("PublishedServicesCard.unpublish")}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
