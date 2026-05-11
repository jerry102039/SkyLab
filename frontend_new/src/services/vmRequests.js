import { apiGet, apiPost } from "./api";

export const VmRequestsService = {
  /** 取得我的申請列表 */
  list() {
    return apiGet("/api/v1/vm-requests/my");
  },

  /** 送出申請 */
  create(body) {
    return apiPost("/api/v1/vm-requests/", body);
  },

  /** 撤銷申請（pending / approved / provisioning） */
  cancel(requestId) {
    return apiPost(`/api/v1/vm-requests/${requestId}/cancel`, {});
  },

  /** 重試佈建（approved 且上次佈建失敗） */
  retry(requestId) {
    return apiPost(`/api/v1/vm-requests/${requestId}/retry`, {});
  },
};
