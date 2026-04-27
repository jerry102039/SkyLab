import { useEffect, useRef, useState } from "react";
import { VncScreen } from "react-vnc";
import { AuthStorage } from "../../../services/auth";
import { ResourcesService } from "../../../services/resources";
import MIcon from "../../../components/MIcon";
import styles from "./ConsoleDialog.module.scss";

export default function VncDialog({ resource, onClose }) {
  const vncRef      = useRef(null);
  const dialogRef   = useRef(null);
  const [connected, setConnected]       = useState(false);
  const [wsUrl, setWsUrl]               = useState("");
  const [error, setError]               = useState("");
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", handler);
    return () => document.removeEventListener("fullscreenchange", handler);
  }, []);

  useEffect(() => {
    if (!resource?.vmid) return;
    ResourcesService.getConsole(resource.vmid)
      .then((data) => {
        const apiUrl = new URL(import.meta.env.VITE_API_URL || `${window.location.protocol}//${window.location.host}`);
        const proto  = apiUrl.protocol === "https:" ? "wss:" : "ws:";
        const token  = AuthStorage.getAccessToken() ?? "";
        const ticket = data.ticket ?? "";
        const port   = data.port   ?? "";
        let url = `${proto}//${apiUrl.host}/ws/vnc/${resource.vmid}?token=${encodeURIComponent(token)}&vnc_ticket=${encodeURIComponent(ticket)}`;
        if (port) url += `&vnc_port=${encodeURIComponent(port)}`;
        setWsUrl(url);
      })
      .catch((e) => setError(e.message ?? "無法取得控制台資訊"));
  }, [resource?.vmid]);

  function handleClose() {
    vncRef.current?.disconnect?.();
    onClose();
  }

  async function handleClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      vncRef.current?.clipboardPaste?.(text);
    } catch {}
  }

  function toggleFullscreen(containerEl) {
    if (!document.fullscreenElement) containerEl?.requestFullscreen?.();
    else document.exitFullscreen?.();
  }

  return (
    <div className={styles.overlay} onClick={handleClose}>
      <div className={`${styles.dialog} ${styles.dialogWide}`} onClick={(e) => e.stopPropagation()} ref={dialogRef}>
        <div className={styles.header}>
          <span className={styles.headerIcon}><MIcon name="desktop_windows" size={18} /></span>
          <span className={styles.headerTitleGroup}>
            <span className={styles.headerTitle}>控制台 — {resource.name}</span>
            <span className={`${styles.statusDot} ${connected ? styles.dot_connected : styles.dot_connecting}`} />
            <span className={styles.statusText}>{connected ? "已連接" : "連接中"}</span>
          </span>
          {connected && (
            <>
              <button type="button" className={styles.headerBtn} title="Ctrl+Alt+Del" onClick={() => vncRef.current?.sendCtrlAltDel?.()}>
                <MIcon name="keyboard" size={16} />
                <span style={{ fontSize: 11 }}>Ctrl+Alt+Del</span>
              </button>
              <button type="button" className={styles.headerBtn} title="貼上剪貼簿" onClick={handleClipboard}>
                <MIcon name="content_paste" size={16} />
              </button>
            </>
          )}
          <button type="button" className={styles.headerBtn} title={isFullscreen ? "離開全螢幕" : "全螢幕"} onClick={() => toggleFullscreen(dialogRef.current)}>
            <MIcon name={isFullscreen ? "fullscreen_exit" : "fullscreen"} size={16} />
          </button>
          <button type="button" className={styles.closeBtn} onClick={handleClose}>
            <MIcon name="close" size={18} />
          </button>
        </div>

        {error && (
          <div className={styles.statusBanner}>
            <MIcon name="error_outline" size={16} />{error}
          </div>
        )}

        {!error && !wsUrl && (
          <div className={styles.statusBanner}>
            <MIcon name="hourglass_empty" size={16} />取得控制台資訊中…
          </div>
        )}

        {wsUrl && (
          <div className={styles.vncWrap}>
            <VncScreen
              ref={vncRef}
              url={wsUrl}
              style={{ width: "100%", height: "100%" }}
              onConnect={() => setConnected(true)}
              onDisconnect={() => setConnected(false)}
              scaleViewport
              background="#1e1e1e"
            />
          </div>
        )}
      </div>
    </div>
  );
}
