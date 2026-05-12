import Logger from "../core/Logger";
import CampusCloudService from "../service/CampusCloudService";
import ResponseUtils from "../utils/ResponseUtils";
import BaseController from "./BaseController";

class ResourceController extends BaseController {
  private readonly _campusCloudService: CampusCloudService;

  constructor(campusCloudService: CampusCloudService) {
    super();
    this._campusCloudService = campusCloudService;
  }

  listMyResources(req: ControllerParam) {
    this._campusCloudService
      .listResources()
      .then(data => {
        req.event.reply(req.channel, ResponseUtils.success(data));
      })
      .catch((err: Error) => {
        Logger.error("ResourceController.listMyResources", err);
        req.event.reply(req.channel, ResponseUtils.fail(err));
      });
  }

  /**
   * Aggregates session-status for every running VM the user owns. The
   * renderer polls this so a single IPC round-trip surfaces all warnings.
   * Per-VM failures don't fail the whole call — they're logged and skipped.
   */
  async getSessionStatuses(req: ControllerParam) {
    try {
      const resources = await this._campusCloudService.listResources();
      const runningVmids = resources
        .filter(r => r.status === "running" && typeof r.vmid === "number")
        .map(r => r.vmid);
      const results = await Promise.all(
        runningVmids.map(vmid =>
          this._campusCloudService.getSessionStatus(vmid).catch(err => {
            Logger.warn(
              "ResourceController.getSessionStatuses",
              `vmid=${vmid} failed: ${(err as Error).message}`
            );
            return null;
          })
        )
      );
      const statuses = results.filter(
        (s): s is CampusCloudSessionStatus => s !== null
      );
      req.event.reply(req.channel, ResponseUtils.success(statuses));
    } catch (err) {
      Logger.error("ResourceController.getSessionStatuses", err as Error);
      req.event.reply(req.channel, ResponseUtils.fail(err as Error));
    }
  }

  extendSession(req: ControllerParam) {
    const vmid = req.args?.vmid as number | undefined;
    if (typeof vmid !== "number") {
      req.event.reply(
        req.channel,
        ResponseUtils.fail(new Error("vmid is required"))
      );
      return;
    }
    this._campusCloudService
      .extendSession(vmid)
      .then(data => {
        req.event.reply(req.channel, ResponseUtils.success(data));
      })
      .catch((err: Error) => {
        Logger.error("ResourceController.extendSession", err);
        req.event.reply(req.channel, ResponseUtils.fail(err));
      });
  }
}

export default ResourceController;
