/**
 * SubnetBanner
 * 子網尚未配置時的全站警告橫幅：VM/LXC 建立功能已停用，
 * 管理員附「前往設定」連結。已配置或尚未取得狀態時不顯示。
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import MIcon from "../MIcon";
import { useAuth } from "../../contexts/AuthContext";
import { IpManagementService } from "../../services/ipManagement";
import styles from "./SubnetBanner.module.scss";

export default function SubnetBanner() {
  const { t } = useTranslation("common");
  const { user } = useAuth();
  const [status, setStatus] = useState(null);
  const isAdmin = Boolean(user?.is_superuser || user?.role === "admin");

  useEffect(() => {
    let cancelled = false;
    IpManagementService.getStatus()
      .then((res) => {
        if (!cancelled) setStatus(res);
      })
      .catch(() => {
        // 取不到狀態就不顯示，避免誤報
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!status || status.configured) return null;

  return (
    <div className={styles.banner}>
      <MIcon name="warning_amber" size={16} />
      <span className={styles.text}>
        {isAdmin ? t("SubnetBanner.adminMessage") : t("SubnetBanner.userMessage")}
        {isAdmin && (
          <Link to="/ip-management" className={styles.link}>
            {t("SubnetBanner.goToSettings")}
          </Link>
        )}
      </span>
    </div>
  );
}
