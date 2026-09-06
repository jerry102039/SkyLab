import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import styles from "./TemplatesPage.module.scss";
import MIcon from "../../../components/MIcon";
import { TemplatesService } from "../../../services/templates";
import { GpuService } from "../../../services/gpu";
import { useToast } from "../../../hooks/useToast";

const CORE_MIN = 1;
const MEMORY_MIN = 512;

const formatVram = (mb) =>
  mb >= 1024 ? `${Math.round(mb / 1024)}G` : `${mb}M`;

const gpuLabel = (gpu, t) => {
  const capacity = gpu.capacity_count || gpu.device_count;
  const parts = [];
  if (gpu.per_instance_vram_mb > 0) parts.push(t("TemplateCloneDialog.perUnit", { vram: formatVram(gpu.per_instance_vram_mb) }));
  else if (gpu.vram) parts.push(gpu.vram);
  const vram = parts.length ? `（${parts.join("，")}）` : "";
  return `${gpu.description || gpu.mapping_id}${vram} ${t("TemplateCloneDialog.availableCount", { available: gpu.available_count, capacity })}${gpu.available_count <= 0 ? t("TemplateCloneDialog.fullSuffix") : ""}`;
};

/** 從範本克隆開通（teacher/admin 可批量，student 固定單台） */
export default function TemplateCloneDialog({ template, canBatch, closing = false, onClose, onCloned }) {
  const { t } = useTranslation("resource");
  const toast = useToast();
  const [hostname, setHostname] = useState("");
  const [count, setCount] = useState("1");
  const [cores, setCores] = useState(template?.default_cores || 2);
  const [memory, setMemory] = useState(template?.default_memory || 2048);
  const [password, setPassword] = useState("");
  const [start, setStart] = useState(true);
  const [busy, setBusy] = useState(false);

  const needsGpu = Boolean(template?.requires_gpu) && template?.resource_type === "qemu";
  const [gpuOptions, setGpuOptions] = useState([]);
  const [gpuLoading, setGpuLoading] = useState(needsGpu);
  const [gpuMappingId, setGpuMappingId] = useState("");
  const [gpuProfile, setGpuProfile] = useState("");

  const allowPassword = template?.allow_password_change !== false;
  const coresMax = Math.max(8, template?.default_cores || 0);
  const memoryMax = Math.max(32768, template?.default_memory || 0);
  const coreTicks = [...new Set([1, 2, 4, 6, 8, coresMax])].sort((a, b) => a - b);
  const memoryTicks = [
    ...new Set([1024, 8192, 16384, 24576, 32768, memoryMax]),
  ].sort((a, b) => a - b);

  useEffect(() => {
    if (!needsGpu) return undefined;
    let cancelled = false;
    /* GPU 不可跨 PVE 連線：只列出與範本同叢集的 GPU */
    GpuService.listOptions(template?.node ? { node: template.node } : undefined)
      .then((res) => !cancelled && setGpuOptions(res ?? []))
      .catch(() => !cancelled && toast.error(t("TemplateCloneDialog.gpuListLoadFailed")))
      .finally(() => !cancelled && setGpuLoading(false));
    return () => {
      cancelled = true;
    };
  }, [needsGpu, toast, template?.node]);

  const selectedGpu = gpuOptions.find((g) => g.mapping_id === gpuMappingId);
  const gpuProfiles = selectedGpu?.profiles ?? [];
  const smallestCreatableProfile = gpuProfiles
    .filter((p) => p.creatable && p.vram_mb > 0)
    .reduce((min, p) => (min && min.vram_mb <= p.vram_mb ? min : p), null);

  const handleSubmit = async () => {
    if (allowPassword && password && password.length < 8) {
      toast.error(t("TemplateCloneDialog.passwordTooShort"));
      return;
    }
    if (needsGpu && !gpuMappingId) {
      toast.error(t("TemplateCloneDialog.gpuRequired"));
      return;
    }
    setBusy(true);
    try {
      const res = await TemplatesService.clone(template.id, {
        hostname: hostname.trim() || null,
        count: canBatch ? Math.max(1, Number(count) || 1) : 1,
        cores: Number(cores),
        memory: Number(memory),
        login_password: allowPassword && password ? password : null,
        gpu_mapping_id: needsGpu ? gpuMappingId : null,
        gpu_mdev_profile: needsGpu && gpuProfile ? gpuProfile : null,
        start,
      });
      toast.success(
        (res?.tasks?.length ?? 0) > 1
          ? t("TemplateCloneDialog.cloneQueuedMultiple", { count: res.tasks.length })
          : t("TemplateCloneDialog.cloneQueuedSingle"),
      );
      onCloned?.();
      onClose();
    } catch (e) {
      toast.error(e?.message ?? t("TemplateCloneDialog.cloneFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={`${styles.modalOverlay} ${closing ? styles.modalOverlayOut : ""}`}
      onClick={onClose}
    >
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <span className={styles.modalTitle}>
          <MIcon name="content_copy" size={20} />
          {t("TemplateCloneDialog.title", { name: template.name })}
        </span>
        <p className={styles.modalDesc}>
          {t("TemplateCloneDialog.description")}
        </p>

        <div className={styles.cloneGrid}>
          <div className={styles.field}>
            <label htmlFor="clone-hostname">{t("TemplateCloneDialog.hostnameLabel")}</label>
            <input
              id="clone-hostname"
              type="text"
              maxLength={63}
              placeholder={t("TemplateCloneDialog.hostnamePlaceholder")}
              value={hostname}
              onChange={(e) => setHostname(e.target.value)}
            />
          </div>
          {canBatch && (
            <div className={styles.field}>
              <label htmlFor="clone-count">{t("TemplateCloneDialog.countLabel")}</label>
              <input
                id="clone-count"
                type="number"
                min={1}
                max={50}
                value={count}
                onChange={(e) => setCount(e.target.value)}
              />
            </div>
          )}
        </div>

        <div className={styles.field}>
          <div className={styles.sliderLabelRow}>
            <label htmlFor="clone-cores">{t("TemplateCloneDialog.coresLabel")}</label>
            <span className={styles.sliderValue}>{t("TemplateCloneDialog.coresValue", { cores })}</span>
          </div>
          <input
            id="clone-cores"
            type="range"
            min={CORE_MIN}
            max={coresMax}
            step={1}
            className={styles.slider}
            value={cores}
            onChange={(e) => setCores(Number(e.target.value))}
          />
          <div className={styles.sliderTicks}>
            {coreTicks.map((v) => (
              <span key={v} style={{ left: `${((v - CORE_MIN) / (coresMax - CORE_MIN)) * 100}%` }}>
                {v}
              </span>
            ))}
          </div>
        </div>

        <div className={styles.field}>
          <div className={styles.sliderLabelRow}>
            <label htmlFor="clone-memory">{t("TemplateCloneDialog.memoryLabel")}</label>
            <span className={styles.sliderValue}>{(memory / 1024).toFixed(1)} GB</span>
          </div>
          <input
            id="clone-memory"
            type="range"
            min={MEMORY_MIN}
            max={memoryMax}
            step={512}
            className={styles.slider}
            value={memory}
            onChange={(e) => setMemory(Number(e.target.value))}
          />
          <div className={styles.sliderTicks}>
            {memoryTicks.map((v) => (
              <span
                key={v}
                style={{ left: `${((v - MEMORY_MIN) / (memoryMax - MEMORY_MIN)) * 100}%` }}
              >
                {v >= 1024 ? `${Math.round(v / 1024)}GB` : `${v}MB`}
              </span>
            ))}
          </div>
        </div>

        <div className={styles.field}>
          <label>{t("TemplateCloneDialog.diskLabel")}</label>
          <div className={styles.diskFixed}>
            <MIcon name="lock" size={15} />
            {template.default_disk
              ? t("TemplateCloneDialog.diskFixedWithSize", { size: template.default_disk })
              : t("TemplateCloneDialog.diskFixedDefault")}
          </div>
        </div>

        {allowPassword ? (
          <div className={styles.field}>
            <label htmlFor="clone-password">{t("TemplateCloneDialog.passwordLabel")}</label>
            <input
              id="clone-password"
              type="password"
              maxLength={64}
              placeholder={t("TemplateCloneDialog.passwordPlaceholder")}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
        ) : (
          <div className={styles.policyNote}>
            <MIcon name="lock" size={15} />
            {t("TemplateCloneDialog.passwordLockedNote")}
          </div>
        )}

        {needsGpu && (
          <>
            <div className={styles.field}>
              <label htmlFor="clone-gpu">{t("TemplateCloneDialog.gpuLabel")}</label>
              <select
                id="clone-gpu"
                value={gpuMappingId}
                disabled={gpuLoading}
                onChange={(e) => {
                  setGpuMappingId(e.target.value);
                  setGpuProfile("");
                }}
              >
                <option value="">
                  {gpuLoading ? t("TemplateCloneDialog.gpuLoadingOption") : t("TemplateCloneDialog.gpuSelectOption")}
                </option>
                {gpuOptions.map((gpu) => (
                  <option
                    key={gpu.mapping_id}
                    value={gpu.mapping_id}
                    disabled={gpu.available_count <= 0}
                  >
                    {gpuLabel(gpu, t)}
                  </option>
                ))}
              </select>
              {!gpuLoading && gpuOptions.length === 0 && (
                <span className={styles.fieldWarn}>
                  {t("TemplateCloneDialog.gpuNoneWarning")}
                </span>
              )}
            </div>
            {gpuProfiles.length > 0 && (
              <div className={styles.field}>
                <label htmlFor="clone-gpu-profile">{t("TemplateCloneDialog.gpuProfileLabel")}</label>
                <select
                  id="clone-gpu-profile"
                  value={gpuProfile || smallestCreatableProfile?.mdev_type || ""}
                  onChange={(e) => setGpuProfile(e.target.value)}
                >
                  {!smallestCreatableProfile && (
                    <option value="" disabled>{t("TemplateCloneDialog.gpuProfileNoneOption")}</option>
                  )}
                  {gpuProfiles.map((p) => (
                    <option key={p.mdev_type} value={p.mdev_type} disabled={!p.creatable}>
                      {`${p.name || p.mdev_type} — ${formatVram(p.vram_mb)}`}
                      {p.creatable ? "" : t("TemplateCloneDialog.gpuProfileInsufficientSuffix")}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </>
        )}

        <label className={styles.checkLine}>
          <input
            type="checkbox"
            checked={start}
            onChange={(e) => setStart(e.target.checked)}
          />
          {t("TemplateCloneDialog.autoStartLabel")}
        </label>

        <div className={styles.modalActions}>
          <button type="button" className={styles.btnSecondary} onClick={onClose}>
            {t("TemplateCloneDialog.cancel")}
          </button>
          <button
            type="button"
            className={styles.btnPrimary}
            disabled={busy || (needsGpu && !gpuMappingId)}
            onClick={handleSubmit}
          >
            <MIcon name="content_copy" size={14} />
            {busy ? t("TemplateCloneDialog.submitting") : t("TemplateCloneDialog.submit")}
          </button>
        </div>
      </div>
    </div>
  );
}
