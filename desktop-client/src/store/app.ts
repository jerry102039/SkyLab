import { on, onListener, send } from "@/utils/ipcUtils";
import { defineStore } from "pinia";
import { ipcRouters, listeners } from "../../electron/core/IpcRouter";

interface AppState {
  loggedIn: boolean;
  loginInProgress: boolean;
  language: string;
  autoStart: boolean;
  tunnelStatus: TunnelStatusInfo;
  resources: CampusCloudResource[];
  sessionStatuses: CampusCloudSessionStatus[];
  /** vmids the user already snoozed so we don't re-pop while still warning. */
  dismissedWarnings: number[];
}

const DEFAULT_TUNNEL_STATUS: TunnelStatusInfo = {
  running: false,
  lastStartTime: -1,
  connectionError: null,
  tunnels: []
};

/** Poll cadence for the session-status warning system; matches the web hook
 * (which is itself anchored to the backend's 30 min ``practice_warning_minutes``). */
const SESSION_POLL_INTERVAL_MS = 30_000;
let sessionPollTimer: ReturnType<typeof setInterval> | null = null;

export const useAppStore = defineStore("app", {
  state: (): AppState => ({
    loggedIn: false,
    loginInProgress: false,
    language: "zh-CN",
    autoStart: false,
    tunnelStatus: { ...DEFAULT_TUNNEL_STATUS },
    resources: [],
    sessionStatuses: [],
    dismissedWarnings: []
  }),
  getters: {
    /** First not-yet-dismissed warning, used to drive the global alert. */
    activeWarning(state): CampusCloudSessionStatus | null {
      return (
        state.sessionStatuses.find(
          s => s.should_warn && !state.dismissedWarnings.includes(s.vmid)
        ) ?? null
      );
    }
  },
  actions: {
    registerListeners() {
      on(ipcRouters.AUTH.getAuthState, data => {
        this.loggedIn = !!data.loggedIn;
        this.loginInProgress = !!data.loginInProgress;
      });
      on(ipcRouters.SETTINGS.getSettings, data => {
        if (data) {
          this.language = data.language || "zh-CN";
          this.autoStart = !!data.launchAtStartup;
        }
      });
      on(ipcRouters.SETTINGS.saveSettings, data => {
        if (data) {
          this.language = data.language || this.language;
          this.autoStart = !!data.launchAtStartup;
        }
      });
      on(ipcRouters.RESOURCE.listMyResources, data => {
        this.resources = Array.isArray(data) ? data : [];
      });
      on(ipcRouters.SESSION.getSessionStatuses, data => {
        const next: CampusCloudSessionStatus[] = Array.isArray(data) ? data : [];
        this.sessionStatuses = next;
        // Forget dismissals once the corresponding query says should_warn=false
        // — otherwise the user can't see future warnings on the same VM.
        this.dismissedWarnings = this.dismissedWarnings.filter(vmid => {
          const status = next.find(s => s.vmid === vmid);
          return status && status.should_warn;
        });
      });
      on(ipcRouters.SESSION.extendSession, () => {
        // Refresh statuses immediately so the dialog dismisses naturally.
        this.refreshSessionStatuses();
      });
      onListener(listeners.watchTunnel, (data: TunnelStatusInfo) => {
        this.tunnelStatus = data;
      });
    },
    refreshAuth() {
      send(ipcRouters.AUTH.getAuthState);
    },
    refreshSettings() {
      send(ipcRouters.SETTINGS.getSettings);
    },
    refreshResources() {
      send(ipcRouters.RESOURCE.listMyResources);
    },
    refreshSessionStatuses() {
      if (!this.loggedIn) return;
      send(ipcRouters.SESSION.getSessionStatuses);
    },
    extendSession(vmid: number) {
      send(ipcRouters.SESSION.extendSession, { vmid });
    },
    dismissWarning(vmid: number) {
      if (!this.dismissedWarnings.includes(vmid)) {
        this.dismissedWarnings.push(vmid);
      }
    },
    /** Begin / restart the polling timer. Idempotent. */
    startSessionPolling() {
      if (sessionPollTimer) return;
      this.refreshSessionStatuses();
      sessionPollTimer = setInterval(() => {
        this.refreshSessionStatuses();
      }, SESSION_POLL_INTERVAL_MS);
    },
    stopSessionPolling() {
      if (sessionPollTimer) {
        clearInterval(sessionPollTimer);
        sessionPollTimer = null;
      }
      this.sessionStatuses = [];
      this.dismissedWarnings = [];
    },
    logout() {
      send(ipcRouters.AUTH.logout);
      this.loggedIn = false;
      this.stopSessionPolling();
    }
  }
});
