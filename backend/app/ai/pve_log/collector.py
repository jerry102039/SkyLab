from __future__ import annotations

import logging
import time
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from typing import Any, ParamSpec, TypeVar

from proxmoxer import ProxmoxAPI
from proxmoxer.core import ResourceException

from app.ai.pve_log.config import settings
from app.ai.pve_log.schemas import (
    ClusterInfo,
    NetworkInterface,
    NodeInfo,
    ResourceConfig,
    ResourceStatus,
    ResourceSummary,
    StorageInfo,
    SystemSnapshot,
)
from app.ai.utils import safe_bool, safe_float, safe_int
from app.infrastructure.proxmox import get_proxmox_api

logger = logging.getLogger(__name__)
_Args = ParamSpec("_Args")
_Result = TypeVar("_Result")

def _usage_pct(used: int, total: int) -> float:
    return round(used / total, 4) if total > 0 else 0.0


def _retry(func: Callable[_Args, _Result], *args: _Args.args, **kwargs: _Args.kwargs) -> _Result:
    attempts = max(settings.collector_retry_attempts, 1)
    last_exc: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            return func(*args, **kwargs)
        except Exception as exc:
            last_exc = exc
            if (
                isinstance(exc, ResourceException)
                and 400 <= exc.status_code < 500
                and exc.status_code not in {408, 429}
            ):
                raise
            if attempt >= attempts:
                break
            backoff = settings.collector_retry_backoff * (2 ** (attempt - 1))
            if backoff > 0:
                time.sleep(backoff)
    assert last_exc is not None
    raise last_exc


def _collect_cluster_info(proxmox: ProxmoxAPI) -> ClusterInfo:
    items = proxmox.cluster.status.get()

    cluster_name = None
    node_count = 0
    quorate = False
    version = None

    for item in items:
        if item.get("type") == "cluster":
            cluster_name = item.get("name")
            node_count = safe_int(item.get("nodes"), 0)
            quorate = safe_bool(item.get("quorate"))
            version = safe_int(item.get("version")) or None
        elif item.get("type") == "node":
            if node_count == 0:
                node_count += 1

    return ClusterInfo(
        cluster_name=cluster_name,
        is_cluster=cluster_name is not None,
        node_count=node_count if node_count > 0 else 1,
        quorate=quorate,
        cluster_version=version,
    )


def _collect_nodes(proxmox: ProxmoxAPI) -> list[NodeInfo]:
    items = proxmox.nodes.get()
    result = []
    for item in items:
        mem_used = safe_int(item.get("mem"))
        mem_total = safe_int(item.get("maxmem"))
        disk_used = safe_int(item.get("disk"))
        disk_total = safe_int(item.get("maxdisk"))
        result.append(
            NodeInfo(
                node=str(item.get("node") or "unknown"),
                status=str(item.get("status") or "unknown"),
                cpu_usage=safe_float(item.get("cpu")),
                cpu_cores=safe_int(item.get("maxcpu")),
                mem_used_bytes=mem_used,
                mem_total_bytes=mem_total,
                mem_used_pct=_usage_pct(mem_used, mem_total),
                disk_used_bytes=disk_used,
                disk_total_bytes=disk_total,
                disk_used_pct=_usage_pct(disk_used, disk_total),
                uptime_seconds=safe_int(item.get("uptime")) or None,
            )
        )
    return result


def _collect_storages_for_node(proxmox: ProxmoxAPI, node: str) -> list[StorageInfo]:
    items = proxmox.nodes(node).storage.get()

    result = []
    for item in items:
        avail = safe_int(item.get("avail"))
        used = safe_int(item.get("used"))
        total = safe_int(item.get("total"))
        result.append(
            StorageInfo(
                node=node,
                storage=str(item.get("storage") or item.get("id") or "unknown"),
                storage_type=str(item.get("type") or "unknown"),
                content=str(item.get("content") or ""),
                avail_bytes=avail,
                used_bytes=used,
                total_bytes=total,
                used_pct=_usage_pct(used, total),
                active=safe_bool(item.get("active", 1)),
                enabled=not safe_bool(item.get("disable", 0)),
                shared=safe_bool(item.get("shared", 0)),
            )
        )
    return result


def _collect_resource_summary(item: dict[str, Any]) -> ResourceSummary:
    mem_used = safe_int(item.get("mem"))
    mem_total = safe_int(item.get("maxmem"))
    disk_used = safe_int(item.get("disk"))
    disk_total = safe_int(item.get("maxdisk"))
    return ResourceSummary(
        vmid=safe_int(item.get("vmid")),
        name=str(item.get("name") or ""),
        resource_type=str(item.get("type") or "unknown"),
        node=str(item.get("node") or "unknown"),
        status=str(item.get("status") or "unknown"),
        pool=item.get("pool") or None,
        cpu_usage=safe_float(item.get("cpu")),
        cpu_cores=safe_int(item.get("maxcpu")),
        mem_used_bytes=mem_used,
        mem_total_bytes=mem_total,
        mem_used_pct=_usage_pct(mem_used, mem_total),
        disk_used_bytes=disk_used,
        disk_total_bytes=disk_total,
        disk_used_pct=_usage_pct(disk_used, disk_total),
        net_in_bytes=safe_int(item.get("netin")),
        net_out_bytes=safe_int(item.get("netout")),
        uptime_seconds=safe_int(item.get("uptime")) or None,
        is_template=safe_bool(item.get("template", 0)),
    )


def _collect_resource_status(proxmox: ProxmoxAPI, node: str, vmid: int, resource_type: str) -> ResourceStatus | None:
    if resource_type == "qemu":
        s = proxmox.nodes(node).qemu(vmid).status.current.get()
    else:
        s = proxmox.nodes(node).lxc(vmid).status.current.get()

    mem_used = safe_int(s.get("mem"))
    mem_total = safe_int(s.get("maxmem"))
    return ResourceStatus(
        vmid=vmid,
        node=node,
        resource_type=resource_type,
        status=str(s.get("status") or "unknown"),
        cpu_usage=safe_float(s.get("cpu")),
        cpu_cores=safe_int(s.get("cpus") or s.get("maxcpu")),
        mem_used_bytes=mem_used,
        mem_total_bytes=mem_total,
        mem_used_pct=_usage_pct(mem_used, mem_total),
        disk_read_bytes=safe_int(s.get("diskread")),
        disk_write_bytes=safe_int(s.get("diskwrite")),
        disk_total_bytes=safe_int(s.get("maxdisk")),
        net_in_bytes=safe_int(s.get("netin")),
        net_out_bytes=safe_int(s.get("netout")),
        uptime_seconds=safe_int(s.get("uptime")) or None,
        pid=safe_int(s.get("pid")) or None,
    )


def _collect_resource_config(proxmox: ProxmoxAPI, node: str, vmid: int, resource_type: str) -> ResourceConfig | None:
    if resource_type == "qemu":
        c = proxmox.nodes(node).qemu(vmid).config.get()
    else:
        c = proxmox.nodes(node).lxc(vmid).config.get()

    disk_key = "scsi0" if resource_type == "qemu" else "rootfs"
    disk_str = c.get(disk_key, "")
    disk_size_gb = None
    if "size=" in disk_str:
        size_part = disk_str.split("size=")[1].split(",")[0].strip()
        if size_part.endswith("G"):
            try:
                disk_size_gb = int(size_part[:-1])
            except ValueError:
                # size 解析失敗時保留 disk_size_gb=None
                pass

    name_key = "name" if resource_type == "qemu" else "hostname"
    return ResourceConfig(
        vmid=vmid,
        node=node,
        resource_type=resource_type,
        name=c.get(name_key) or None,
        cpu_cores=safe_int(c.get("cores") or c.get("cpus")) or None,
        cpu_type=c.get("cpu") or None,
        memory_mb=safe_int(c.get("memory")) or None,
        disk_info=disk_str or None,
        disk_size_gb=disk_size_gb,
        os_type=c.get("ostype") or None,
        net0=c.get("net0") or None,
        description=c.get("description") or None,
        tags=c.get("tags") or None,
        onboot=safe_bool(c.get("onboot", 0)),
        protection=safe_bool(c.get("protection", 0)),
        raw=dict(c),
    )


def _collect_lxc_interfaces(proxmox: ProxmoxAPI, node: str, vmid: int) -> list[NetworkInterface]:
    items = proxmox.nodes(node).lxc(vmid).interfaces.get()
    result = []
    for iface in items or []:
        result.append(
            NetworkInterface(
                vmid=vmid,
                name=str(iface.get("name") or "unknown"),
                inet=iface.get("inet") or None,
                inet6=iface.get("inet6") or None,
                hwaddr=iface.get("hwaddr") or None,
            )
        )
    return result


def collect_snapshot() -> SystemSnapshot:
    started = time.monotonic()
    errors: list[str] = []
    proxmox = get_proxmox_api()

    logger.info("收集叢集資訊...")
    try:
        cluster = _retry(_collect_cluster_info, proxmox)
    except Exception as exc:
        logger.error("收集叢集資訊失敗：%s", exc)
        errors.append(f"叢集資訊：{exc}")
        cluster = ClusterInfo(
            cluster_name=None,
            is_cluster=False,
            node_count=0,
            quorate=False,
            cluster_version=None,
        )

    logger.info("收集節點資料...")
    try:
        nodes = _retry(_collect_nodes, proxmox)
    except Exception as exc:
        logger.error("收集節點失敗：%s", exc)
        errors.append(f"節點清單：{exc}")
        nodes = []

    node_names = [n.node for n in nodes]

    logger.info("收集儲存空間資料（%d 個節點）...", len(node_names))
    storages: list[StorageInfo] = []
    with ThreadPoolExecutor(max_workers=settings.collector_max_workers) as pool:
        futures: dict[Future[list[StorageInfo]], str] = {
            pool.submit(_retry, _collect_storages_for_node, proxmox, node): node
            for node in node_names
        }
        for storage_future in as_completed(futures):
            try:
                storages.extend(storage_future.result())
            except Exception as exc:
                node = futures[storage_future]
                errors.append(f"節點 {node} 儲存空間：{exc}")

    logger.info("收集 VM/LXC 摘要...")
    try:
        raw_resources = _retry(lambda: proxmox.cluster.resources.get(type="vm"))
    except Exception as exc:
        logger.error("收集 cluster.resources 失敗：%s", exc)
        errors.append(f"cluster.resources：{exc}")
        raw_resources = []

    all_resources: list[ResourceSummary] = []
    running_resources: list[tuple[str, int, str]] = []

    for item in raw_resources:
        if safe_bool(item.get("template", 0)):
            continue
        summary = _collect_resource_summary(item)
        all_resources.append(summary)
        if summary.status == "running":
            running_resources.append((summary.node, summary.vmid, summary.resource_type))

    logger.info("共 %d 個資源（VM/LXC），%d 個運行中", len(all_resources), len(running_resources))

    logger.info("收集即時狀態（%d 個 running 資源）...", len(running_resources))
    resource_statuses: list[ResourceStatus] = []
    with ThreadPoolExecutor(max_workers=settings.collector_max_workers) as pool:
        futures_status: dict[Future[ResourceStatus | None], tuple[str, int, str]] = {
            pool.submit(_retry, _collect_resource_status, proxmox, node, vmid, rtype): (node, vmid, rtype)
            for node, vmid, rtype in running_resources
        }
        for status_future in as_completed(futures_status):
            try:
                status_result = status_future.result()
                if status_result is not None:
                    resource_statuses.append(status_result)
            except Exception as exc:
                node, vmid, rtype = futures_status[status_future]
                errors.append(f"{rtype} {vmid} 狀態：{exc}")

    resource_configs: list[ResourceConfig] = []
    if settings.collector_fetch_config:
        all_vmid_list = [(r.node, r.vmid, r.resource_type) for r in all_resources]
        logger.info("收集設定檔（%d 個資源）...", len(all_vmid_list))
        with ThreadPoolExecutor(max_workers=settings.collector_max_workers) as pool:
            futures_cfg: dict[Future[ResourceConfig | None], tuple[str, int, str]] = {
                pool.submit(_retry, _collect_resource_config, proxmox, node, vmid, rtype): (node, vmid, rtype)
                for node, vmid, rtype in all_vmid_list
            }
            for config_future in as_completed(futures_cfg):
                try:
                    config_result = config_future.result()
                    if config_result is not None:
                        resource_configs.append(config_result)
                except Exception as exc:
                    node, vmid, rtype = futures_cfg[config_future]
                    errors.append(f"{rtype} {vmid} 設定：{exc}")

    network_interfaces: list[NetworkInterface] = []
    if settings.collector_fetch_lxc_interfaces:
        lxc_list = [
            (r.node, r.vmid)
            for r in all_resources
            if r.resource_type == "lxc" and r.status == "running"
        ]
        logger.info("收集 LXC 網路介面（%d 個容器）...", len(lxc_list))
        with ThreadPoolExecutor(max_workers=settings.collector_max_workers) as pool:
            futures_iface: dict[Future[list[NetworkInterface]], tuple[str, int]] = {
                pool.submit(_retry, _collect_lxc_interfaces, proxmox, node, vmid): (node, vmid)
                for node, vmid in lxc_list
            }
            for interface_future in as_completed(futures_iface):
                try:
                    network_interfaces.extend(interface_future.result())
                except Exception as exc:
                    node, vmid = futures_iface[interface_future]
                    errors.append(f"LXC {vmid} 網路介面：{exc}")

    total_vms = sum(1 for r in all_resources if r.resource_type == "qemu")
    total_lxc = sum(1 for r in all_resources if r.resource_type == "lxc")
    running_vms = sum(1 for r in all_resources if r.resource_type == "qemu" and r.status == "running")
    running_lxc = sum(1 for r in all_resources if r.resource_type == "lxc" and r.status == "running")
    online_nodes = sum(1 for n in nodes if n.status == "online")

    duration = round(time.monotonic() - started, 3)
    logger.info(
        "收集完成：耗時 %.2f 秒，節點 %d，VM %d，LXC %d，錯誤 %d 筆",
        duration,
        len(nodes),
        total_vms,
        total_lxc,
        len(errors),
    )

    return SystemSnapshot(
        collected_at=datetime.now(timezone.utc),
        collection_duration_seconds=duration,
        cluster=cluster,
        nodes=nodes,
        storages=storages,
        resources=all_resources,
        resource_statuses=resource_statuses,
        resource_configs=resource_configs,
        network_interfaces=network_interfaces,
        errors=errors,
        total_nodes=len(nodes),
        online_nodes=online_nodes,
        total_vms=total_vms,
        total_lxc=total_lxc,
        running_vms=running_vms,
        running_lxc=running_lxc,
    )
