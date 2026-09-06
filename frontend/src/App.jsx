import { lazy } from "react";
import { Navigate, Route, Routes, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "./contexts/AuthContext";
import DashboardLayout from "./layout/DashboardLayout";
import LoginPage from "./pages/login/LoginPage";
import MIcon from "./components/MIcon";
import { LoadingSpinner } from "./components/LoadingState/LoadingState";
import { AuthSessionStatus } from "./services/authSession";
import styles from "./App.module.scss";

// 個人
const AdminDashboardPage = lazy(() => import("./pages/personal/dashboard/admin/AdminDashboardPage"));
const TeacherDashboardPage = lazy(() => import("./pages/personal/dashboard/teacher/TeacherDashboardPage"));
const StudentHomePage = lazy(() => import("./pages/personal/dashboard/StudentHomePage"));
const StudentCoursePage = lazy(() => import("./pages/personal/dashboard/student/StudentCoursePage"));
const QuickTemplateFormPage = lazy(() => import("./pages/personal/quick-practice/QuickTemplateFormPage"));
const ResourcesPage = lazy(() => import("./pages/personal/resources/ResourcesPage"));
const ResourceDetailPage = lazy(() => import("./pages/personal/resources/detail/ResourceDetailPage"));
const RequestsPage = lazy(() => import("./pages/personal/requests/RequestsPage"));
const AccountSettingsPage = lazy(() => import("./pages/personal/account/AccountSettingsPage"));

// 資源
const ResourceMgmtPage = lazy(() => import("./pages/resource/resource-mgmt/ResourceMgmtPage"));
const RequestReviewPage = lazy(() => import("./pages/resource/request-review/RequestReviewPage"));
const GpuMgmtPage = lazy(() => import("./pages/resource/gpu-mgmt/GpuMgmtPage"));
const BatchReviewPage = lazy(() => import("./pages/resource/batch-review/BatchReviewPage"));
const TemplatesPage = lazy(() => import("./pages/resource/templates/TemplatesPage"));

// AI
const AiApiPage = lazy(() => import("./pages/ai/ai-api/AiApiPage"));
const AiApiReviewPage = lazy(() => import("./pages/ai/ai-api-review/AiApiReviewPage"));
const AiApiKeysPage = lazy(() => import("./pages/ai/ai-api-keys/AiApiKeysPage"));
const AiMonitoringPage = lazy(() => import("./pages/ai/ai-monitoring/AiMonitoringPage"));

// 教學
const CourseCmsPage = lazy(() => import("./pages/teaching/course-cms/CourseCmsPage"));
const CourseTemplateManagementPage = lazy(() => import("./pages/course-operations/course-templates/CourseTemplateManagementPage"));
const CourseTemplateEditorPage = lazy(() => import("./pages/course-operations/course-templates/CourseTemplateEditorPage"));
const ClassManagementPage = lazy(() => import("./pages/course-operations/class-management/ClassManagementPage"));
const ClassWorkspacePage = lazy(() => import("./pages/course-operations/class-workspace/ClassWorkspacePage"));
const AiJudgePage = lazy(() => import("./pages/course-operations/ai-judge/AiJudgePage"));
const ClassSetupPage = lazy(() => import("./pages/course-operations/class-setup/ClassSetupPage"));

// 系統管理
const AdminPage = lazy(() => import("./pages/system/admin/AdminPage"));
const SettingsPage = lazy(() => import("./pages/system/settings/SettingsPage"));
const MonitoringPage = lazy(() => import("./pages/system/monitoring/MonitoringPage"));
const QuotasPage = lazy(() => import("./pages/system/quotas/QuotasPage"));
const IpManagementPage = lazy(() => import("./pages/system/ip-management/IpManagementPage"));
const AuditPage = lazy(() => import("./pages/system/audit/AuditPage"));
const JobsPage = lazy(() => import("./pages/system/jobs/JobsPage"));

// 網路
const FirewallPage = lazy(() => import("./pages/network/firewall/FirewallPage"));
const DomainPage = lazy(() => import("./pages/system/domain/DomainPage"));
const GatewayPage = lazy(() => import("./pages/system/gateway/GatewayPage"));
const ReverseProxyPage = lazy(() => import("./pages/network/reverse-proxy/ReverseProxyPage"));

function AuthBootstrapState({ unavailable = false, retrying = false, onRetry }) {
  const { t } = useTranslation("common");
  return (
    <main className={styles.authStatePage}>
      <section className={styles.authStateCard} role={unavailable ? "alert" : "status"}>
        {unavailable ? (
          <span className={styles.authStateIcon} aria-hidden="true">
            <MIcon name="cloud_off" size={42} />
          </span>
        ) : (
          <LoadingSpinner size={42} />
        )}
        <h1 className={styles.authStateTitle}>
          {unavailable ? t("App.connectionUnavailable") : t("App.verifyingLogin")}
        </h1>
        <p className={styles.authStateDescription}>
          {unavailable
            ? t("App.connectionUnavailableDesc")
            : t("App.verifyingLoginDesc")}
        </p>
        {unavailable && (
          <button
            type="button"
            className={styles.retryButton}
            disabled={retrying}
            onClick={onRetry}
          >
            <span aria-hidden="true">
              <MIcon name="refresh" size={18} />
            </span>
            {retrying ? t("App.retrying") : t("App.retryConnect")}
          </button>
        )}
      </section>
    </main>
  );
}

function LegacyAiJudgeEditorRedirect() {
  const { classId, sessionId } = useParams();
  const query = sessionId ? `?check=${encodeURIComponent(sessionId)}` : "";
  return <Navigate to={`/class-management/${classId}/ai${query}`} replace />;
}

function App() {
  const { user, loading, authStatus, retrySession } = useAuth();
  const isAdmin = Boolean(user?.is_superuser || user?.role === "admin");
  const canTeach = isAdmin || user?.role === "teacher";
  const isDeviceApproval = Boolean(
    new URLSearchParams(window.location.search).get("device_code"),
  );

  if (authStatus === AuthSessionStatus.UNAVAILABLE && !user) {
    return (
      <AuthBootstrapState
        unavailable
        retrying={loading}
        onRetry={retrySession}
      />
    );
  }
  if (loading && !user) return <AuthBootstrapState />;

  return (
    <Routes>
      <Route
        path="/login"
        element={
          user && !isDeviceApproval ? (
            <Navigate to="/dashboard" replace />
          ) : (
            <LoginPage />
          )
        }
      />

      {user ? (
        <Route element={<DashboardLayout />}>
          <Route index element={<Navigate to="/dashboard" replace />} />

          {/* 個人 */}
          {/* 首頁依角色顯示：admin → 管理首頁、teacher → 教師首頁、其他 → 學生首頁 */}
          <Route
            path="/dashboard"
            element={
              isAdmin
                ? <AdminDashboardPage />
                : user?.role === "teacher"
                  ? <TeacherDashboardPage />
                  : <StudentHomePage />
            }
          />
          {/* 單一課程總覽：課堂環境、課堂機器與截至今天的 AI 任務 */}
          <Route path="/dashboard/course/:pathId" element={<StudentCoursePage />} />
          <Route path="/quick-template/:id"   element={<QuickTemplateFormPage />} />
          <Route path="/my-resources"         element={<ResourcesPage />} />
          <Route path="/my-resources/:vmid"   element={<ResourceDetailPage backTo="/my-resources" />} />
          <Route path="/my-requests"          element={<RequestsPage />} />
          <Route path="/account"              element={<AccountSettingsPage />} />

          {/* 資源 */}
          {isAdmin && (
            <>
              <Route path="/resource-mgmt"  element={<ResourceMgmtPage />} />
              <Route path="/resource-mgmt/:vmid" element={<ResourceDetailPage backTo="/resource-mgmt" />} />
              <Route path="/request-review" element={<RequestReviewPage />} />
              <Route path="/gpu-mgmt"       element={<GpuMgmtPage />} />
              <Route path="/batch-review"   element={<BatchReviewPage />} />
            </>
          )}
          {/* 機器範本頁只給老師／管理員；學生在申請表單的「資源設定」選用範本 */}
          <Route path="/templates"      element={canTeach ? <TemplatesPage /> : <Navigate to="/my-requests" state={{ create: true }} replace />} />

          {/* AI */}
          <Route path="/ai-api"         element={<AiApiPage />} />
          {isAdmin && (
            <>
              <Route path="/ai-api-review" element={<AiApiReviewPage />} />
              <Route path="/ai-api-keys" element={<AiApiKeysPage />} />
              <Route path="/ai-monitoring" element={<AiMonitoringPage />} />
            </>
          )}
          <Route
            path="/ai-management"
            element={<Navigate to={isAdmin ? "/ai-monitoring" : "/ai-api"} replace />}
          />

          {/* 教學 */}
          <Route path="/course-cms"            element={<CourseCmsPage />} />

          {/* 課務管理 */}
          <Route path="/course-template-management" element={canTeach ? <CourseTemplateManagementPage /> : <Navigate to="/dashboard" replace />} />
          <Route path="/course-template-management/new" element={canTeach ? <CourseTemplateEditorPage /> : <Navigate to="/dashboard" replace />} />
          <Route path="/course-template-management/:templateId" element={canTeach ? <CourseTemplateEditorPage /> : <Navigate to="/dashboard" replace />} />
          <Route path="/class-management" element={canTeach ? <ClassManagementPage /> : <Navigate to="/dashboard" replace />} />
          <Route path="/class-management/new" element={<Navigate to={canTeach ? "/class-setup" : "/dashboard"} replace />} />
          <Route path="/class-setup" element={canTeach ? <ClassSetupPage /> : <Navigate to="/dashboard" replace />} />
          <Route path="/class-management/:classId/ai" element={canTeach ? <AiJudgePage /> : <Navigate to="/dashboard" replace />} />
          {/* 舊評分表連結保留導回主工作頁，避免書籤落到不存在的獨立 editor。 */}
          <Route
            path="/class-management/:classId/ai/checks/:sessionId/edit"
            element={canTeach ? <LegacyAiJudgeEditorRedirect /> : <Navigate to="/dashboard" replace />}
          />
          <Route path="/class-management/:classId" element={canTeach ? <ClassWorkspacePage /> : <Navigate to="/dashboard" replace />} />
          <Route path="/class-management/:classId/:section" element={canTeach ? <ClassWorkspacePage /> : <Navigate to="/dashboard" replace />} />

          {/* 系統管理 */}
          {isAdmin && (
            <>
              <Route path="/admin"     element={<AdminPage />} />
              <Route path="/settings"  element={<SettingsPage />} />
              <Route path="/quotas"    element={<QuotasPage />} />
              <Route path="/ip-management" element={<IpManagementPage />} />
              <Route path="/monitoring" element={<MonitoringPage />} />
              <Route path="/audit"     element={<AuditPage />} />
            </>
          )}
          <Route path="/jobs"      element={<JobsPage />} />

          {/* 網路 */}
          <Route path="/firewall"       element={<FirewallPage />} />
          {isAdmin && (
            <>
              <Route path="/domain"         element={<DomainPage />} />
              <Route path="/gateway"        element={<GatewayPage />} />
            </>
          )}
          <Route path="/reverse-proxy"  element={<ReverseProxyPage />} />

          {/* fallback */}
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Route>
      ) : (
        <Route path="*" element={<Navigate to="/login" replace />} />
      )}
    </Routes>
  );
}

export default App;
