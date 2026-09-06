/**
 * FirewallCard — 這台 VM 的防火牆
 * 上半是以這台 VM 為中心的迷你拓撲，下半是 Proxmox 原始規則表。
 * SkyLab: 開頭的受管規則上鎖（由對外服務／拓撲頁管理），其餘可自行新增、停用、刪除。
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import styles from "../ResourceDetailPage.module.scss";
import MIcon from "../../../../../components/MIcon";
import LoadingState from "../../../../../components/LoadingState/LoadingState";
import useDialogPresence from "../../../../../hooks/useDialogPresence";
import { useToast } from "../../../../../hooks/useToast";
import { useConfirm } from "../../../../../components/ConfirmDialog/ConfirmProvider";
import {
  createVmRule,
  deleteVmRule,
  getVmOptions,
  getVmRules,
  getVmTopology,
  updateVmRule,
} from "../../../../../services/firewall";
import MiniTopology from "./MiniTopology";

const PROTOCOLS = ["tcp", "udp", "icmp"];

function RuleModal({ closing, loading, onClose, onSubmit }) {
  const { t } = useTranslation("personal");
  const [form, setForm] = useState({
    type: "in",
    action: "ACCEPT",
    proto: "tcp",
    dport: "",
    source: "",
    comment: "",
  });
  const set = (k, v) => setForm((prev) => ({ ...prev, [k]: v }));

  function submit(e) {
    e.preventDefault();
    const body = { type: form.type, action: form.action, enable: 1 };
    if (form.proto) body.proto = form.proto;
    if (form.dport.trim() && form.proto !== "icmp") body.dport = form.dport.trim();
    if (form.source.trim()) body[form.type === "in" ? "source" : "dest"] = form.source.trim();
    if (form.comment.trim()) body.comment = form.comment.trim();
    onSubmit(body);
  }

  return (
    <div className={`${styles.modalOverlay} ${closing ? styles.modalOverlayOut : ""}`} onMouseDown={onClose}>
      <form className={`${styles.modal} ${styles.modalWide}`} onSubmit={submit} onMouseDown={(e) => e.stopPropagation()}>
        <h2 className={styles.modalTitle}>{t("FirewallCard.addRuleTitle")}</h2>
        <p className={styles.modalDesc}>{t("FirewallCard.addRuleDesc")}</p>
        <div className={styles.formGrid}>
          <div className={styles.field}>
            <label htmlFor="fw-type">{t("FirewallCard.direction")}</label>
            <select id="fw-type" value={form.type} onChange={(e) => set("type", e.target.value)}>
              <option value="in">{t("FirewallCard.directionIn")}</option>
              <option value="out">{t("FirewallCard.directionOut")}</option>
            </select>
          </div>
          <div className={styles.field}>
            <label htmlFor="fw-action">{t("FirewallCard.action")}</label>
            <select id="fw-action" value={form.action} onChange={(e) => set("action", e.target.value)}>
              <option value="ACCEPT">{t("FirewallCard.actionAccept")}</option>
              <option value="DROP">{t("FirewallCard.actionDrop")}</option>
              <option value="REJECT">{t("FirewallCard.actionReject")}</option>
            </select>
          </div>
          <div className={styles.field}>
            <label htmlFor="fw-proto">{t("FirewallCard.protocol")}</label>
            <select id="fw-proto" value={form.proto} onChange={(e) => set("proto", e.target.value)}>
              {PROTOCOLS.map((p) => <option key={p} value={p}>{p.toUpperCase()}</option>)}
            </select>
          </div>
          <div className={styles.field}>
            <label htmlFor="fw-dport">{t("FirewallCard.port")}</label>
            <input
              id="fw-dport"
              value={form.dport}
              disabled={form.proto === "icmp"}
              onChange={(e) => set("dport", e.target.value)}
              placeholder={t("FirewallCard.portPlaceholder")}
            />
          </div>
        </div>
        <div className={styles.field}>
          <label htmlFor="fw-source">
            {form.type === "in" ? t("FirewallCard.sourceLabel") : t("FirewallCard.destLabel")}
          </label>
          <input
            id="fw-source"
            value={form.source}
            onChange={(e) => set("source", e.target.value)}
            placeholder={t("FirewallCard.sourcePlaceholder")}
          />
          <span className={styles.fieldHint}>{t("FirewallCard.sourceHint")}</span>
        </div>
        <div className={styles.field}>
          <label htmlFor="fw-comment">{t("FirewallCard.comment")}</label>
          <input
            id="fw-comment"
            value={form.comment}
            onChange={(e) => set("comment", e.target.value)}
            placeholder={t("FirewallCard.commentPlaceholder")}
          />
        </div>
        <div className={styles.modalActions}>
          <button type="button" className={styles.btnSecondary} onClick={onClose} disabled={loading}>
            {t("FirewallCard.cancel")}
          </button>
          <button type="submit" className={styles.btnPrimary} disabled={loading}>
            {loading ? t("FirewallCard.saving") : t("FirewallCard.addRule")}
          </button>
        </div>
      </form>
    </div>
  );
}

export default function FirewallCard({ vmid, canManage, refreshKey }) {
  const { t } = useTranslation("personal");
  const toast = useToast();
  const confirm = useConfirm();
  const [topology, setTopology] = useState(null);
  const [rules, setRules] = useState([]);
  const [options, setOptions] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const addPresence = useDialogPresence(showAdd);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [topo, ruleList, opts] = await Promise.all([
        getVmTopology(vmid).catch(() => null),
        getVmRules(vmid),
        getVmOptions(vmid).catch(() => null),
      ]);
      setTopology(topo);
      setRules(ruleList ?? []);
      setOptions(opts);
    } catch (err) {
      toast.error(err?.message ?? t("FirewallCard.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [vmid, toast, t]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  async function handleAdd(body) {
    setBusy(true);
    try {
      await createVmRule(vmid, body);
      toast.success(t("FirewallCard.ruleAdded"));
      setShowAdd(false);
      await load();
    } catch (err) {
      toast.error(err?.message ?? t("FirewallCard.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function handleToggle(rule) {
    setBusy(true);
    try {
      await updateVmRule(vmid, rule.pos, { enable: rule.enable === 0 ? 1 : 0 });
      await load();
    } catch (err) {
      toast.error(err?.message ?? t("FirewallCard.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(rule) {
    const ok = await confirm({
      title: t("FirewallCard.deleteRuleTitle"),
      message: t("FirewallCard.deleteRuleMessage", { pos: rule.pos }),
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await deleteVmRule(vmid, rule.pos);
      toast.success(t("FirewallCard.ruleDeleted"));
      await load();
    } catch (err) {
      toast.error(err?.message ?? t("FirewallCard.deleteFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <div>
          <h2 className={styles.cardTitle}>
            <MIcon name="security" size={18} />
            {t("FirewallCard.title")}
          </h2>
          <p className={styles.cardDesc}>{t("FirewallCard.desc")}</p>
        </div>
        <div className={styles.headerActions}>
          {options && (
            <>
              <span className={`${styles.badge} ${options.enable ? styles.badge_ok : styles.badge_muted}`}>
                {options.enable ? t("FirewallCard.enabled") : t("FirewallCard.disabled")}
              </span>
              <span className={`${styles.badge} ${styles.badge_muted}`} title={t("FirewallCard.policyHint")}>
                IN {options.policy_in} · OUT {options.policy_out}
              </span>
            </>
          )}
          {canManage && (
            <button type="button" className={styles.btnSecondary} onClick={() => setShowAdd(true)}>
              <MIcon name="add" size={16} />
              {t("FirewallCard.addRule")}
            </button>
          )}
        </div>
      </div>
      <div className={styles.cardBody}>
        {loading ? (
          <LoadingState text={t("FirewallCard.loading")} />
        ) : (
          <>
            {topology && (
              <>
                <MiniTopology topology={topology} />
                <div className={styles.flowLegend}>
                  <span><i className={`${styles.legendDot} ${styles.legendIn}`} />{t("FirewallCard.legendInbound")}</span>
                  <span><i className={`${styles.legendDot} ${styles.legendOut}`} />{t("FirewallCard.legendOutbound")}</span>
                  <span><i className={`${styles.legendDot} ${styles.legendPeer}`} />{t("FirewallCard.legendPeer")}</span>
                </div>
              </>
            )}

            {rules.length === 0 ? (
              <p className={styles.mutedText}>{t("FirewallCard.noRules")}</p>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th className={styles.th}>#</th>
                      <th className={styles.th}>{t("FirewallCard.direction")}</th>
                      <th className={styles.th}>{t("FirewallCard.protocol")}</th>
                      <th className={styles.th}>{t("FirewallCard.port")}</th>
                      <th className={styles.th}>{t("FirewallCard.sourceCol")}</th>
                      <th className={styles.th}>{t("FirewallCard.action")}</th>
                      <th className={styles.th}>{t("FirewallCard.noteCol")}</th>
                      {canManage && <th className={`${styles.th} ${styles.thRight}`}>{t("FirewallCard.actionsCol")}</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {rules.map((rule) => (
                      <tr key={rule.pos} className={`${styles.tr} ${rule.is_managed ? styles.lockedRow : ""}`}>
                        <td className={`${styles.td} ${styles.mutedCell}`}>{rule.pos}</td>
                        <td className={styles.td}>
                          <span className={`${styles.badge} ${rule.type === "in" ? styles.badge_info : styles.badge_muted}`}>
                            {rule.type === "in" ? t("FirewallCard.directionIn") : t("FirewallCard.directionOut")}
                          </span>
                        </td>
                        <td className={`${styles.td} ${styles.nowrapCell}`}>{rule.proto ? rule.proto.toUpperCase() : t("FirewallCard.any")}</td>
                        <td className={`${styles.td} ${styles.nowrapCell}`}>{rule.dport ?? t("FirewallCard.any")}</td>
                        <td className={`${styles.td} ${styles.monoText}`}>
                          {rule.type === "in" ? (rule.source ?? t("FirewallCard.anySource")) : (rule.dest ?? t("FirewallCard.anySource"))}
                        </td>
                        <td className={styles.td}>
                          <span className={`${styles.badge} ${rule.action === "ACCEPT" ? styles.badge_ok : styles.badge_err}`}>
                            {rule.action}
                          </span>
                          {rule.enable === 0 && (
                            <span className={`${styles.badge} ${styles.badge_muted}`}>{t("FirewallCard.ruleDisabled")}</span>
                          )}
                        </td>
                        <td className={`${styles.td} ${styles.detailCell}`}>
                          {rule.is_managed ? (
                            <span className={styles.hintLine} title={rule.comment ?? ""}>
                              <MIcon name="lock" size={12} />
                              {t("FirewallCard.managedByService")}
                            </span>
                          ) : (
                            rule.comment ?? "—"
                          )}
                        </td>
                        {canManage && (
                          <td className={`${styles.td} ${styles.tdRight}`}>
                            {rule.is_managed ? (
                              <span className={styles.mutedText}>{t("FirewallCard.locked")}</span>
                            ) : (
                              <>
                                <button
                                  type="button"
                                  className={styles.rpIconBtn}
                                  disabled={busy}
                                  title={rule.enable === 0 ? t("FirewallCard.enableRule") : t("FirewallCard.disableRule")}
                                  onClick={() => handleToggle(rule)}
                                >
                                  <MIcon name={rule.enable === 0 ? "toggle_off" : "toggle_on"} size={18} />
                                </button>
                                <button
                                  type="button"
                                  className={`${styles.rpIconBtn} ${styles.rpIconBtnDanger}`}
                                  disabled={busy}
                                  title={t("FirewallCard.deleteRule")}
                                  onClick={() => handleDelete(rule)}
                                >
                                  <MIcon name="delete" size={16} />
                                </button>
                              </>
                            )}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>

      {addPresence.open && (
        <RuleModal
          closing={addPresence.closing}
          loading={busy}
          onClose={() => setShowAdd(false)}
          onSubmit={handleAdd}
        />
      )}
    </div>
  );
}
