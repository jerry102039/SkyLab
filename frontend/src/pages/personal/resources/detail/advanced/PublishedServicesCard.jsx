/**
 * PublishedServicesCard — 對外服務
 * 以「這台機器有哪些網址」為主：每列一個反向代理網域（可直接點開），
 * 其他對外入口（對外 port 轉發、僅開放防火牆）縮成下方的小區塊。
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

const serviceKey = (svc) => `${svc.port}/${svc.protocol}`;

export default function PublishedServicesCard({ vmid, resource, canManage, refreshKey, onChanged }) {
  const { t } = useTranslation("personal");
  const toast = useToast();
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  // { kind: "edit", service?, mode? } | { kind: "delete", service }
  const [modal, setModal] = useState(null);
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

  const domains = services.filter((s) => s.mode === "domain");
  const others = services.filter((s) => s.mode !== "domain");

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

  const actions = (svc) =>
    canManage && (
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
    );

  const missingRuleBadge = (svc) =>
    !svc.firewall_rule_present && (
      <span className={`${styles.badge} ${styles.badge_err}`} title={t("PublishedServicesCard.missingRuleHint")}>
        <MIcon name="warning" size={11} /> {t("PublishedServicesCard.missingRule")}
      </span>
    );

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
            onClick={() => setModal({ kind: "edit", mode: "domain" })}
          >
            <MIcon name="add" size={16} />
            {t("PublishedServicesCard.addDomain")}
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
        ) : (
          <>
            {/* 這台機器的網址 */}
            {domains.length === 0 ? (
              <p className={styles.mutedText}>{t("PublishedServicesCard.noDomains")}</p>
            ) : (
              <div className={styles.rpList}>
                {domains.map((svc) => (
                  <div key={serviceKey(svc)} className={styles.rpItem}>
                    <MIcon name="language" size={20} className={styles.rpLeadIcon} />
                    <div className={styles.rpMain}>
                      {svc.url ? (
                        <a className={styles.rpDomainLink} href={svc.url} target="_blank" rel="noreferrer">
                          {svc.domain}
                          <MIcon name="open_in_new" size={13} />
                        </a>
                      ) : (
                        <span className={styles.rpDomain}>{svc.domain}</span>
                      )}
                      <span className={styles.rpMeta}>
                        <span className={`${styles.badge} ${svc.enable_https ? styles.badge_ok : styles.badge_muted}`}>
                          <MIcon name={svc.enable_https ? "lock" : "lock_open"} size={11} /> {svc.enable_https ? "HTTPS" : "HTTP"}
                        </span>
                        {t("PublishedServicesCard.domainTarget", { port: svc.port })}
                        {missingRuleBadge(svc)}
                      </span>
                    </div>
                    {actions(svc)}
                  </div>
                ))}
              </div>
            )}

            {/* 其他對外入口：對外 port 轉發、僅開放防火牆 */}
            <div className={styles.rpSubSection}>
              <div className={styles.rpSubHeader}>
                <span className={styles.rpSubTitle}>
                  <MIcon name="swap_horiz" size={14} />
                  {t("PublishedServicesCard.othersTitle")}
                </span>
                {canManage && (
                  <button
                    type="button"
                    className={styles.ghostBtn}
                    disabled={Boolean(createHint)}
                    title={createHint}
                    onClick={() => setModal({ kind: "edit", mode: "port_forward" })}
                  >
                    <MIcon name="add" size={14} />
                    {t("PublishedServicesCard.addOther")}
                  </button>
                )}
              </div>
              {others.length === 0 ? (
                <p className={styles.rpSubEmpty}>{t("PublishedServicesCard.noOthers")}</p>
              ) : (
                <div className={styles.rpCompactList}>
                  {others.map((svc) => (
                    <div key={serviceKey(svc)} className={styles.rpCompactItem}>
                      <MIcon name={svc.mode === "port_forward" ? "swap_horiz" : "shield"} size={16} className={styles.rpCompactIcon} />
                      <span className={styles.rpCompactText}>
                        {svc.mode === "port_forward"
                          ? t("PublishedServicesCard.forwardSummary", { external: svc.external_port, port: svc.port, protocol: svc.protocol })
                          : t("PublishedServicesCard.firewallOnlySummary", { port: svc.port, protocol: svc.protocol })}
                        <span className={styles.rpCompactMode}>
                          {svc.mode === "port_forward" ? t("PublishedServicesCard.modePortForward") : t("PublishedServicesCard.modeFirewallOnly")}
                        </span>
                        {missingRuleBadge(svc)}
                      </span>
                      {actions(svc)}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* 新增／編輯：共用對話框自己 portal 到 body */}
      {modalPresence.item?.kind === "edit" && (
        <ConnectionDialog
          fixedVmid={vmid}
          fixedName={resource?.name}
          initialSource={INTERNET_KEY}
          initialMode={modalPresence.item.mode}
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
