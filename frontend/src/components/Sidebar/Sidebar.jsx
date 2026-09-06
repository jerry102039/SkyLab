import { useState, useRef, useEffect, useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth }  from "../../contexts/AuthContext";
import { SUPPORTED_LANGUAGES, setLanguage } from "../../i18n";
import styles from "./Sidebar.module.scss";
import MIcon from "../MIcon";
import Avatar from "../Avatar/Avatar";
import JobsButton from "../Jobs/JobsButton";

const topItems = [
  { key: "dashboard", labelKey: "Sidebar.topDashboard", icon: "dashboard" },
];

const navGroups = [
  {
    key: "resource",
    labelKey: "Sidebar.groupResource",
    icon: "storage",
    items: [
      { key: "my-resources",  labelKey: "Sidebar.itemMyResources",    icon: "inventory_2" },
      { key: "my-requests",   labelKey: "Sidebar.itemMyRequests",    icon: "assignment" },
      { key: "resource-mgmt", labelKey: "Sidebar.itemResourceMgmt",    icon: "storage", adminOnly: true },
      { key: "templates",     labelKey: "Sidebar.itemTemplates",    icon: "library_books", instructorOnly: true },
      { key: "gpu-mgmt",      labelKey: "Sidebar.itemGpuMgmt",    icon: "memory", adminOnly: true },
    ],
  },
  {
    key: "review",
    labelKey: "Sidebar.groupReview",
    icon: "fact_check",
    items: [
      { key: "request-review", labelKey: "Sidebar.itemRequestReview", icon: "fact_check", adminOnly: true },
      { key: "batch-review",   labelKey: "Sidebar.itemBatchReview", icon: "library_add_check", adminOnly: true },
      { key: "ai-api-review",  labelKey: "Sidebar.itemAiApiReview", icon: "rate_review", adminOnly: true },
    ],
  },
  {
    key: "network",
    labelKey: "Sidebar.groupNetwork",
    icon: "router",
    items: [
      { key: "firewall",      labelKey: "Sidebar.itemFirewall",     icon: "security" },
      { key: "reverse-proxy", labelKey: "Sidebar.itemReverseProxy",   icon: "swap_horiz" },
    ],
  },
  {
    key: "ai",
    labelKey: "Sidebar.groupAi",
    icon: "smart_toy",
    items: [
      { key: "ai-api",        labelKey: "Sidebar.itemAiApi",   icon: "psychology" },
      { key: "ai-api-keys",   labelKey: "Sidebar.itemAiApiKeys", icon: "vpn_key", adminOnly: true },
      { key: "ai-monitoring", labelKey: "Sidebar.itemAiMonitoring", icon: "monitor_heart", adminOnly: true },
      /* PVE 維運助手不放側欄：管理者首頁就是它的入口，那裡同時看得到待處理的問題 */
    ],
  },
  {
    key: "teaching",
    labelKey: "Sidebar.groupTeaching",
    icon: "school",
    items: [
      { key: "class-management", labelKey: "Sidebar.itemClassManagement", icon: "groups_2", instructorOnly: true },
      { key: "course-template-management", labelKey: "Sidebar.itemCourseTemplateManagement", icon: "view_quilt", instructorOnly: true },
    ],
  },
  {
    key: "system",
    labelKey: "Sidebar.groupSystem",
    icon: "tune",
    items: [
      { key: "admin",         labelKey: "Sidebar.itemAdmin", icon: "admin_panel_settings", adminOnly: true },
      { key: "quotas",        labelKey: "Sidebar.itemQuotas",   icon: "data_usage", adminOnly: true },
      { key: "ip-management", labelKey: "Sidebar.itemIpManagement",    icon: "lan", adminOnly: true },
      { key: "domain",        labelKey: "Sidebar.itemDomain",   icon: "domain", adminOnly: true },
      { key: "gateway",       labelKey: "Sidebar.itemGateway",    icon: "dns", adminOnly: true },
      { key: "settings",      labelKey: "Sidebar.itemSettings",   icon: "settings", adminOnly: true },
    ],
  },
  {
    key: "monitoring",
    labelKey: "Sidebar.groupMonitoring",
    icon: "insights",
    items: [
      { key: "monitoring",    labelKey: "Sidebar.itemMonitoring",       icon: "monitor_heart", adminOnly: true },
      { key: "jobs",          labelKey: "Sidebar.itemJobs",       icon: "task_alt" },
      { key: "audit",         labelKey: "Sidebar.itemAudit",     icon: "receipt_long", adminOnly: true },
    ],
  },
];

function NavGroup({ group, active, onSelect, collapsed, onExpand }) {
  const { t } = useTranslation("common");
  const [open, setOpen] = useState(
    group.items.some((i) => i.key === active)
  );

  const hasActive = group.items.some((i) => i.key === active);

  const handleHeaderClick = () => {
    if (collapsed) {
      onExpand();
      setOpen(true);
    } else {
      setOpen((o) => !o);
    }
  };

  return (
    <div className={styles.group}>
      <button
        type="button"
        className={`${styles.groupHeader} ${hasActive ? styles.groupHeaderActive : ""}`}
        onClick={handleHeaderClick}
        title={collapsed ? t(group.labelKey) : undefined}
        aria-label={t(group.labelKey)}
        aria-expanded={!collapsed && open}
      >
        <MIcon name={group.icon} size={20} />
        {!collapsed && (
          <>
            <span className={styles.groupLabel}>{t(group.labelKey)}</span>
            <span className={`${styles.groupChevron} ${open ? styles.open : ""}`}>
              <MIcon name="chevron_right" size={16} />
            </span>
          </>
        )}
      </button>

      <div
        className={`${styles.groupItems} ${!collapsed && open ? styles.groupItemsOpen : ""}`}
      >
        <div className={styles.groupItemsInner}>
          {group.items.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`${styles.navItem} ${active === item.key ? styles.active : ""}`}
              onClick={() => onSelect(item.key)}
              aria-label={t(item.labelKey)}
            >
              <span className={styles.navLabel}>{t(item.labelKey)}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** 管理 popup 的開關，含 closing 動畫狀態 */
function usePopup(DURATION = 150) {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const timerRef = useRef(null);

  const close = useCallback(() => {
    setClosing(true);
    timerRef.current = setTimeout(() => {
      setOpen(false);
      setClosing(false);
    }, DURATION);
  }, [DURATION]);

  const toggle = useCallback(() => {
    if (open && !closing) {
      close();
    } else if (!open) {
      clearTimeout(timerRef.current);
      setClosing(false);
      setOpen(true);
    }
  }, [open, closing, close]);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  return { open, closing, toggle, close };
}

/** 通用彈出選單，供外觀與語言共用 */
function SelectPopup({ options, value, onSelect, onClose, triggerRef, closing }) {
  const ref = useRef(null);

  useEffect(() => {
    const handler = (e) => {
      const inPopup = ref.current?.contains(e.target);
      const inTrigger = triggerRef?.current?.contains(e.target);
      if (!inPopup && !inTrigger) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose, triggerRef]);

  return (
    <div className={`${styles.appearancePopup} ${closing ? styles.popupClosing : styles.popupOpening}`} ref={ref}>
      {options.map((opt) => (
        <button
          key={opt.key}
          type="button"
          className={`${styles.appearanceOption} ${value === opt.key ? styles.appearanceOptionActive : ""} ${opt.disabled ? styles.appearanceOptionDisabled : ""}`}
          disabled={opt.disabled}
          onClick={() => { onSelect(opt.key); onClose(); }}
        >
          {opt.flag
            ? <span className={styles.optionFlag}>{opt.flag}</span>
            : <MIcon name={opt.icon} size={18} />
          }
          <span>{opt.label}</span>
          {opt.hint && <span className={styles.optionHint}>{opt.hint}</span>}
        </button>
      ))}
    </div>
  );
}

function UserPopup({ user, onLogout, onSettings, onClose, triggerRef, closing }) {
  const { t } = useTranslation("common");
  const ref = useRef(null);

  useEffect(() => {
    const handler = (e) => {
      const inPopup = ref.current?.contains(e.target);
      const inTrigger = triggerRef?.current?.contains(e.target);
      if (!inPopup && !inTrigger) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose, triggerRef]);

  return (
    <div className={`${styles.userPopup} ${closing ? styles.popupClosing : styles.popupOpening}`} ref={ref}>
      <div className={styles.userPopupHeader}>
        <Avatar user={user} size={32} />
        <div className={styles.userPopupInfo}>
          <span className={styles.userName}>{user?.full_name ?? "—"}</span>
          <span className={styles.userEmail}>{user?.email ?? "—"}</span>
        </div>
      </div>
      <div className={styles.userPopupDivider} />
      <button type="button" className={styles.userPopupItem} onClick={() => { onClose(); onSettings(); }}>
        <MIcon name="settings" size={18} />
        <span>{t("Sidebar.userSettings")}</span>
      </button>
      <button
        type="button"
        className={`${styles.userPopupItem} ${styles.userPopupItemDanger}`}
        onClick={() => { onClose(); onLogout(); }}
      >
        <MIcon name="logout" size={18} />
        <span>{t("Sidebar.logOut")}</span>
      </button>
    </div>
  );
}

const LANG_OPTIONS = [
  { key: "zh-TW", label: "繁體中文", flag: "🇹🇼" },
  { key: "en",    label: "English",  flag: "🇬🇧" },
  { key: "ja",    label: "日本語",   flag: "🇯🇵" },
];

export default function Sidebar({ collapsed, mobileOpen, onToggle, onClose }) {
  const { t, i18n } = useTranslation("common");
  const navigate = useNavigate();
  const location = useLocation();
  const active   = location.pathname.split("/")[1] || "dashboard";
  const lang = SUPPORTED_LANGUAGES.includes(i18n.language) ? i18n.language : "zh-TW";
  const langPopup  = usePopup();
  const userPopup  = usePopup();
  const langBtnRef = useRef(null);
  const userBtnRef = useRef(null);
  const { user, logout } = useAuth();
  const isAdmin = Boolean(user?.is_superuser || user?.role === "admin");
  const canTeach = isAdmin || user?.role === "teacher";
  const visibleNavGroups = navGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) =>
        (!item.adminOnly || isAdmin) && (!item.instructorOnly || canTeach)
      ),
    }))
    .filter((group) => group.items.length > 0);

  const cls = [
    styles.sidebar,
    collapsed && styles.collapsed,
    mobileOpen && styles.mobileOpen,
  ]
    .filter(Boolean)
    .join(" ");

  const handleNav = (key) => {
    navigate(`/${key}`);
    onClose?.();
  };

  return (
    <aside className={cls}>
      {/* ===== Brand ===== */}
      <div className={styles.brand} onClick={() => window.innerWidth >= 1024 && onToggle?.()}>
        <span className={styles.brandIcon}>
          <img src="/favicon.png" alt="SkyLab" />
        </span>
        {!collapsed && (
          <>
            <span className={styles.brandText}>SkyLab</span>
          </>
        )}
      </div>

      <div className={styles.brandDivider} />

      {/* ===== Main nav ===== */}
      <nav className={styles.nav}>
        {topItems.map((item) => (
          <button
            key={item.key}
            type="button"
            className={`${styles.navItem} ${active === item.key ? styles.active : ""}`}
            onClick={() => handleNav(item.key)}
            title={collapsed ? t(item.labelKey) : undefined}
            aria-label={t(item.labelKey)}
          >
            <MIcon name={item.icon} size={20} />
            {!collapsed && <span className={styles.navLabel}>{t(item.labelKey)}</span>}
          </button>
        ))}
        {visibleNavGroups.map((group) => (
          <NavGroup
            key={group.key}
            group={group}
            active={active}
            onSelect={handleNav}
            collapsed={collapsed}
            onExpand={onToggle}
          />
        ))}
      </nav>

      {/* ===== Bottom section ===== */}
      <div className={styles.bottom}>
        {/* 背景任務（全站入口，狀態由 DashboardLayout 的 JobsProvider 提供） */}
        <JobsButton collapsed={collapsed} />

        {/* 語言選擇 */}
        <div className={styles.appearanceWrap}>
          {langPopup.open && (
            <SelectPopup
              options={LANG_OPTIONS}
              value={lang}
              onSelect={setLanguage}
              onClose={langPopup.close}
              triggerRef={langBtnRef}
              closing={langPopup.closing}
            />
          )}
          <button
            ref={langBtnRef}
            type="button"
            className={`${styles.navItem} ${langPopup.open && !langPopup.closing ? styles.active : ""}`}
            onClick={langPopup.toggle}
            title={collapsed ? "語言" : undefined}
            aria-label="語言 / Language"
            aria-expanded={langPopup.open}
          >
            <MIcon name="language" size={20} />
            {!collapsed && <span className={styles.navLabel}>語言 / Language</span>}
            {!collapsed && <span className={styles.navHint}>{LANG_OPTIONS.find(o => o.key === lang)?.label}</span>}
          </button>
        </div>

        {/* 使用者資料 */}
        <div className={styles.appearanceWrap}>
          {userPopup.open && (
            <UserPopup
              user={user}
              onLogout={logout}
              onSettings={() => handleNav("account")}
              onClose={userPopup.close}
              triggerRef={userBtnRef}
              closing={userPopup.closing}
            />
          )}
          <button
            ref={userBtnRef}
            type="button"
            className={`${styles.user} ${userPopup.open && !userPopup.closing ? styles.userActive : ""}`}
            onClick={userPopup.toggle}
            title={collapsed ? (user?.full_name ?? user?.email) : undefined}
            aria-label={t("Sidebar.userMenuAriaLabel", { name: user?.full_name ?? user?.email ?? "" })}
            aria-expanded={userPopup.open}
          >
            <Avatar user={user} size={32} className={styles.avatar} />
            {!collapsed && (
              <>
                <div className={styles.userInfo}>
                  <span className={styles.userName}>{user?.full_name ?? "—"}</span>
                  <span className={styles.userEmail}>{user?.email ?? "—"}</span>
                </div>
                <MIcon name={userPopup.open && !userPopup.closing ? "expand_more" : "unfold_more"} size={16} />
              </>
            )}
          </button>
        </div>
      </div>
    </aside>
  );
}
