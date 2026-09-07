/**
 * PublishedServicesCard — 對外服務
 * 一列＝VM 裡的一個 port 怎麼對外：用網址（反向代理）、用對外 port（NAT）、或只開放防火牆。
 * 三種模式都走同一條後端路徑（先開防火牆，再套反向代理 / NAT）。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import styles from "../ResourceDetailPage.module.scss";
import MIcon from "../../../../../components/MIcon";
import LoadingState from "../../../../../components/LoadingState/LoadingState";
import useDialogPresence from "../../../../../hooks/useDialogPresence";
import { useToast } from "../../../../../hooks/useToast";
import {
  listPublishedServices,
  publishService,
  replacePublishedService,
  unpublishService,
} from "../../../../../services/firewall";
import { ReverseProxyService } from "../../../../../services/reverseProxy";
import {
  COMMON_PORTS,
  extractHostnamePrefix,
  findZoneByDomain,
} from "../../../../../components/ReverseProxyRuleModal/ReverseProxyRuleModal";

const MODES = ["domain", "port_forward", "firewall_only"];
const PROTOCOLS = ["tcp", "udp"];
const AVAILABILITY_DEBOUNCE_MS = 500;

function modeMeta(mode) {
  if (mode === "domain") return { icon: "language", badge: "badge_info", labelKey: "PublishedServicesCard.modeDomain" };
  if (mode === "port_forward") return { icon: "swap_horiz", badge: "badge_ok", labelKey: "PublishedServicesCard.modePortForward" };
  return { icon: "shield", badge: "badge_muted", labelKey: "PublishedServicesCard.modeFirewallOnly" };
}

/* ── 新增／編輯表單 ── */
function PublishServiceModal({ service, setupContext, closing, loading, onClose, onSubmit }) {
  const { t } = useTranslation("personal");
  const zones = setupContext?.zones ?? [];
  const domainReady = setupContext?.enabled !== false && zones.length > 0;
  const matchedZone = service?.domain ? findZoneByDomain(service.domain, zones) : null;
  const matchedCommon = service ? COMMON_PORTS.find((p) => p.value === String(service.port)) : null;

  const [mode, setMode] = useState(service?.mode ?? (domainReady ? "domain" : "port_forward"));
  const [port, setPort] = useState(matchedCommon?.value ?? (service ? "" : "80"));
  const [customPort, setCustomPort] = useState(service && !matchedCommon ? String(service.port) : "");
  const [useCustomPort, setUseCustomPort] = useState(Boolean(service && !matchedCommon));
  const [protocol, setProtocol] = useState(service?.protocol ?? "tcp");
  const [zoneId, setZoneId] = useState(matchedZone?.id ?? zones[0]?.id ?? "");
  const [prefix, setPrefix] = useState(
    service?.domain ? (matchedZone ? extractHostnamePrefix(service.domain, matchedZone.name) : service.domain) : "",
  );
  const [enableHttps, setEnableHttps] = useState(service?.enable_https ?? true);
  const [externalPort, setExternalPort] = useState(service?.external_port ? String(service.external_port) : "");
  const [availability, setAvailability] = useState(null); // { available, reason, message, checking }

  const effectivePort = useCustomPort ? customPort : port;
  const selectedZone = zones.find((z) => z.id === zoneId);
  const cleanPrefix = prefix.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
  const fullDomain = selectedZone ? (cleanPrefix ? `${cleanPrefix}.${selectedZone.name}` : selectedZone.name) : "";
  const domainUnchanged = Boolean(service?.domain) && fullDomain === service.domain;

  /* 網域即時檢查：不管是本系統建的還是 Cloudflare 上原本就有的，撞名都提醒 */
  useEffect(() => {
    if (mode !== "domain" || !fullDomain || domainUnchanged) {
      setAvailability(null);
      return undefined;
    }
    let cancelled = false;
    setAvailability({ checking: true });
    const timer = setTimeout(() => {
      ReverseProxyService.checkDomainAvailability(fullDomain)
        .then((res) => !cancelled && setAvailability(res))
        .catch(() => !cancelled && setAvailability(null));
    }, AVAILABILITY_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [mode, fullDomain, domainUnchanged]);

  function submit(e) {
    e.preventDefault();
    const parsedPort = Number(effectivePort);
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      setAvailability({ available: false, message: t("PublishedServicesCard.portRangeError") });
      return;
    }
    const payload = { port: parsedPort, protocol: mode === "domain" ? "tcp" : protocol, mode };
    if (mode === "domain") {
      if (!fullDomain) return;
      if (availability && availability.available === false) return;
      payload.domain = fullDomain;
      payload.enable_https = enableHttps;
    } else if (mode === "port_forward") {
      const ext = Number(externalPort);
      if (!Number.isInteger(ext) || ext < 1 || ext > 65535) {
        setAvailability({ available: false, message: t("PublishedServicesCard.externalPortRangeError") });
        return;
      }
      payload.external_port = ext;
    }
    onSubmit(payload);
  }

  const modeCards = MODES.filter((m) => m !== "domain" || domainReady || service?.mode === "domain");

  return (
    <div className={`${styles.modalOverlay} ${closing ? styles.modalOverlayOut : ""}`} onMouseDown={onClose}>
      <form className={`${styles.modal} ${styles.modalWide}`} onSubmit={submit} onMouseDown={(e) => e.stopPropagation()}>
        <h2 className={styles.modalTitle}>
          {service ? t("PublishedServicesCard.editTitle") : t("PublishedServicesCard.createTitle")}
        </h2>
        <p className={styles.modalDesc}>{t("PublishedServicesCard.modalDesc")}</p>

        <div className={styles.field}>
          <label>{t("PublishedServicesCard.modeLabel")}</label>
          <div className={styles.radioGroup}>
            {modeCards.map((m) => {
              const meta = modeMeta(m);
              return (
                <button
                  key={m}
                  type="button"
                  className={`${styles.radioOption} ${mode === m ? styles.radioOptionActive : ""}`}
                  onClick={() => setMode(m)}
                >
                  <strong><MIcon name={meta.icon} size={14} /> {t(meta.labelKey)}</strong>
                  <span>{t(`PublishedServicesCard.modeDesc_${m}`)}</span>
                </button>
              );
            })}
          </div>
          {!domainReady && (
            <span className={styles.fieldHint}>
              {setupContext?.reasons?.[0] ?? t("PublishedServicesCard.domainUnavailable")}
            </span>
          )}
        </div>

        <div className={styles.formGrid}>
          <div className={styles.field}>
            <label htmlFor="svc-port">{t("PublishedServicesCard.portLabel")}</label>
            {useCustomPort ? (
              <input
                id="svc-port"
                type="number"
                min={1}
                max={65535}
                value={customPort}
                onChange={(e) => setCustomPort(e.target.value)}
                placeholder={t("PublishedServicesCard.customPortPlaceholder")}
              />
            ) : (
              <select id="svc-port" value={port} onChange={(e) => setPort(e.target.value)}>
                {COMMON_PORTS.map((p) => (
                  <option key={p.value} value={p.value}>{t(p.labelKey, { ns: "components" })}</option>
                ))}
              </select>
            )}
            <button type="button" className={styles.ghostBtn} onClick={() => setUseCustomPort((v) => !v)}>
              {useCustomPort ? t("PublishedServicesCard.backToCommonPorts") : t("PublishedServicesCard.portNotListed")}
            </button>
          </div>
          <div className={styles.field}>
            <label htmlFor="svc-proto">{t("PublishedServicesCard.protocolLabel")}</label>
            <select
              id="svc-proto"
              value={mode === "domain" ? "tcp" : protocol}
              disabled={mode === "domain"}
              onChange={(e) => setProtocol(e.target.value)}
            >
              {PROTOCOLS.map((p) => <option key={p} value={p}>{p.toUpperCase()}</option>)}
            </select>
            {mode === "domain" && <span className={styles.fieldHint}>{t("PublishedServicesCard.domainTcpOnly")}</span>}
          </div>
        </div>

        {mode === "domain" && (
          <>
            <div className={styles.formGrid}>
              <div className={styles.field}>
                <label htmlFor="svc-prefix">{t("PublishedServicesCard.prefixLabel")}</label>
                <input
                  id="svc-prefix"
                  value={prefix}
                  onChange={(e) => setPrefix(e.target.value)}
                  placeholder={t("PublishedServicesCard.prefixPlaceholder")}
                />
              </div>
              <div className={styles.field}>
                <label htmlFor="svc-zone">{t("PublishedServicesCard.zoneLabel")}</label>
                <select id="svc-zone" value={zoneId} onChange={(e) => setZoneId(e.target.value)}>
                  {zones.map((z) => <option key={z.id} value={z.id}>.{z.name}</option>)}
                </select>
              </div>
            </div>
            {fullDomain && (
              <span
                className={`${styles.hintLine} ${
                  availability?.checking
                    ? ""
                    : availability?.available === false
                      ? styles.hintBad
                      : availability?.reason === "unverified"
                        ? styles.hintWarn
                        : availability?.available
                          ? styles.hintOk
                          : ""
                }`}
              >
                <MIcon
                  name={
                    availability?.checking
                      ? "hourglass_empty"
                      : availability?.available === false
                        ? "error"
                        : availability?.available
                          ? "check_circle"
                          : "language"
                  }
                  size={14}
                />
                {availability?.checking
                  ? t("PublishedServicesCard.checkingDomain", { domain: fullDomain })
                  : availability?.message
                    ? availability.message
                    : availability?.available
                      ? t("PublishedServicesCard.domainAvailable", { domain: fullDomain })
                      : domainUnchanged
                        ? t("PublishedServicesCard.domainUnchanged", { domain: fullDomain })
                        : fullDomain}
              </span>
            )}
            <label className={styles.checkRow}>
              <input type="checkbox" checked={enableHttps} onChange={(e) => setEnableHttps(e.target.checked)} />
              <span>{t("PublishedServicesCard.enableHttps")}</span>
            </label>
          </>
        )}

        {mode === "port_forward" && (
          <div className={styles.field}>
            <label htmlFor="svc-ext">{t("PublishedServicesCard.externalPortLabel")}</label>
            <input
              id="svc-ext"
              type="number"
              min={1}
              max={65535}
              value={externalPort}
              onChange={(e) => setExternalPort(e.target.value)}
              placeholder={t("PublishedServicesCard.externalPortPlaceholder")}
            />
            <span className={styles.fieldHint}>{t("PublishedServicesCard.externalPortHint")}</span>
          </div>
        )}

        {mode !== "domain" && availability?.message && (
          <span className={`${styles.hintLine} ${styles.hintBad}`}>
            <MIcon name="error" size={14} />
            {availability.message}
          </span>
        )}

        <div className={styles.modalActions}>
          <button type="button" className={styles.btnSecondary} onClick={onClose} disabled={loading}>
            {t("PublishedServicesCard.cancel")}
          </button>
          <button
            type="submit"
            className={styles.btnPrimary}
            disabled={loading || availability?.checking || (mode === "domain" && availability?.available === false)}
          >
            {loading
              ? t("PublishedServicesCard.saving")
              : service
                ? t("PublishedServicesCard.saveChanges")
                : t("PublishedServicesCard.publish")}
          </button>
        </div>
      </form>
    </div>
  );
}

/* ── 主卡片 ── */
export default function PublishedServicesCard({ vmid, resource, canManage, onChanged }) {
  const { t } = useTranslation("personal");
  const toast = useToast();
  const [services, setServices] = useState([]);
  const [setupContext, setSetupContext] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [modal, setModal] = useState(null); // { kind: "edit", service? } | { kind: "delete", service }
  const modalPresence = useDialogPresence(modal);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, ctx] = await Promise.all([
        listPublishedServices(vmid),
        ReverseProxyService.setupContext().catch(() => null),
      ]);
      setServices(list ?? []);
      if (ctx) setSetupContext(ctx);
    } catch (err) {
      toast.error(err?.message ?? t("PublishedServicesCard.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [vmid, toast, t]);

  useEffect(() => {
    load();
  }, [load]);

  const running = resource?.status === "running";
  const createHint = useMemo(() => {
    if (!canManage) return t("PublishedServicesCard.ownerOnly");
    if (!running) return t("PublishedServicesCard.vmMustBeRunning");
    return "";
  }, [canManage, running, t]);

  async function handleSubmit(payload) {
    setSaving(true);
    try {
      if (modal?.service) {
        await replacePublishedService(vmid, { port: modal.service.port, protocol: modal.service.protocol }, payload);
        toast.success(t("PublishedServicesCard.updated"));
      } else {
        await publishService(vmid, payload);
        toast.success(t("PublishedServicesCard.published"));
      }
      setModal(null);
      await load();
      onChanged?.();
    } catch (err) {
      toast.error(err?.message ?? t("PublishedServicesCard.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!modal?.service) return;
    setSaving(true);
    try {
      await unpublishService(vmid, { port: modal.service.port, protocol: modal.service.protocol });
      toast.success(t("PublishedServicesCard.unpublished"));
      setModal(null);
      await load();
      onChanged?.();
    } catch (err) {
      toast.error(err?.message ?? t("PublishedServicesCard.deleteFailed"));
    } finally {
      setSaving(false);
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

      {modalPresence.item?.kind === "edit" && (
        <PublishServiceModal
          service={modalPresence.item.service}
          setupContext={setupContext}
          closing={modalPresence.closing}
          loading={saving}
          onClose={() => setModal(null)}
          onSubmit={handleSubmit}
        />
      )}
      {modalPresence.item?.kind === "delete" && (
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
              <button type="button" className={styles.btnDanger} disabled={saving} onClick={handleDelete}>
                {saving ? t("PublishedServicesCard.deleting") : t("PublishedServicesCard.unpublish")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
