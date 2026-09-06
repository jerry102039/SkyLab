import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../../../contexts/AuthContext";
import styles from "./ResourceDetailPage.module.scss";
import MIcon from "../../../../components/MIcon";
import LoadingState from "../../../../components/LoadingState/LoadingState";
import { ResourcesService } from "../../../../services/resources";
import { downloadBlob } from "../../../../services/api";
import { useToast } from "../../../../hooks/useToast";

const STATUS_BADGE = {
  running: { labelKey: "OverviewTab.statusRunning", cls: "badge_ok" },
  stopped: { labelKey: "OverviewTab.statusStopped", cls: "badge_muted" },
  paused:  { labelKey: "OverviewTab.statusPaused", cls: "badge_muted" },
};

export default function OverviewTab({ vmid }) {
  const { t } = useTranslation("personal");
  const toast = useToast();
  const { user } = useAuth();
  /* VMID 是系統內部編號，僅管理員／老師看得到 */
  const showVmid = user?.is_superuser || user?.role === "admin" || user?.role === "teacher";
  const [resource, setResource] = useState(null);
  const [sshKey, setSshKey] = useState(null);
  const [showPrivateKey, setShowPrivateKey] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [copied, setCopied] = useState("");
  const [manual, setManual] = useState(null);
  const [downloadingId, setDownloadingId] = useState(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    ResourcesService.get(vmid)
      .then((r) => {
        if (cancelled) return;
        setResource(r);
        if (r.ssh_public_key || r.has_login_password) {
          ResourcesService.getSshKey(vmid)
            .then((k) => !cancelled && setSshKey(k))
            .catch(() => {});
        }
      })
      .catch(() => !cancelled && setError(true));
    // 來源範本手冊（非克隆機或無附件時 count=0，不顯示區塊）
    ResourcesService.getTemplateManual(vmid)
      .then((m) => !cancelled && setManual(m))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [vmid]);

  const downloadManual = async (attachment) => {
    setDownloadingId(attachment.id);
    try {
      const blob = await ResourcesService.downloadTemplateManual(vmid, attachment.id);
      downloadBlob(blob, attachment.filename);
    } catch (e) {
      toast.error(e?.message ?? t("OverviewTab.downloadFailed"));
    } finally {
      setDownloadingId(null);
    }
  };

  const copy = async (text, label) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(""), 2000);
    } catch {
      toast.error(t("OverviewTab.copyFailed"));
    }
  };

  if (error) return <p className={styles.stateText}>{t("OverviewTab.loadFailed")}</p>;
  if (!resource) return <LoadingState />;

  const badge = STATUS_BADGE[resource.status] ?? {
    labelKey: null,
    label: resource.status,
    cls: "badge_muted",
  };

  return (
    <div className={styles.tabStack}>
      {/* 使用手冊（克隆機來源範本附件） */}
      {(manual?.count ?? 0) > 0 && (
        <div className={styles.card}>
          <div className={styles.cardHeader}>
            <div>
              <h2 className={styles.cardTitle}>
                <MIcon name="description" size={18} />
                {t("OverviewTab.manualTitle")}
              </h2>
              <p className={styles.cardDesc}>
                {t("OverviewTab.manualDesc", { name: manual.template_name })}
              </p>
            </div>
          </div>
          <div className={styles.cardBody}>
            <div className={styles.manualList}>
              {manual.data.map((a) => (
                <div key={a.id} className={styles.manualItem}>
                  <MIcon name="description" size={15} />
                  <span className={styles.manualName}>{a.filename}</span>
                  <button
                    type="button"
                    className={styles.manualBtn}
                    disabled={downloadingId === a.id}
                    onClick={() => downloadManual(a)}
                  >
                    <MIcon name="download" size={15} />
                    {downloadingId === a.id ? t("OverviewTab.downloading") : t("OverviewTab.download")}
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 基本資訊 */}
      <div className={styles.card}>
        <div className={styles.cardHeader}>
          <div>
            <h2 className={styles.cardTitle}>
              <MIcon name="dns" size={18} />
              {t("OverviewTab.basicInfoTitle")}
            </h2>
            <p className={styles.cardDesc}>{t("OverviewTab.basicInfoDesc")}</p>
          </div>
        </div>
        <div className={`${styles.cardBody} ${styles.factGrid}`}>
          {showVmid && (
            <div className={styles.fact}>
              <span className={styles.factLabel}>{t("OverviewTab.idLabel")}</span>
              <span className={styles.factValue}>{resource.vmid}</span>
            </div>
          )}
          <div className={styles.fact}>
            <span className={styles.factLabel}>{t("OverviewTab.nameLabel")}</span>
            <span className={styles.factValue}>{resource.name}</span>
          </div>
          <div className={styles.fact}>
            <span className={styles.factLabel}>{t("OverviewTab.typeLabel")}</span>
            <span className={styles.factValue}>{String(resource.type).toUpperCase()}</span>
          </div>
          <div className={styles.fact}>
            <span className={styles.factLabel}>{t("OverviewTab.statusLabel")}</span>
            <span className={`${styles.badge} ${styles[badge.cls]}`}>{badge.labelKey ? t(badge.labelKey) : badge.label}</span>
          </div>
          <div className={styles.fact}>
            <span className={styles.factLabel}>{t("OverviewTab.nodeLabel")}</span>
            <span className={styles.factValue}>{resource.node}</span>
          </div>
          {resource.ip_address && (
            <div className={styles.fact}>
              <span className={styles.factLabel}>{t("OverviewTab.ipLabel")}</span>
              <span className={`${styles.factValue} ${styles.monoText}`}>
                {resource.ip_address}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* 資源配置 */}
      <div className={styles.card}>
        <div className={styles.cardHeader}>
          <div>
            <h2 className={styles.cardTitle}>
              <MIcon name="memory" size={18} />
              {t("OverviewTab.resourceConfigTitle")}
            </h2>
            <p className={styles.cardDesc}>{t("OverviewTab.resourceConfigDesc")}</p>
          </div>
        </div>
        <div className={`${styles.cardBody} ${styles.specGrid}`}>
          <div className={styles.specTile}>
            <span className={styles.specIcon}>
              <MIcon name="memory" size={22} />
            </span>
            <div>
              <span className={styles.factLabel}>CPU</span>
              <span className={styles.specValue}>{resource.maxcpu}</span>
              <span className={styles.mutedText}>{t("OverviewTab.coresUnit")}</span>
            </div>
          </div>
          <div className={styles.specTile}>
            <span className={styles.specIcon}>
              <MIcon name="sd_card" size={22} />
            </span>
            <div>
              <span className={styles.factLabel}>{t("MonitoringTab.memory")}</span>
              <span className={styles.specValue}>
                {resource.maxmem ? (resource.maxmem / 1024 ** 3).toFixed(2) : "N/A"}
              </span>
              <span className={styles.mutedText}>GB</span>
            </div>
          </div>
        </div>
      </div>

      {/* 環境資訊 */}
      {(resource.environment_type || resource.os_info || resource.expiry_date) && (
        <div className={styles.card}>
          <div className={styles.cardHeader}>
            <div>
              <h2 className={styles.cardTitle}>
                <MIcon name="event" size={18} />
                {t("OverviewTab.envInfoTitle")}
              </h2>
              <p className={styles.cardDesc}>{t("OverviewTab.envInfoDesc")}</p>
            </div>
          </div>
          <div className={`${styles.cardBody} ${styles.factGrid}`}>
            {resource.environment_type && (
              <div className={styles.fact}>
                <span className={styles.factLabel}>{t("OverviewTab.envTypeLabel")}</span>
                <span className={styles.factValue}>{resource.environment_type}</span>
              </div>
            )}
            {resource.os_info && (
              <div className={styles.fact}>
                <span className={styles.factLabel}>{t("OverviewTab.osLabel")}</span>
                <span className={styles.factValue}>{resource.os_info}</span>
              </div>
            )}
            {resource.expiry_date && (
              <div className={styles.fact}>
                <span className={styles.factLabel}>{t("OverviewTab.expiryLabel")}</span>
                <span className={styles.factValue}>
                  {new Date(resource.expiry_date).toLocaleDateString("zh-TW")}
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 登入密碼 */}
      {sshKey?.login_password && (
        <div className={styles.card}>
          <div className={styles.cardHeader}>
            <div>
              <h2 className={styles.cardTitle}>
                <MIcon name="password" size={18} />
                {t("OverviewTab.loginPasswordTitle")}
              </h2>
              <p className={styles.cardDesc}>
                {t("OverviewTab.loginPasswordDesc")}
              </p>
            </div>
          </div>
          <div className={styles.cardBody}>
            <div className={styles.keyBlock}>
              <div className={styles.keyHead}>
                <span className={styles.factLabel}>{t("OverviewTab.passwordLabel")}</span>
                <div className={styles.keyActions}>
                  <button
                    type="button"
                    className={styles.ghostBtn}
                    onClick={() => setShowPassword((v) => !v)}
                  >
                    <MIcon name={showPassword ? "visibility_off" : "visibility"} size={14} />
                    {showPassword ? t("OverviewTab.hide") : t("OverviewTab.show")}
                  </button>
                  <button
                    type="button"
                    className={styles.ghostBtn}
                    onClick={() => copy(sshKey.login_password, "password")}
                  >
                    <MIcon name={copied === "password" ? "check" : "content_copy"} size={14} />
                    {copied === "password" ? t("OverviewTab.copied") : t("OverviewTab.copy")}
                  </button>
                </div>
              </div>
              {showPassword ? (
                <pre className={styles.keyPre}>{sshKey.login_password}</pre>
              ) : (
                <div className={styles.keyHidden}>{t("OverviewTab.passwordHiddenHint")}</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* SSH 金鑰 */}
      {resource.ssh_public_key && (
        <div className={styles.card}>
          <div className={styles.cardHeader}>
            <div>
              <h2 className={styles.cardTitle}>
                <MIcon name="key" size={18} />
                {t("OverviewTab.sshKeyTitle")}
              </h2>
              <p className={styles.cardDesc}>{t("OverviewTab.sshKeyDesc")}</p>
            </div>
          </div>
          <div className={styles.cardBody}>
            <div className={styles.keyBlock}>
              <div className={styles.keyHead}>
                <span className={styles.factLabel}>{t("OverviewTab.publicKeyLabel")}</span>
                <button
                  type="button"
                  className={styles.ghostBtn}
                  onClick={() => copy(resource.ssh_public_key, "public")}
                >
                  <MIcon name={copied === "public" ? "check" : "content_copy"} size={14} />
                  {copied === "public" ? t("OverviewTab.copied") : t("OverviewTab.copy")}
                </button>
              </div>
              <pre className={styles.keyPre}>{resource.ssh_public_key}</pre>
            </div>

            {sshKey?.ssh_private_key && (
              <div className={styles.keyBlock}>
                <div className={styles.keyHead}>
                  <span className={styles.factLabel}>{t("OverviewTab.privateKeyLabel")}</span>
                  <div className={styles.keyActions}>
                    <button
                      type="button"
                      className={styles.ghostBtn}
                      onClick={() => setShowPrivateKey((v) => !v)}
                    >
                      <MIcon name={showPrivateKey ? "visibility_off" : "visibility"} size={14} />
                      {showPrivateKey ? t("OverviewTab.hide") : t("OverviewTab.show")}
                    </button>
                    <button
                      type="button"
                      className={styles.ghostBtn}
                      onClick={() => copy(sshKey.ssh_private_key, "private")}
                    >
                      <MIcon name={copied === "private" ? "check" : "content_copy"} size={14} />
                      {copied === "private" ? t("OverviewTab.copied") : t("OverviewTab.copy")}
                    </button>
                    <button
                      type="button"
                      className={styles.ghostBtn}
                      onClick={() => {
                        const blob = new Blob([sshKey.ssh_private_key], { type: "text/plain" });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement("a");
                        a.href = url;
                        a.download = `id_ed25519_vm${vmid}`;
                        a.click();
                        URL.revokeObjectURL(url);
                      }}
                    >
                      <MIcon name="download" size={14} />
                      {t("OverviewTab.download")}
                    </button>
                  </div>
                </div>
                {showPrivateKey ? (
                  <pre className={styles.keyPre}>{sshKey.ssh_private_key}</pre>
                ) : (
                  <div className={styles.keyHidden}>{t("OverviewTab.privateKeyHiddenHint")}</div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
