<script lang="ts">
import { ElConfigProvider, ElMessageBox } from "element-plus";
import en from "element-plus/dist/locale/en.mjs";
import zhCn from "element-plus/dist/locale/zh-cn.mjs";
import { defineComponent, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useAppStore } from "./store/app";

export default defineComponent({
  name: "App",
  components: {
    [ElConfigProvider.name]: ElConfigProvider
  },
  setup() {
    const appStore = useAppStore();
    const { t } = useI18n();

    // Start / stop the session-status poller as the user logs in & out.
    watch(
      () => appStore.loggedIn,
      loggedIn => {
        if (loggedIn) appStore.startSessionPolling();
        else appStore.stopSessionPolling();
      },
      { immediate: true }
    );

    // When the active warning changes, surface an Element Plus message box.
    // We reset the per-vmid dismissal flag inside the dialog handlers, NOT
    // by closing the box — so closing the alert always counts as "snooze".
    let dialogOpen = false;
    watch(
      () => appStore.activeWarning,
      async warning => {
        if (!warning || dialogOpen) return;
        const isExpiry = warning.warn_reason === "expiry";
        const title = isExpiry
          ? t("sessionWarning.expiryTitle")
          : t("sessionWarning.autoStopTitle");
        const message = isExpiry
          ? t("sessionWarning.expiryBody", {
              vmid: warning.vmid,
              hours: warning.hours_until_expiry ?? "?"
            })
          : t("sessionWarning.autoStopBody", {
              vmid: warning.vmid,
              minutes: warning.minutes_until_stop ?? "?"
            });
        const showExtend = !isExpiry && warning.can_extend;
        dialogOpen = true;
        try {
          await ElMessageBox({
            title,
            message,
            type: isExpiry ? "error" : "warning",
            confirmButtonText: showExtend
              ? t("sessionWarning.extend")
              : t("sessionWarning.gotIt"),
            cancelButtonText: showExtend
              ? t("sessionWarning.later")
              : t("common.cancel"),
            showCancelButton: showExtend,
            distinguishCancelAndClose: true
          });
          // confirm clicked
          if (showExtend) {
            appStore.extendSession(warning.vmid);
          } else {
            appStore.dismissWarning(warning.vmid);
          }
        } catch (action) {
          // cancel ("later") OR close ("X") — both treated as dismiss-for-now.
          appStore.dismissWarning(warning.vmid);
        } finally {
          dialogOpen = false;
        }
      }
    );

    return {
      currentLocale: () =>
        useAppStore().language === "zh-CN" ? zhCn : en
    };
  },
  computed: {
    currentLocale() {
      return useAppStore().language === "zh-CN" ? zhCn : en;
    }
  }
});
</script>

<template>
  <el-config-provider :locale="currentLocale">
    <router-view />
  </el-config-provider>
</template>
