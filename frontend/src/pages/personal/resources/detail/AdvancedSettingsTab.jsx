import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import styles from "./ResourceDetailPage.module.scss";
import MIcon from "../../../../components/MIcon";
import LoadingState from "../../../../components/LoadingState/LoadingState";
import ReverseProxyRuleModal from "../../../../components/ReverseProxyRuleModal/ReverseProxyRuleModal";
import { useAuth } from "../../../../contexts/AuthContext";
import { useToast } from "../../../../hooks/useToast";
import useDialogPresence from "../../../../hooks/useDialogPresence";
import { ReverseProxyService } from "../../../../services/reverseProxy";
import { ResourcesService } from "../../../../services/resources";

export default function AdvancedSettingsTab({ vmid }) {
  const { t } = useTranslation("personal");
  const { user } = useAuth();
  const toast = useToast();
  const isAdmin = user?.role === "admin" || user?.is_superuser === true;

  const [resource, setResource] = useState(null);
  const [rules, setRules] = useState([]);
  const [setupContext, setSetupContext] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [modal, setModal] = useState(null); // { kind: "rule", rule? } | { kind: "delete", rule }
  const modalPresence = useDialogPresence(modal);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [resourceRes, rulesRes, ctxRes] = await Promise.all([
        ResourcesService.get(vmid).catch(() => null),
        ReverseProxyService.listRules(),
        ReverseProxyService.setupContext().catch(() => null),
      ]);
      setResource(resourceRes);
      setRules((rulesRes ?? []).filter((r) => r.vmid === vmid));
      if (ctxRes) setSetupContext(ctxRes);
    } catch (err) {
      toast.error(err?.message ?? t("AdvancedSettingsTab.loadRulesFailed"));
    } finally {
      setLoading(false);
    }
  }, [vmid, toast, t]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const setupBlocked = setupContext?.enabled === false;
  const running = resource?.status === "running";
  const createDisabled = setupBlocked || !running;
  const createHint = setupBlocked
    ? setupContext?.reasons?.[0] ?? t("AdvancedSettingsTab.featureUnavailable")
    : !running
      ? t("AdvancedSettingsTab.vmMustBeRunning")
      : "";

  async function handleSubmitRule(payload) {
    setSaving(true);
    try {
      if (modal?.rule) {
        await ReverseProxyService.updateRule(modal.rule.id, payload);
        toast.success(t("AdvancedSettingsTab.ruleUpdated"));
      } else {
        await ReverseProxyService.createRule(payload);
        toast.success(t("AdvancedSettingsTab.ruleCreated"));
      }
      setModal(null);
      fetchData();
    } catch (err) {
      toast.error(err?.message ?? t("AdvancedSettingsTab.saveRuleFailed"));
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteRule() {
    if (!modal?.rule) return;
    setSaving(true);
    try {
      await ReverseProxyService.deleteRule(modal.rule.id);
      toast.success(t("AdvancedSettingsTab.ruleDeleted"));
      setModal(null);
      fetchData();
    } catch (err) {
      toast.error(err?.message ?? t("AdvancedSettingsTab.deleteRuleFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={styles.tabStack}>
      {/* 反向代理 */}
      <div className={styles.card}>
        <div className={styles.cardHeader}>
          <div>
            <h2 className={styles.cardTitle}>
              <MIcon name="swap_horiz" size={18} />
              {t("AdvancedSettingsTab.externalUrlTitle")}
            </h2>
            <p className={styles.cardDesc}>
              {t("AdvancedSettingsTab.externalUrlDesc")}
            </p>
          </div>
          <div className={styles.headerActions}>
            <button
              type="button"
              className={styles.btnPrimary}
              disabled={createDisabled}
              title={createHint}
              onClick={() => setModal({ kind: "rule" })}
            >
              <MIcon name="add" size={16} />
              {t("AdvancedSettingsTab.addUrl")}
            </button>
          </div>
        </div>
        <div className={styles.cardBody}>
          {loading ? (
            <LoadingState text={t("AdvancedSettingsTab.loadingRules")} />
          ) : (
            <>
              {createHint && (
                <p className={styles.rpHint}>
                  <MIcon name="info" size={14} />
                  {createHint}
                </p>
              )}
              {rules.length === 0 ? (
                <p className={styles.mutedText}>
                  {t("AdvancedSettingsTab.noRulesText")}
                </p>
              ) : (
                <div className={styles.rpList}>
                  {rules.map((rule) => (
                    <div key={rule.id} className={styles.rpItem}>
                      <div className={styles.rpMain}>
                        <span className={styles.rpDomain}>{rule.domain}</span>
                        <span className={styles.rpMeta}>
                          Port {rule.internal_port}
                          {rule.enable_https && (
                            <span className={`${styles.badge} ${styles.badge_ok}`}>
                              <MIcon name="lock" size={11} /> HTTPS
                            </span>
                          )}
                        </span>
                      </div>
                      <a
                        className={styles.rpOpen}
                        href={`${rule.enable_https ? "https" : "http"}://${rule.domain}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <MIcon name="open_in_new" size={14} />
                        {t("AdvancedSettingsTab.open")}
                      </a>
                      <div className={styles.rpActions}>
                        <button
                          type="button"
                          className={styles.rpIconBtn}
                          title={t("AdvancedSettingsTab.edit")}
                          onClick={() => setModal({ kind: "rule", rule })}
                        >
                          <MIcon name="edit" size={16} />
                        </button>
                        <button
                          type="button"
                          className={`${styles.rpIconBtn} ${styles.rpIconBtnDanger}`}
                          title={t("AdvancedSettingsTab.delete")}
                          onClick={() => setModal({ kind: "delete", rule })}
                        >
                          <MIcon name="delete" size={16} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* 其他進階功能 */}
      <div className={styles.card}>
        <div className={styles.cardHeader}>
          <div>
            <h2 className={styles.cardTitle}>{t("AdvancedSettingsTab.moreAdvancedTitle")}</h2>
            <p className={styles.cardDesc}>{t("AdvancedSettingsTab.moreAdvancedDesc")}</p>
          </div>
        </div>
        <div className={`${styles.cardBody} ${styles.comingSoon}`}>
          <MIcon name="construction" size={32} />
          <p>{t("AdvancedSettingsTab.comingSoon")}</p>
          <span className={styles.mutedText}>{t("AdvancedSettingsTab.bootOrderPlanned")}</span>
        </div>
      </div>

      {modalPresence.item?.kind === "rule" && (
        <ReverseProxyRuleModal
          rule={modalPresence.item.rule}
          setupContext={setupContext}
          isAdmin={isAdmin}
          fixedResource={{ vmid, name: resource?.name }}
          loading={saving}
          onClose={() => setModal(null)}
          onSubmit={handleSubmitRule}
          closing={modalPresence.closing}
        />
      )}
      {modalPresence.item?.kind === "delete" && (
        <div
          className={`${styles.modalOverlay} ${modalPresence.closing ? styles.modalOverlayOut : ""}`}
          onMouseDown={() => setModal(null)}
        >
          <div className={styles.modal} onMouseDown={(e) => e.stopPropagation()}>
            <h2 className={styles.modalTitle}>{t("AdvancedSettingsTab.deleteUrlTitle")}</h2>
            <p className={styles.modalDesc}>
              {t("AdvancedSettingsTab.deleteUrlDescPart1")}<strong>{modalPresence.item.rule.domain}</strong>{t("AdvancedSettingsTab.deleteUrlDescPart2")}
            </p>
            <div className={styles.modalActions}>
              <button
                type="button"
                className={styles.btnSecondary}
                onClick={() => setModal(null)}
              >
                {t("AdvancedSettingsTab.cancel")}
              </button>
              <button
                type="button"
                className={styles.btnDanger}
                disabled={saving}
                onClick={handleDeleteRule}
              >
                {saving ? t("AdvancedSettingsTab.deleting") : t("AdvancedSettingsTab.delete")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
