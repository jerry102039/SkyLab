import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import styles from "./ResourceDetailPage.module.scss";
import LoadingState from "../../../../components/LoadingState/LoadingState";
import { useAuth } from "../../../../contexts/AuthContext";
import { ResourcesService } from "../../../../services/resources";
import { SpecChangeRequestsService } from "../../../../services/specChangeRequests";
import { useToast } from "../../../../hooks/useToast";
import { focusInvalidField } from "../../../../utils/focusField";

export default function SpecificationsTab({ vmid }) {
  const { t } = useTranslation("personal");
  const toast = useToast();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin" || user?.is_superuser || false;

  const [config, setConfig] = useState(null);
  // 課堂與快速練習的機器照課程環境版本建立，規格不接受個別調整；
  // 後端一直有算 can_request_spec_change，只是沒有人讀。
  const [specFixed, setSpecFixed] = useState(false);
  const [cores, setCores] = useState(1);
  const [memory, setMemory] = useState(512);
  const [reason, setReason] = useState("");
  const [reasonInvalid, setReasonInvalid] = useState(false);
  const reasonRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  const loadConfig = async () => {
    try {
      const c = await ResourcesService.getConfig(vmid);
      setConfig(c);
      setCores(c.cpu_cores || 1);
      setMemory(c.memory_mb || 512);
    } catch {
      setError(true);
      return;
    }
    try {
      const resource = await ResourcesService.get(vmid);
      setSpecFixed(resource?.can_request_spec_change === false);
    } catch {
      setSpecFixed(false);
    }
  };

  useEffect(() => {
    loadConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vmid]);

  const handleSubmit = async () => {
    const hasChanges = cores !== config.cpu_cores || memory !== config.memory_mb;

    if (isAdmin) {
      setBusy(true);
      try {
        await ResourcesService.updateSpecDirect(vmid, {
          cores: cores !== config.cpu_cores ? cores : undefined,
          memory: memory !== config.memory_mb ? memory : undefined,
        });
        toast.success(t("SpecificationsTab.updateSuccess"));
        await loadConfig();
      } catch (e) {
        toast.error(e?.message ?? t("SpecificationsTab.updateFailed"));
      } finally {
        setBusy(false);
      }
      return;
    }

    if (reason.trim().length < 10) {
      setReasonInvalid(true);
      focusInvalidField(reasonRef.current);
      return;
    }
    if (!hasChanges) {
      toast.error(t("SpecificationsTab.noChanges"));
      return;
    }

    setBusy(true);
    try {
      await SpecChangeRequestsService.create({
        vmid,
        change_type: "combined",
        reason,
        requested_cpu: cores !== config.cpu_cores ? cores : undefined,
        requested_memory: memory !== config.memory_mb ? memory : undefined,
      });
      toast.success(t("SpecificationsTab.requestSubmitted"));
      setReason("");
    } catch (e) {
      toast.error(e?.message ?? t("SpecificationsTab.submitFailed"));
    } finally {
      setBusy(false);
    }
  };

  if (error) return <p className={styles.stateText}>{t("SpecificationsTab.loadFailed")}</p>;
  if (!config) return <LoadingState />;

  return (
    <div className={styles.tabStack}>
      <div className={styles.card}>
        <div className={styles.cardHeader}>
          <div>
            <h2 className={styles.cardTitle}>{t("SpecificationsTab.title")}</h2>
            <p className={styles.cardDesc}>
              {specFixed
                ? t("SpecificationsTab.descFixed")
                : isAdmin
                  ? t("SpecificationsTab.descAdmin")
                  : t("SpecificationsTab.descUser")}
            </p>
          </div>
        </div>
        <div className={styles.cardBody}>
          <div className={styles.formGrid}>
            <div className={styles.field}>
              <label htmlFor="spec-cores">{t("SpecificationsTab.cpuCoresLabel")}</label>
              <input
                id="spec-cores"
                type="number"
                min={1}
                max={32}
                value={cores}
                disabled={specFixed}
                onChange={(e) => setCores(Number.parseInt(e.target.value, 10) || 1)}
              />
              <span className={styles.fieldHint}>{t("SpecificationsTab.currentLabel", { value: config.cpu_cores })}</span>
            </div>
            <div className={styles.field}>
              <label htmlFor="spec-memory">{t("SpecificationsTab.memoryLabel")}</label>
              <input
                id="spec-memory"
                type="number"
                min={512}
                max={65536}
                step={512}
                value={memory}
                disabled={specFixed}
                onChange={(e) => setMemory(Number.parseInt(e.target.value, 10) || 512)}
              />
              <span className={styles.fieldHint}>{t("SpecificationsTab.currentMemoryLabel", { value: config.memory_mb })}</span>
            </div>
          </div>

          {!isAdmin && !specFixed && (
            <div className={`${styles.field} ${reasonInvalid ? styles.fieldInvalid : ""}`}>
              <label htmlFor="spec-reason">{t("SpecificationsTab.reasonLabel")}</label>
              <textarea
                id="spec-reason"
                ref={reasonRef}
                rows={4}
                placeholder={t("SpecificationsTab.reasonPlaceholder")}
                aria-invalid={reasonInvalid}
                value={reason}
                onChange={(e) => { setReason(e.target.value); setReasonInvalid(false); }}
              />
              <span className={styles.fieldHint}>{t("SpecificationsTab.reasonHint")}</span>
            </div>
          )}

          {!specFixed && <button
            type="button"
            className={styles.btnPrimary}
            disabled={busy}
            onClick={handleSubmit}
          >
            {busy ? t("SpecificationsTab.processing") : isAdmin ? t("SpecificationsTab.applyChanges") : t("SpecificationsTab.submitRequest")}
          </button>}
        </div>
      </div>

      {!isAdmin && !specFixed && (
        <div className={styles.card}>
          <div className={styles.cardHeader}>
            <h2 className={styles.cardTitle}>{t("SpecificationsTab.reviewProcessTitle")}</h2>
          </div>
          <div className={styles.cardBody}>
            <ol className={styles.stepList}>
              <li>{t("SpecificationsTab.step1")}</li>
              <li>{t("SpecificationsTab.step2")}</li>
              <li>{t("SpecificationsTab.step3")}</li>
            </ol>
          </div>
        </div>
      )}
    </div>
  );
}
