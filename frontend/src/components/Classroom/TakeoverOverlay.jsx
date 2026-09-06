import { useTranslation } from "react-i18next";
import styles from "./Classroom.module.scss";
import MIcon from "../MIcon";

/** 學生自己的主控台：老師接管中時覆蓋顯示，提示輸入已被鎖定。 */
export default function TakeoverOverlay({ closing = false }) {
  const { t } = useTranslation("components");
  return (
    <div className={`${styles.takeoverOverlay} ${closing ? styles.takeoverOverlayOut : ""}`}>
      <div className={styles.takeoverBox}>
        <span className={styles.takeoverIcon}>
          <MIcon name="back_hand" size={24} />
        </span>
        <p className={styles.takeoverTitle}>{t("TakeoverOverlay.title")}</p>
        <p className={styles.takeoverDesc}>{t("TakeoverOverlay.description")}</p>
      </div>
    </div>
  );
}
