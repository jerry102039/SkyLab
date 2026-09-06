/**
 * ConfirmProvider / useConfirm
 * 共用的危險操作確認對話框，取代 window.confirm。
 * 用法：
 *   const confirm = useConfirm();
 *   if (!(await confirm({ title: "刪除連線", message: "…", danger: true }))) return;
 * 也接受字串簡寫：await confirm("確定刪除？")
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import MIcon from "../MIcon";
import useDialogPresence from "../../hooks/useDialogPresence";
import styles from "./ConfirmDialog.module.scss";

const ConfirmContext = createContext(null);

export function useConfirm() {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error("useConfirm 必須在 <ConfirmProvider> 內使用");
  return confirm;
}

export function ConfirmProvider({ children }) {
  const { t } = useTranslation("common");
  const [pending, setPending] = useState(null); // { options, resolve }
  const confirmBtnRef = useRef(null);

  const confirm = useCallback((options) => {
    const opts = typeof options === "string" ? { message: options } : (options ?? {});
    return new Promise((resolve) => {
      setPending((prev) => {
        prev?.resolve(false);
        return { options: opts, resolve };
      });
    });
  }, []);

  const close = useCallback((result) => {
    setPending((prev) => {
      prev?.resolve(result);
      return null;
    });
  }, []);

  useEffect(() => {
    if (!pending) return;
    confirmBtnRef.current?.focus();
    const onKeyDown = (e) => {
      if (e.key === "Escape") close(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pending, close]);

  // 關閉時保留最後一筆資料，先播放離場動畫再卸載
  const presence = useDialogPresence(pending);
  const opts = presence.item?.options;

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {presence.open &&
        createPortal(
          <div
            className={`${styles.overlay} ${presence.closing ? styles.overlayOut : ""}`}
            onClick={() => close(false)}
          >
            <div
              className={styles.dialog}
              role="alertdialog"
              aria-modal="true"
              aria-label={opts.title ?? t("ConfirmProvider.defaultTitle")}
              onClick={(e) => e.stopPropagation()}
            >
              <div className={styles.title}>
                <span className={opts.danger ? styles.iconDanger : styles.iconWarn}>
                  <MIcon name={opts.danger ? "warning" : "help"} size={20} />
                </span>
                {opts.title ?? t("ConfirmProvider.defaultTitle")}
              </div>
              <p className={styles.message}>{opts.message}</p>
              <div className={styles.actions}>
                <button type="button" className={styles.btnSecondary} onClick={() => close(false)}>
                  {opts.cancelText ?? t("ConfirmProvider.cancel")}
                </button>
                <button
                  type="button"
                  ref={confirmBtnRef}
                  className={opts.danger ? styles.btnDanger : styles.btnPrimary}
                  onClick={() => close(true)}
                >
                  {opts.confirmText ?? t("ConfirmProvider.confirm")}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </ConfirmContext.Provider>
  );
}
