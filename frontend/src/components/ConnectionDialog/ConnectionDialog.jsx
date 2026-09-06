/**
 * ConnectionDialog
 * 建立防火牆連線的 Modal。
 *
 * 模式：
 * - 網際網路 → VM：入站（Port Forwarding 或 Firewall Only）
 * - VM → 網際網路：出站（直接確認，無需設定 port）
 * - VM → VM：指定 port + 方向
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import styles from "./ConnectionDialog.module.scss";
import MIcon from "../MIcon";
import { focusInvalidField } from "../../utils/focusField";

const PROTOCOLS = ["tcp", "udp", "icmp", "icmpv6", "sctp"];

let _uid = 0;
function uid() { return ++_uid; }

function newPortRow() {
  return { id: uid(), port: "", protocol: "tcp" };
}

function newForwardRow() {
  return { id: uid(), externalPort: "", internalPort: "", protocol: "tcp" };
}

/* ── 入站模式：純防火牆 ── */
function FirewallOnlyForm({ rows, setRows, invalid }) {
  const { t } = useTranslation("components");
  const add = () => setRows((r) => [...r, newPortRow()]);
  const remove = (id) => setRows((r) => r.filter((x) => x.id !== id));
  const update = (id, key, val) =>
    setRows((r) => r.map((x) => (x.id === id ? { ...x, [key]: val } : x)));

  return (
    <div className={styles.portSection}>
      <p className={styles.modeDesc}>{t("ConnectionDialog.firewallOnlyDesc")}</p>
      {rows.map((row) => (
        <div key={row.id} className={styles.portRow}>
          <input
            type="number"
            min="1"
            max="65535"
            placeholder="Port"
            value={row.port}
            onChange={(e) => update(row.id, "port", e.target.value)}
            aria-invalid={Boolean(invalid && !row.port)}
            className={`${styles.portInput} ${invalid && !row.port ? styles.portInputInvalid : ""}`}
          />
          <select
            value={row.protocol}
            onChange={(e) => update(row.id, "protocol", e.target.value)}
            className={styles.protoSelect}
          >
            {PROTOCOLS.map((p) => <option key={p}>{p}</option>)}
          </select>
          <button type="button" className={styles.removeBtn} onClick={() => remove(row.id)}>
            <MIcon name="remove" size={16} />
          </button>
        </div>
      ))}
      <button type="button" className={styles.addBtn} onClick={add}>
        <MIcon name="add" size={16} />
        {t("ConnectionDialog.addPort")}
      </button>
    </div>
  );
}

/* ── 入站模式：Port Forwarding ── */
function PortForwardForm({ rows, setRows, invalid }) {
  const { t } = useTranslation("components");
  const add = () => setRows((r) => [...r, newForwardRow()]);
  const remove = (id) => setRows((r) => r.filter((x) => x.id !== id));
  const update = (id, key, val) =>
    setRows((r) => r.map((x) => (x.id === id ? { ...x, [key]: val } : x)));

  return (
    <div className={styles.portSection}>
      <p className={styles.modeDesc}>{t("ConnectionDialog.portForwardDesc")}</p>
      <div className={styles.portRowHeader}>
        <span>{t("ConnectionDialog.externalPort")}</span>
        <span>{t("ConnectionDialog.internalPort")}</span>
        <span>{t("ConnectionDialog.protocol")}</span>
        <span />
      </div>
      {rows.map((row) => (
        <div key={row.id} className={styles.portRow}>
          <input
            type="number" min="1" max="65535" placeholder={t("ConnectionDialog.externalPlaceholder")}
            value={row.externalPort}
            onChange={(e) => update(row.id, "externalPort", e.target.value)}
            aria-invalid={Boolean(invalid && !row.externalPort)}
            className={`${styles.portInput} ${invalid && !row.externalPort ? styles.portInputInvalid : ""}`}
          />
          <input
            type="number" min="1" max="65535" placeholder={t("ConnectionDialog.internalPlaceholder")}
            value={row.internalPort}
            onChange={(e) => update(row.id, "internalPort", e.target.value)}
            aria-invalid={Boolean(invalid && !row.internalPort)}
            className={`${styles.portInput} ${invalid && !row.internalPort ? styles.portInputInvalid : ""}`}
          />
          <select
            value={row.protocol}
            onChange={(e) => update(row.id, "protocol", e.target.value)}
            className={styles.protoSelect}
          >
            {PROTOCOLS.map((p) => <option key={p}>{p}</option>)}
          </select>
          <button type="button" className={styles.removeBtn} onClick={() => remove(row.id)}>
            <MIcon name="remove" size={16} />
          </button>
        </div>
      ))}
      <button type="button" className={styles.addBtn} onClick={add}>
        <MIcon name="add" size={16} />
        {t("ConnectionDialog.addMapping")}
      </button>
    </div>
  );
}

/* ── 主元件 ── */
export default function ConnectionDialog({
  nodes, onConfirm, onClose, closing = false, initialSource, initialTarget,
}) {
  const { t } = useTranslation("components");
  const GATEWAY_LABEL = t("ConnectionDialog.gatewayLabel");
  // 節點選擇（拉線開啟時由 initialSource / initialTarget 帶入；手動開啟預設 網際網路 → 第一台 VM）
  const isKnownKey = (key) => key === "internet" || nodes.some((n) => n.key === key);
  const defaultSource = isKnownKey(initialSource) ? initialSource : "internet";
  const defaultTarget = isKnownKey(initialTarget) && initialTarget !== defaultSource
    ? initialTarget
    : (defaultSource === "internet" ? (nodes[0]?.key ?? "") : "internet");
  const [sourceKey, setSourceKey] = useState(defaultSource);
  const [targetKey, setTargetKey] = useState(defaultTarget);

  /* 選到另一側正在使用的節點時自動交換，讓「VM → 網際網路」一步就能選到 */
  const pickSource = (key) => {
    if (key === targetKey) setTargetKey(sourceKey);
    setSourceKey(key);
  };
  const pickTarget = (key) => {
    if (key === sourceKey) setSourceKey(targetKey);
    setTargetKey(key);
  };
  const swapEnds = () => {
    setSourceKey(targetKey);
    setTargetKey(sourceKey);
  };

  // 方向（VM→VM 用）
  const [direction, setDirection] = useState("one_way");

  // 入站模式
  const [inboundMode, setInboundMode] = useState("port"); // "port" | "firewall"

  // Port rows
  const [fwRows,  setFwRows]  = useState([newPortRow()]);
  const [fwdRows, setFwdRows] = useState([newForwardRow()]);
  const [vmRows,  setVmRows]  = useState([newPortRow()]);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [portsInvalid, setPortsInvalid] = useState(false);

  /* 任何一列 port 有異動就把紅框拿掉 */
  const editRows = (setter) => (updater) => { setPortsInvalid(false); setter(updater); };

  const isInternetSrc = sourceKey === "internet";
  const isInternetTgt = targetKey === "internet";
  const isVmToVm = !isInternetSrc && !isInternetTgt;
  const isInbound = isInternetSrc && !isInternetTgt;
  const isOutbound = !isInternetSrc && isInternetTgt;

  const nodeOptions = [
    { key: "internet", label: GATEWAY_LABEL },
    ...nodes.map((n) => ({ key: n.key, label: n.name })),
  ];

  const sourceName = nodeOptions.find((n) => n.key === sourceKey)?.label ?? sourceKey;
  const targetName = nodeOptions.find((n) => n.key === targetKey)?.label ?? targetKey;

  const getVmid = (key) => {
    if (key === "internet") return null;
    const n = nodes.find((x) => x.key === key);
    return n?.vmid ?? null;
  };

  const buildPorts = () => {
    if (isOutbound) return [{ port: 0, protocol: "tcp" }]; // 出站不限 port

    if (isInbound) {
      if (inboundMode === "firewall") {
        return fwRows
          .filter((r) => r.port)
          .map((r) => ({ port: Number(r.port), protocol: r.protocol }));
      }
      // port forwarding
      return fwdRows
        .filter((r) => r.externalPort && r.internalPort)
        .map((r) => ({
          port: Number(r.internalPort),
          protocol: r.protocol,
          external_port: Number(r.externalPort),
        }));
    }

    // VM→VM
    return vmRows
      .filter((r) => r.port)
      .map((r) => ({ port: Number(r.port), protocol: r.protocol }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const ports = buildPorts();
    if (!isOutbound && ports.length === 0) {
      setPortsInvalid(true);
      focusInvalidField(e.currentTarget.querySelector('input[type="number"]'));
      return;
    }
    setError("");
    setSubmitting(true);
    try {
      await onConfirm({
        source_vmid: getVmid(sourceKey),
        target_vmid: getVmid(targetKey),
        ports,
        direction: isVmToVm ? direction : "one_way",
      });
    } catch (err) {
      setError(err?.message ?? t("ConnectionDialog.createFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className={`${styles.overlay} ${closing ? styles.overlayOut : ""}`}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className={styles.dialog}>
        {/* Title */}
        <div className={styles.dialogHeader}>
          <h2 className={styles.dialogTitle}>{t("ConnectionDialog.title")}</h2>
          <button type="button" className={styles.closeBtn} onClick={onClose}>
            <MIcon name="close" size={20} />
          </button>
        </div>

        <form className={styles.dialogBody} onSubmit={handleSubmit}>
          {/* Source / Target 選擇 */}
          <div className={styles.nodeRow}>
            <div className={styles.nodeSelect}>
              <label className={styles.nodeLabel}>{t("ConnectionDialog.source")}</label>
              <select
                value={sourceKey}
                onChange={(e) => pickSource(e.target.value)}
                className={styles.select}
              >
                {nodeOptions.map((n) => <option key={n.key} value={n.key}>{n.label}</option>)}
              </select>
            </div>

            <button
              type="button"
              className={styles.swapBtn}
              onClick={swapEnds}
              title={t("ConnectionDialog.swapAriaLabel")}
              aria-label={t("ConnectionDialog.swapAriaLabel")}
            >
              <MIcon name="swap_horiz" size={20} />
            </button>

            <div className={styles.nodeSelect}>
              <label className={styles.nodeLabel}>{t("ConnectionDialog.target")}</label>
              <select
                value={targetKey}
                onChange={(e) => pickTarget(e.target.value)}
                className={styles.select}
              >
                {nodeOptions.map((n) => <option key={n.key} value={n.key}>{n.label}</option>)}
              </select>
            </div>
          </div>

          {/* 出站：只需確認 */}
          {isOutbound && (
            <p className={styles.outboundMsg}>
              <MIcon name="info" size={16} />
              {t("ConnectionDialog.outboundMessagePrefix")} <strong>{sourceName}</strong> {t("ConnectionDialog.outboundMessageSuffix")}
            </p>
          )}

          {/* 入站：模式選擇 */}
          {isInbound && (
            <>
              <div className={styles.modeToggle}>
                <button
                  type="button"
                  className={`${styles.modeBtn} ${inboundMode === "port" ? styles.modeBtnActive : ""}`}
                  onClick={() => setInboundMode("port")}
                >
                  Port Forwarding
                </button>
                <button
                  type="button"
                  className={`${styles.modeBtn} ${inboundMode === "firewall" ? styles.modeBtnActive : ""}`}
                  onClick={() => setInboundMode("firewall")}
                >
                  Firewall Only
                </button>
              </div>
              {inboundMode === "port"
                ? <PortForwardForm rows={fwdRows} setRows={editRows(setFwdRows)} invalid={portsInvalid} />
                : <FirewallOnlyForm rows={fwRows} setRows={editRows(setFwRows)} invalid={portsInvalid} />
              }
            </>
          )}

          {/* VM→VM */}
          {isVmToVm && (
            <>
              <div className={styles.directionRow}>
                <label className={styles.nodeLabel}>{t("ConnectionDialog.direction")}</label>
                <div className={styles.modeToggle}>
                  <button
                    type="button"
                    className={`${styles.modeBtn} ${direction === "one_way" ? styles.modeBtnActive : ""}`}
                    onClick={() => setDirection("one_way")}
                  >
                    {sourceName} → {targetName}
                  </button>
                  <button
                    type="button"
                    className={`${styles.modeBtn} ${direction === "bidirectional" ? styles.modeBtnActive : ""}`}
                    onClick={() => setDirection("bidirectional")}
                  >
                    {t("ConnectionDialog.bidirectional")}
                  </button>
                </div>
              </div>
              <FirewallOnlyForm rows={vmRows} setRows={editRows(setVmRows)} invalid={portsInvalid} />
            </>
          )}

          {error && <p className={styles.errorMsg}>{error}</p>}

          {/* Actions */}
          <div className={styles.actions}>
            <button type="button" className={styles.cancelBtn} onClick={onClose}>{t("ConnectionDialog.cancel")}</button>
            <button type="submit" className={styles.confirmBtn} disabled={submitting}>
              {submitting ? t("ConnectionDialog.creating") : t("ConnectionDialog.createConnection")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
