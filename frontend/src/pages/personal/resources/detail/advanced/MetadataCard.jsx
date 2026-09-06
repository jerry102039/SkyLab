/**
 * MetadataCard — 標籤與備註
 * 對應 Proxmox 的 tags 與 description；標籤會出現在資源列表並可篩選。
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import styles from "../ResourceDetailPage.module.scss";
import MIcon from "../../../../../components/MIcon";
import LoadingState from "../../../../../components/LoadingState/LoadingState";
import { useToast } from "../../../../../hooks/useToast";
import { ResourcesService } from "../../../../../services/resources";

const TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9_\-+.]{0,31}$/;
const MAX_TAGS = 16;

export default function MetadataCard({ vmid, canManage, onChanged }) {
  const { t } = useTranslation("personal");
  const toast = useToast();
  const [meta, setMeta] = useState(null);
  const [tags, setTags] = useState([]);
  const [description, setDescription] = useState("");
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await ResourcesService.getMetadata(vmid);
      setMeta(res);
      setTags(res.tags ?? []);
      setDescription(res.description ?? "");
    } catch (err) {
      toast.error(err?.message ?? t("MetadataCard.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [vmid, toast, t]);

  useEffect(() => {
    load();
  }, [load]);

  function commitDraft() {
    const value = draft.trim().toLowerCase();
    if (!value) return;
    if (!TAG_RE.test(value)) {
      toast.error(t("MetadataCard.invalidTag"));
      return;
    }
    if (tags.length >= MAX_TAGS) {
      toast.error(t("MetadataCard.tooManyTags", { max: MAX_TAGS }));
      return;
    }
    if (!tags.includes(value)) setTags((prev) => [...prev, value]);
    setDraft("");
  }

  function onDraftKeyDown(e) {
    if (e.key === "Enter" || e.key === "," || e.key === ";") {
      e.preventDefault();
      commitDraft();
    } else if (e.key === "Backspace" && !draft && tags.length) {
      setTags((prev) => prev.slice(0, -1));
    }
  }

  const changed = meta && (
    JSON.stringify(tags) !== JSON.stringify(meta.tags ?? [])
    || description.trim() !== (meta.description ?? "").trim()
  );

  async function save() {
    setBusy(true);
    try {
      const res = await ResourcesService.updateMetadata(vmid, { tags, description: description.trim() });
      setMeta(res);
      setTags(res.tags ?? []);
      setDescription(res.description ?? "");
      toast.success(t("MetadataCard.saved"));
      onChanged?.();
    } catch (err) {
      toast.error(err?.message ?? t("MetadataCard.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <div>
          <h2 className={styles.cardTitle}>
            <MIcon name="label" size={18} />
            {t("MetadataCard.title")}
          </h2>
          <p className={styles.cardDesc}>{t("MetadataCard.desc")}</p>
        </div>
        {canManage && (
          <div className={styles.headerActions}>
            <button type="button" className={styles.btnPrimary} disabled={!changed || busy} onClick={save}>
              {busy ? t("MetadataCard.saving") : t("MetadataCard.save")}
            </button>
          </div>
        )}
      </div>
      <div className={styles.cardBody}>
        {loading || !meta ? (
          <LoadingState text={t("MetadataCard.loading")} />
        ) : (
          <>
            <div className={styles.field}>
              <label htmlFor="meta-tag">{t("MetadataCard.tagsLabel")}</label>
              <div className={styles.chipList}>
                {tags.map((tag) => (
                  <span key={tag} className={styles.chip}>
                    {tag}
                    {canManage && (
                      <button
                        type="button"
                        className={styles.chipRemove}
                        aria-label={t("MetadataCard.removeTag", { tag })}
                        onClick={() => setTags((prev) => prev.filter((x) => x !== tag))}
                      >
                        <MIcon name="close" size={12} />
                      </button>
                    )}
                  </span>
                ))}
                {tags.length === 0 && !canManage && <span className={styles.mutedText}>{t("MetadataCard.noTags")}</span>}
              </div>
              {canManage && (
                <input
                  id="meta-tag"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={onDraftKeyDown}
                  onBlur={commitDraft}
                  placeholder={t("MetadataCard.tagPlaceholder")}
                />
              )}
              <span className={styles.fieldHint}>{t("MetadataCard.tagHint")}</span>
            </div>
            <div className={styles.field}>
              <label htmlFor="meta-desc">{t("MetadataCard.descriptionLabel")}</label>
              <textarea
                id="meta-desc"
                rows={4}
                value={description}
                maxLength={4000}
                readOnly={!canManage}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t("MetadataCard.descriptionPlaceholder")}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
