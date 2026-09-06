import { useTranslation } from "react-i18next";
import styles from "./LoadingState.module.scss";

/* 3D 方塊堆疊動畫本體；LoadingState 與 LoadingSpinner 共用 */
function BoxLoader({ style }) {
  return (
    <div className={styles.loader} style={style} aria-hidden="true">
      {Array.from({ length: 8 }, (_, index) => (
        <div key={index} className={`${styles.box} ${styles[`box${index}`]}`}>
          <div />
        </div>
      ))}
      <div className={styles.ground}>
        <div />
      </div>
    </div>
  );
}

/**
 * 純 spinner（無文字），給自帶文案排版的容器使用（如登入驗證卡片）。
 *
 * @param {number} [size=60] 顯示寬度（px；以 200px 原始設計等比縮放，高度隨比例）
 */
export function LoadingSpinner({ size = 60 }) {
  return <BoxLoader style={{ zoom: size / 200 }} />;
}

/**
 * 共用載入狀態：資料尚未回來前的佔位畫面（3D 方塊堆疊動畫）。
 *
 * @param {string}  [text] 顯示文字（未提供時使用預設「載入中…」）
 * @param {boolean} [fullPage=false] 佔滿整頁高度（頁面層級載入用）
 */
export default function LoadingState({ text, fullPage = false }) {
  const { t } = useTranslation("common");
  const displayText = text ?? t("LoadingState.default");
  return (
    <div
      className={fullPage ? `${styles.wrap} ${styles.wrapFull}` : styles.wrap}
      role="status"
      aria-live="polite"
    >
      <BoxLoader />
      {displayText && <span className={styles.text}>{displayText}</span>}
    </div>
  );
}
