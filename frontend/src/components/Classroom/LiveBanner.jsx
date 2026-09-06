import { useTranslation } from "react-i18next";
import styles from "./Classroom.module.scss";
import MIcon from "../MIcon";

/** 學生端：老師開始直播時顯示的橫幅，點擊開啟觀看視窗。 */
export default function LiveBanner({ onWatch, onDismiss }) {
  const { t } = useTranslation("components");
  return (
    <div className={styles.liveBanner}>
      <span className={styles.liveDot} />
      <MIcon name="sensors" size={16} />
      <span>{t("LiveBanner.teacherLive")}</span>
      <button type="button" className={styles.liveWatchBtn} onClick={onWatch}>
        {t("LiveBanner.watchButton")}
      </button>
      <button
        type="button"
        className={styles.liveDismiss}
        onClick={onDismiss}
        title={t("LiveBanner.dismissTitle")}
      >
        <MIcon name="close" size={16} />
      </button>
    </div>
  );
}
