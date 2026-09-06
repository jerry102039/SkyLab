/**
 * TemplateConvertCard — 轉成範本（僅老師／管理員）
 * 把調好的機器直接轉成範本給學生申請。轉換會關機並把這台機器從資源列表移除。
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import styles from "../ResourceDetailPage.module.scss";
import MIcon from "../../../../../components/MIcon";
import useDialogPresence from "../../../../../hooks/useDialogPresence";
import { useToast } from "../../../../../hooks/useToast";
import { TemplatesService } from "../../../../../services/templates";

function ConvertModal({ resource, closing, loading, onClose, onSubmit }) {
  const { t } = useTranslation("personal");
  const [name, setName] = useState(resource?.name ?? "");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState("private");
  const [allowPasswordChange, setAllowPasswordChange] = useState(true);
  const [confirmName, setConfirmName] = useState("");
  const ready = name.trim().length > 0 && confirmName.trim() === resource?.name;

  function submit(e) {
    e.preventDefault();
    if (!ready) return;
    onSubmit({
      name: name.trim(),
      description: description.trim() || null,
      visibility,
      allow_password_change: allowPasswordChange,
    });
  }

  return (
    <div className={`${styles.modalOverlay} ${closing ? styles.modalOverlayOut : ""}`} onMouseDown={onClose}>
      <form className={`${styles.modal} ${styles.modalWide}`} onSubmit={submit} onMouseDown={(e) => e.stopPropagation()}>
        <h2 className={styles.modalTitle}>{t("TemplateConvertCard.modalTitle")}</h2>
        <p className={styles.modalDesc}>{t("TemplateConvertCard.modalDesc")}</p>
        <div className={styles.field}>
          <label htmlFor="tpl-name">{t("TemplateConvertCard.nameLabel")}</label>
          <input id="tpl-name" value={name} maxLength={255} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div className={styles.field}>
          <label htmlFor="tpl-desc">{t("TemplateConvertCard.descriptionLabel")}</label>
          <textarea id="tpl-desc" rows={3} maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t("TemplateConvertCard.descriptionPlaceholder")} />
        </div>
        <div className={styles.field}>
          <label htmlFor="tpl-vis">{t("TemplateConvertCard.visibilityLabel")}</label>
          <select id="tpl-vis" value={visibility} onChange={(e) => setVisibility(e.target.value)}>
            <option value="private">{t("TemplateConvertCard.visibilityPrivate")}</option>
            <option value="global">{t("TemplateConvertCard.visibilityGlobal")}</option>
          </select>
        </div>
        <label className={styles.checkRow}>
          <input type="checkbox" checked={allowPasswordChange} onChange={(e) => setAllowPasswordChange(e.target.checked)} />
          <span>{t("TemplateConvertCard.allowPasswordChange")}</span>
        </label>
        <div className={styles.field}>
          <label htmlFor="tpl-confirm">{t("TemplateConvertCard.confirmLabel", { name: resource?.name })}</label>
          <input id="tpl-confirm" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} placeholder={resource?.name} />
        </div>
        <div className={styles.modalActions}>
          <button type="button" className={styles.btnSecondary} onClick={onClose} disabled={loading}>
            {t("TemplateConvertCard.cancel")}
          </button>
          <button type="submit" className={styles.btnDanger} disabled={loading || !ready}>
            {loading ? t("TemplateConvertCard.converting") : t("TemplateConvertCard.convert")}
          </button>
        </div>
      </form>
    </div>
  );
}

export default function TemplateConvertCard({ vmid, resource }) {
  const { t } = useTranslation("personal");
  const toast = useToast();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const presence = useDialogPresence(open);

  async function handleSubmit(body) {
    setBusy(true);
    try {
      await TemplatesService.create({ source_vmid: vmid, ...body });
      toast.success(t("TemplateConvertCard.started"));
      setOpen(false);
      navigate("/templates");
    } catch (err) {
      toast.error(err?.message ?? t("TemplateConvertCard.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`${styles.card} ${styles.dangerZone}`}>
      <div className={styles.cardHeader}>
        <div>
          <h2 className={styles.cardTitle}>
            <MIcon name="library_add" size={18} />
            {t("TemplateConvertCard.title")}
          </h2>
          <p className={styles.cardDesc}>{t("TemplateConvertCard.desc")}</p>
        </div>
        <div className={styles.headerActions}>
          <button type="button" className={styles.btnDangerOutline} disabled={busy} onClick={() => setOpen(true)}>
            <MIcon name="library_add" size={16} />
            {t("TemplateConvertCard.convert")}
          </button>
        </div>
      </div>
      <div className={styles.cardBody}>
        <ol className={styles.stepList}>
          <li>{t("TemplateConvertCard.step1")}</li>
          <li>{t("TemplateConvertCard.step2")}</li>
          <li>{t("TemplateConvertCard.step3")}</li>
        </ol>
      </div>
      {presence.open && (
        <ConvertModal
          resource={resource}
          closing={presence.closing}
          loading={busy}
          onClose={() => setOpen(false)}
          onSubmit={handleSubmit}
        />
      )}
    </div>
  );
}
