import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./ResourceDetailPage.module.scss";
import LoadingState from "../../../../components/LoadingState/LoadingState";
import MIcon from "../../../../components/MIcon";
import { useConfirm } from "../../../../components/ConfirmDialog/ConfirmProvider";
import { useAuth } from "../../../../contexts/AuthContext";
import { ResourcesService } from "../../../../services/resources";
import {
  SpecChangeRequestsService,
  canApplySpecRequest,
  canCancelSpecRequest,
  isOpenSpecRequest,
  specRequestChangeLabel,
  specRequestDisplayStatus,
} from "../../../../services/specChangeRequests";
import { useToast } from "../../../../hooks/useToast";
import { focusInvalidField } from "../../../../utils/focusField";

/* 套用中（關機 → 改規格 → 開機）約 1～3 分鐘，期間每 5 秒跟一次進度 */
const APPLY_POLL_MS = 5000;

/** 這台機器目前還在流程中的申請（最多一張：後端擋重複送單） */
function findOpenRequest(list, vmid) {
  return (list ?? [])
    .filter((r) => r.vmid === vmid && isOpenSpecRequest(r))
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0] ?? null;
}

/** 最近一張已套用但自動開機失敗的申請：規格已改，但機器還關著要提醒 */
function findAppliedWithWarning(list, vmid) {
  return (list ?? []).find(
    (r) => r.vmid === vmid && r.status === "approved" && r.apply_status === "applied" && r.apply_error,
  ) ?? null;
}

function OpenRequestNotice({ request, busy, onApply, onCancel }) {
  const display = specRequestDisplayStatus(request);
  const showApply = canApplySpecRequest(request);
  const showCancel = canCancelSpecRequest(request);

  let line;
  switch (display.key) {
    case "pending":
      line = "已送出申請，等待管理員審核。";
      break;
    case "ready":
      line = "申請已通過。按「套用新規格」後，機器會先關機、套用規格、再自動開機。";
      break;
    case "applying":
      line = "正在套用新規格：機器會關機、改完規格後自動開機，請稍候…";
      break;
    case "apply_failed":
      line = `上次套用失敗：${request.apply_error ?? "未知原因"}。可以再試一次。`;
      break;
    case "apply_interrupted":
      line = "套用作業在系統重啟時中斷，規格可能尚未變更。請重新套用。";
      break;
    default:
      line = display.label;
  }

  return (
    <div className={styles.noteBox}>
      <span className={styles.noteBoxTitle}>
        <MIcon name={display.key === "applying" ? "hourglass_top" : "tune"} size={14} />
        規格調整申請 · {display.label}
      </span>
      <span className={styles.noteBoxLine}>{specRequestChangeLabel(request)}</span>
      <span className={styles.noteBoxLine}>{line}</span>
      {(showApply || showCancel) && (
        <div className={styles.noteActions}>
          {showApply && (
            <button type="button" className={styles.btnPrimary} disabled={busy} onClick={onApply}>
              <MIcon name="play_arrow" size={16} />
              {display.key === "ready" ? "套用新規格" : "重新套用"}
            </button>
          )}
          {showCancel && (
            <button type="button" className={styles.btnDangerOutline} disabled={busy} onClick={onCancel}>
              撤銷申請
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default function SpecificationsTab({ vmid }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin" || user?.is_superuser || false;

  const [config, setConfig] = useState(null);
  const [cores, setCores] = useState(1);
  const [memory, setMemory] = useState(512);
  const [reason, setReason] = useState("");
  const [reasonInvalid, setReasonInvalid] = useState(false);
  const reasonRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [openRequest, setOpenRequest] = useState(null);
  const [appliedWarning, setAppliedWarning] = useState(null);

  const loadConfig = useCallback(async () => {
    try {
      const c = await ResourcesService.getConfig(vmid);
      setConfig(c);
      setCores(c.cpu_cores || 1);
      setMemory(c.memory_mb || 512);
    } catch {
      setError(true);
    }
  }, [vmid]);

  /* 管理員直接套用，不走申請；只有一般使用者需要看自己的申請進度 */
  const loadRequests = useCallback(async () => {
    if (isAdmin) return;
    try {
      const res = await SpecChangeRequestsService.listMy();
      setOpenRequest(findOpenRequest(res.data, vmid));
      setAppliedWarning(findAppliedWithWarning(res.data, vmid));
    } catch {
      /* 申請進度載入失敗不影響表單本身 */
    }
  }, [isAdmin, vmid]);

  useEffect(() => {
    loadConfig();
    loadRequests();
  }, [loadConfig, loadRequests]);

  const applying = openRequest?.apply_status === "applying";
  useEffect(() => {
    if (!applying) return undefined;
    const timer = setInterval(async () => {
      const before = openRequest?.id;
      await loadRequests();
      /* 套用完成後 openRequest 會消失；重新載入規格讓「目前」數字更新 */
      if (before) loadConfig();
    }, APPLY_POLL_MS);
    return () => clearInterval(timer);
  }, [applying, openRequest?.id, loadRequests, loadConfig]);

  const handleApply = async () => {
    if (!openRequest) return;
    const ok = await confirm({
      title: "套用新規格？",
      message:
        "若機器正在執行，系統會先關機、套用規格後再自動開機（容器的 CPU／記憶體可線上生效，不會重開）。過程約 1～3 分鐘無法使用，請先儲存機器內的工作。",
      confirmText: "關機並套用",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await SpecChangeRequestsService.apply(openRequest.id);
      setOpenRequest(res.request);
      toast.success("已開始套用新規格，完成後會自動更新");
    } catch (e) {
      toast.error(e?.message ?? "套用失敗，請稍後再試");
      await loadRequests();
    } finally {
      setBusy(false);
    }
  };

  const handleCancel = async () => {
    if (!openRequest) return;
    const ok = await confirm({
      title: "撤銷規格調整申請？",
      message: "撤銷後若還需要調整，需重新送出申請並再次審核。",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await SpecChangeRequestsService.cancel(openRequest.id);
      setOpenRequest(null);
      toast.success("已撤銷規格調整申請");
    } catch (e) {
      toast.error(e?.message ?? "撤銷失敗，請稍後再試");
      await loadRequests();
    } finally {
      setBusy(false);
    }
  };

  const handleSubmit = async () => {
    const hasChanges = cores !== config.cpu_cores || memory !== config.memory_mb;

    if (isAdmin) {
      setBusy(true);
      try {
        await ResourcesService.updateSpecDirect(vmid, {
          cores: cores !== config.cpu_cores ? cores : undefined,
          memory: memory !== config.memory_mb ? memory : undefined,
        });
        toast.success("規格已更新");
        await loadConfig();
      } catch (e) {
        toast.error(e?.message ?? "規格更新失敗");
      } finally {
        setBusy(false);
      }
      return;
    }

    if (reason.trim().length < 10) {
      setReasonInvalid(true);
      focusInvalidField(reasonRef.current);
      return;
    }
    if (!hasChanges) {
      toast.error("沒有變更任何規格");
      return;
    }

    setBusy(true);
    try {
      const created = await SpecChangeRequestsService.create({
        vmid,
        change_type: "combined",
        reason,
        requested_cpu: cores !== config.cpu_cores ? cores : undefined,
        requested_memory: memory !== config.memory_mb ? memory : undefined,
      });
      setOpenRequest(created);
      toast.success("申請已送出，等待管理員審核");
      setReason("");
    } catch (e) {
      toast.error(e?.message ?? "送出申請失敗");
    } finally {
      setBusy(false);
    }
  };

  if (error) return <p className={styles.stateText}>無法載入規格資訊</p>;
  if (!config) return <LoadingState />;

  /* 一張處理中就不能再送（後端也擋），表單只留給管理員或沒有申請時 */
  const formLocked = !isAdmin && Boolean(openRequest);

  return (
    <div className={styles.tabStack}>
      {!isAdmin && appliedWarning && !openRequest && (
        <div className={styles.noteBox}>
          <span className={styles.noteBoxTitle}>
            <MIcon name="warning" size={14} />
            規格已套用，但需要注意
          </span>
          <span className={styles.noteBoxLine}>{appliedWarning.apply_error}</span>
        </div>
      )}

      {openRequest && (
        <OpenRequestNotice
          request={openRequest}
          busy={busy}
          onApply={handleApply}
          onCancel={handleCancel}
        />
      )}

      <div className={styles.card}>
        <div className={styles.cardHeader}>
          <div>
            <h2 className={styles.cardTitle}>規格調整</h2>
            <p className={styles.cardDesc}>
              {isAdmin
                ? "管理員可直接套用新規格（執行中的虛擬機需重開機後 CPU／記憶體才會生效）"
                : formLocked
                  ? "這台機器已有一張處理中的申請，處理完或撤銷後才能再送出新申請"
                  : "送出申請後由管理員審核，通過後由你自己按「套用」，機器會關機、套用後再開機"}
            </p>
          </div>
        </div>
        <div className={styles.cardBody}>
          <div className={styles.formGrid}>
            <div className={styles.field}>
              <label htmlFor="spec-cores">CPU 核心</label>
              <input
                id="spec-cores"
                type="number"
                min={1}
                max={32}
                value={cores}
                disabled={formLocked}
                onChange={(e) => setCores(Number.parseInt(e.target.value, 10) || 1)}
              />
              <span className={styles.fieldHint}>目前：{config.cpu_cores}</span>
            </div>
            <div className={styles.field}>
              <label htmlFor="spec-memory">記憶體 (MB)</label>
              <input
                id="spec-memory"
                type="number"
                min={512}
                max={65536}
                step={512}
                value={memory}
                disabled={formLocked}
                onChange={(e) => setMemory(Number.parseInt(e.target.value, 10) || 512)}
              />
              <span className={styles.fieldHint}>目前：{config.memory_mb} MB</span>
            </div>
          </div>

          {!isAdmin && (
            <div className={`${styles.field} ${reasonInvalid ? styles.fieldInvalid : ""}`}>
              <label htmlFor="spec-reason">申請原因 *</label>
              <textarea
                id="spec-reason"
                ref={reasonRef}
                rows={4}
                placeholder="請說明為什麼需要調整規格（課程需求、負載狀況等）"
                aria-invalid={reasonInvalid}
                value={reason}
                disabled={formLocked}
                onChange={(e) => { setReason(e.target.value); setReasonInvalid(false); }}
              />
              <span className={styles.fieldHint}>至少 10 個字</span>
            </div>
          )}

          <button
            type="button"
            className={styles.btnPrimary}
            disabled={busy || formLocked}
            onClick={handleSubmit}
          >
            {busy ? "處理中…" : isAdmin ? "套用變更" : "送出申請"}
          </button>
        </div>
      </div>

      {!isAdmin && (
        <div className={styles.card}>
          <div className={styles.cardHeader}>
            <h2 className={styles.cardTitle}>審核流程</h2>
          </div>
          <div className={styles.cardBody}>
            <ol className={styles.stepList}>
              <li>送出規格變更申請，附上原因說明</li>
              <li>管理員在「申請審核」頁面審核</li>
              <li>審核通過後，回到這裡或「我的申請」按「套用新規格」</li>
              <li>系統會先關機、套用規格、再自動開機（容器可線上生效，不會重開）</li>
            </ol>
          </div>
        </div>
      )}
    </div>
  );
}
