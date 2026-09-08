import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Background,
  Handle,
  Position,
  ReactFlow,
  useNodesState,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import LoadingState from "../../../components/LoadingState/LoadingState";
import MIcon from "../../../components/MIcon";
import { useConfirm } from "../../../components/ConfirmDialog/ConfirmProvider";
import { CourseEnvironmentsService } from "../../../services/courseEnvironments";
import { TeachingClassesService } from "../../../services/teachingClasses";
import { apiGet } from "../../../services/api";
import EmptyState from "../../../components/EmptyState/EmptyState";
import { TemplatesService } from "../../../services/templates";
import ConnectionEdge from "../../network/firewall/edges/ConnectionEdge";
import styles from "../CourseOperations.module.scss";
import PageHeader from "../../../components/PageHeader/PageHeader";
import i18n from "../../../i18n";

const TABS = [
  ["basic", "CourseTemplateEditorPage.tabBasicLabel"],
  ["machines", "CourseTemplateEditorPage.tabMachinesLabel"],
];

function makeEmptyTemplate() {
  return { id: "new", name: "", description: "", usageScope: "course", audience: "class", audienceClassIds: [], maxConcurrentSessions: null, status: "draft", classes: 0, updatedAt: i18n.t("CourseTemplateEditorPage.notSavedYet", { ns: "teaching" }), nodes: [], edges: [], publications: [] };
}

const FIREWALL_PROTOCOLS = ["tcp", "udp", "icmp", "icmpv6", "sctp"];

/** 規格滑桿範圍；後端上限為 64 核 / 128 GB RAM / 2000 GB Disk，這裡取教學情境的保守值。 */
const CPU_RANGE = [1, 32];
const MEMORY_RANGE = [1, 64];
const LXC_DISK_RANGE = [1, 1000];
const VM_DISK_RANGE = [10, 1000];

/** 一條連線實際授予的方向：單向一個，雙向兩個。 */
function edgeGrants(edge) {
  const pairs = [[edge.source, edge.target]];
  if (edge.direction === "bidirectional") pairs.push([edge.target, edge.source]);
  return pairs.map(([source, target]) => ({ source, target, protocol: edge.protocol, port: edge.port }));
}

/**
 * 這條連線是否與既有連線重疊。
 * 比對授予的方向而非欄位組合，才抓得到「A→B 單向」被「A↔B 雙向」涵蓋、
 * 以及「A↔B」與「B↔A」其實是同一件事。舊資料的 "any" 不分協定與 port。
 */
function overlapsExistingEdge(candidate, existingEdges) {
  const wanted = edgeGrants(candidate);
  return existingEdges.some((edge) => edge.id !== candidate.id && edgeGrants(edge).some((granted) => wanted.some((want) => (
    granted.source === want.source
    && granted.target === want.target
    && (granted.protocol === "any" || want.protocol === "any"
      || (granted.protocol === want.protocol && Number(granted.port) === Number(want.port)))
  ))));
}

/** LXC 映像是 tarball，檔名直接當機器名稱又臭又長，去掉封裝副檔名。 */
function stripImageExtension(name) {
  return String(name).replace(/\.tar(\.(gz|xz|zst|bz2|lzo))?$/i, "");
}

function TopologyMachineNode({ data, selected, isConnectable }) {
  const { t } = useTranslation("teaching");
  const node = data.node;
  return <div className={`${styles.flowMachineNode} ${selected ? styles.flowMachineNodeSelected : ""}`}>
    <Handle type="target" position={Position.Left} isConnectable={isConnectable} />
    <div className={styles.flowNodeIcon}><MIcon name={node.type === "lxc" ? "deployed_code" : "dns"} size={18} /></div>
    <div className={styles.flowNodeLabel}>
      <strong title={node.name}>{node.name}</strong>
      <span>{node.sourceType === "custom" ? t("CourseTemplateEditorPage.sourceCustomShort") : t("CourseTemplateEditorPage.sourceTemplateShort")} · {node.type === "lxc" ? t("CourseTemplateEditorPage.typeContainerLxc") : t("CourseTemplateEditorPage.typeVm")}</span>
      <small>{node.cpu} CPU · {node.memory} GB RAM · {node.disk} GB</small>
    </div>
    <Handle type="source" position={Position.Right} isConnectable={isConnectable} />
  </div>;
}

const TOPOLOGY_NODE_TYPES = { courseMachine: TopologyMachineNode };
const TOPOLOGY_EDGE_TYPES = { connection: ConnectionEdge };

function MachineEditor({ value, edges, publications, onChange, onEdgesChange, onPublicationsChange, pveTemplates, vmImages, lxcImages, zones, sourceNotice, locked = false }) {
  const { t } = useTranslation("teaching");
  const [sourceMode, setSourceMode] = useState("template");
  const [sourceId, setSourceId] = useState("");
  const [customType, setCustomType] = useState("qemu");
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const [selectedEdgeId, setSelectedEdgeId] = useState("");
  const [flowNodes, setFlowNodes, onFlowNodesChange] = useNodesState([]);
  const [topologyNotice, setTopologyNotice] = useState("");
  const atLimit = value.length >= 3;

  function addMachine() {
    if (atLimit || !sourceId) return;
    const nodeId = `node-${Date.now()}`;
    if (sourceMode === "template") {
      const source = pveTemplates.find((item) => String(item.id) === sourceId);
      if (!source) return;
      onChange([...value, {
        id: nodeId, sourceType: "template", sourceTemplateId: source.id, name: source.name, role: t("CourseTemplateEditorPage.defaultMachineRole"),
        type: String(source.resource_type).toLowerCase() === "lxc" ? "lxc" : "qemu", image: source.name, cpu: source.default_cores ?? 2,
        memory: Math.max(1, Math.round((source.default_memory ?? 2048) / 1024)), disk: source.default_disk ?? 24,
        network: "lab-net", icon: "dns", positionX: 60 + value.length * 260, positionY: 120,
      }]);
    } else {
      const source = (customType === "lxc" ? lxcImages : vmImages).find((item) => String(item.value) === sourceId);
      if (!source) return;
      onChange([...value, {
        id: nodeId, sourceType: "custom", sourceTemplateId: null, customImageRef: source.value,
        customUsername: "student", customUnprivileged: true,
        name: stripImageExtension(source.label.split(" · ")[0]), role: t("CourseTemplateEditorPage.defaultMachineRole"), type: customType, image: source.label,
        cpu: customType === "lxc" ? 2 : (source.cores ?? 2),
        memory: customType === "lxc" ? 2 : Math.max(1, Math.round((source.memoryMb ?? 2048) / 1024)),
        disk: customType === "lxc" ? 8 : Math.max(VM_DISK_RANGE[0], source.diskGb ?? 20),
        network: "lab-net", icon: "dns",
        positionX: 60 + value.length * 260, positionY: 120,
      }]);
    }
    setSelectedNodeId(nodeId);
    setSelectedEdgeId("");
    setSourceId("");
  }

  function removeMachine(nodeId) {
    onChange(value.filter((item) => item.id !== nodeId));
    onEdgesChange(edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId));
    onPublicationsChange(publications.filter((item) => item.nodeKey !== nodeId));
    setSelectedNodeId("");
  }

  function addPublication(node) {
    const used = new Set(publications.filter((item) => item.nodeKey === node.id).map((item) => `${item.port}/${item.protocol}`));
    const port = [80, 443, 8080, 3000, 5678].find((candidate) => !used.has(`${candidate}/tcp`)) ?? 8000;
    onPublicationsChange([...publications, {
      id: `publication-${Date.now()}`,
      nodeKey: node.id,
      mode: zones.length ? "domain" : "firewall_only",
      port,
      protocol: "tcp",
      // 樣板必須帶 {student}，否則全班會搶同一個網址
      hostnamePrefix: `{student}-${String(node.id).replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase().slice(0, 20).replace(/^-|-$/g, "") || "app"}`,
      zoneId: zones[0]?.id ?? "",
      enableHttps: true,
    }]);
  }

  function patchPublication(publicationId, patch) {
    onPublicationsChange(publications.map((item) => item.id === publicationId ? { ...item, ...patch } : item));
  }

  function removePublication(publicationId) {
    onPublicationsChange(publications.filter((item) => item.id !== publicationId));
  }

  function connect(connection) {
    if (locked || connection.source === connection.target) return;
    const edge = {
      id: `edge-${Date.now()}`,
      source: connection.source,
      target: connection.target,
      direction: "one_way",
      protocol: "tcp",
      port: 22,
    };
    if (overlapsExistingEdge(edge, edges)) {
      setTopologyNotice(t("CourseTemplateEditorPage.overlappingEdgeNotice"));
      return;
    }
    setTopologyNotice("");
    onEdgesChange([...edges, edge]);
    setSelectedEdgeId(edge.id);
    setSelectedNodeId("");
  }

  function patchNode(nodeId, patch) {
    onChange(value.map((item) => item.id === nodeId ? { ...item, ...patch } : item));
  }

  function patchEdge(patch) {
    const current = edges.find((edge) => edge.id === selectedEdgeId);
    if (!current) return;
    const next = { ...current, ...patch };
    // 改成雙向或換 port 都可能撞到既有連線，改之前先擋，別等存檔才失敗。
    if (overlapsExistingEdge(next, edges)) {
      setTopologyNotice(t("CourseTemplateEditorPage.overlappingEdgeNotice"));
      return;
    }
    setTopologyNotice("");
    onEdgesChange(edges.map((edge) => edge.id === selectedEdgeId ? next : edge));
  }

  function removeEdge(edgeId) {
    onEdgesChange(edges.filter((edge) => edge.id !== edgeId));
    setSelectedEdgeId("");
  }

  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId);
  const selectedNode = value.find((node) => node.id === selectedNodeId) ?? (!selectedEdge ? value[0] : null);
  // 來自 PVE 範本的機器沿用範本規格，只有自訂規格可調整。
  const specLocked = locked || selectedNode?.sourceType !== "custom";
  // 自訂規格的 VM 其實也是克隆一台 PVE 範本機，磁碟不可小於該範本。
  const customVmImage = selectedNode?.sourceType === "custom" && selectedNode?.type !== "lxc"
    ? vmImages.find((item) => item.value === String(selectedNode.customImageRef))
    : null;
  const vmDiskFloor = Math.max(VM_DISK_RANGE[0], Number(customVmImage?.diskGb) || 0);
  const diskRange = selectedNode?.type === "lxc"
    ? LXC_DISK_RANGE
    : [vmDiskFloor, Math.max(VM_DISK_RANGE[1], vmDiskFloor)];

  const nodePublications = publications.filter((item) => item.nodeKey === selectedNode?.id);

  /** 給老師看的示範網址：{student} 換成一個代表性的帳號。 */
  function previewDomain(publication) {
    const zone = zones.find((item) => item.id === publication.zoneId);
    const hostname = String(publication.hostnamePrefix || "").replace("{student}", "alice");
    return zone ? `${hostname}.${zone.name}` : hostname;
  }

  // 範本清單是非同步載入的，既有節點可能存著低於下限的磁碟值，補正一次。
  useEffect(() => {
    if (specLocked || !selectedNode || selectedNode.disk >= diskRange[0]) return;
    patchNode(selectedNode.id, { disk: diskRange[0] });
  }, [specLocked, selectedNode, diskRange[0]]);
  // 畫布節點交給 ReactFlow 自己維護：拖曳時只更新畫布，不會讓整個編輯器重繪。
  // 已在畫布上的節點沿用當下位置，避免規格變更把拖到一半的節點彈回去。
  useEffect(() => {
    setFlowNodes((previous) => {
      const placed = new Map(previous.map((item) => [item.id, item.position]));
      return value.map((node, index) => ({
        id: String(node.id),
        type: "courseMachine",
        position: placed.get(String(node.id)) ?? {
          x: Number(node.positionX ?? (60 + index * 260)),
          y: Number(node.positionY ?? (120 + (index % 2) * 45)),
        },
        data: { node },
        selected: selectedNode?.id === node.id,
      }));
    });
  }, [value, selectedNode?.id, setFlowNodes]);

  // 位置只在放開滑鼠時回寫，一次拖曳只產生一筆變更。
  const commitNodePositions = useCallback((_event, _node, draggedNodes) => {
    const moved = new Map(draggedNodes.map((item) => [item.id, item.position]));
    onChange(value.map((node) => {
      const position = moved.get(String(node.id));
      return position
        ? { ...node, positionX: Math.round(position.x), positionY: Math.round(position.y) }
        : node;
    }));
  }, [onChange, value]);

  const graphEdges = useMemo(() => edges.map((edge) => ({
    ...edge,
    type: "connection",
    data: {
      edge: {
        course_edge_id: edge.id,
        source_vmid: edge.source,
        target_vmid: edge.target,
      },
      label: `${edge.direction === "bidirectional" ? t("CourseTemplateEditorPage.directionBidirectional") : t("CourseTemplateEditorPage.directionOneWay")} · ${edge.protocol}${edge.port ? `/${edge.port}` : ""}`,
      showLabel: true,
      onSelect: () => { setSelectedEdgeId(edge.id); setSelectedNodeId(""); },
      onDelete: locked ? null : () => removeEdge(edge.id),
    },
    zIndex: 5,
  })), [edges, locked, t]);

  return <section className={`${styles.card} ${styles.templateMachineWorkspace}`}>
      <div className={styles.machineWorkspaceHeader}>
        <div><h2>{t("CourseTemplateEditorPage.multiMachineEnvTitle")}</h2><p>{t("CourseTemplateEditorPage.topologyHelpText")}</p></div>
        <span className={styles.nodeLimit}>{t("CourseTemplateEditorPage.nodeLimitLabel", { count: value.length })}</span>
      </div>
      {sourceNotice && <p className={styles.persistentFeedback}><MIcon name="info" size={17} />{sourceNotice}</p>}
      {topologyNotice && <p className={styles.persistentFeedback}><MIcon name="info" size={17} />{topologyNotice}</p>}
      <div className={styles.machineAddBar}>
        <label className={styles.field}><span>{t("CourseTemplateEditorPage.fieldSourceMode")}</span><select value={sourceMode} disabled={locked || atLimit} onChange={(event) => { setSourceMode(event.target.value); setSourceId(""); }}><option value="template">{t("CourseTemplateEditorPage.sourceModeTemplateOption")}</option><option value="custom">{t("CourseTemplateEditorPage.sourceModeCustomOption")}</option></select></label>
        {sourceMode === "custom" && <label className={styles.field}><span>{t("CourseTemplateEditorPage.fieldMachineType")}</span><select value={customType} disabled={locked || atLimit} onChange={(event) => { setCustomType(event.target.value); setSourceId(""); }}><option value="qemu">VM</option><option value="lxc">LXC</option></select></label>}
        <label className={styles.field}><span>{sourceMode === "template" ? t("CourseTemplateEditorPage.sourceExistingTemplate") : t("CourseTemplateEditorPage.fieldBaseImage")}</span><select value={sourceId} disabled={locked || atLimit} onChange={(event) => setSourceId(event.target.value)}><option value="">{locked ? t("CourseTemplateEditorPage.publishedLockedOption") : atLimit ? t("CourseTemplateEditorPage.atLimitOption") : t("CourseTemplateEditorPage.pleaseSelectOption")}</option>{sourceMode === "template" ? pveTemplates.map((source) => <option key={source.id} value={source.id}>{source.name} · {source.resource_type ?? "VM"}</option>) : (customType === "lxc" ? lxcImages : vmImages).map((source) => <option key={source.value} value={source.value}>{source.label}</option>)}</select></label>
        <button type="button" className={styles.btnPrimary} disabled={locked || atLimit || !sourceId} onClick={addMachine}><MIcon name={atLimit ? "check" : "add"} size={16} />{atLimit ? t("CourseTemplateEditorPage.atLimitBtn") : t("CourseTemplateEditorPage.addMachineBtn")}</button>
      </div>
      {value.length ? <>
        <div className={styles.topologyWorkspace}>
          <div className={styles.topologyCanvas}><ReactFlow
            nodes={flowNodes}
            edges={graphEdges}
            nodeTypes={TOPOLOGY_NODE_TYPES}
            edgeTypes={TOPOLOGY_EDGE_TYPES}
            onConnect={connect}
            onNodesChange={onFlowNodesChange}
            onNodeDragStop={commitNodePositions}
            onNodeClick={(_, node) => { setSelectedNodeId(node.id); setSelectedEdgeId(""); }}
            onEdgeClick={(_, edge) => { setSelectedEdgeId(edge.id); setSelectedNodeId(""); }}
            nodesDraggable={!locked}
            nodesConnectable={!locked}
            connectionLineStyle={{ stroke: "#4f6fdc", strokeWidth: 3 }}
            elementsSelectable
            minZoom={0.7}
            maxZoom={1.4}
            fitView
            fitViewOptions={{ padding: 0.22, maxZoom: 1.1 }}
            proOptions={{ hideAttribution: true }}
          ><Background gap={20} size={1} /></ReactFlow></div>
          <aside className={styles.topologyInspector}>
            {selectedEdge ? <>
              <div className={styles.inspectorTitle}><MIcon name="link" size={18} /><div><strong>{t("CourseTemplateEditorPage.connectionRuleTitle")}</strong><small>{value.find((node) => node.id === selectedEdge.source)?.name} → {value.find((node) => node.id === selectedEdge.target)?.name}</small></div></div>
              <label>{t("CourseTemplateEditorPage.fieldDirection")}<select disabled={locked} value={selectedEdge.direction} onChange={(event) => patchEdge({ direction: event.target.value })}><option value="one_way">{t("CourseTemplateEditorPage.directionOneWay")}</option><option value="bidirectional">{t("CourseTemplateEditorPage.directionBidirectional")}</option></select></label>
              <div className={styles.inspectorSplit}>
                <label>{t("CourseTemplateEditorPage.fieldProtocol")}<select disabled={locked} value={selectedEdge.protocol} onChange={(event) => patchEdge({ protocol: event.target.value })}>{selectedEdge.protocol === "any" && <option value="any">{t("CourseTemplateEditorPage.protocolAnyLegacy")}</option>}{FIREWALL_PROTOCOLS.map((protocol) => <option key={protocol} value={protocol}>{protocol.toUpperCase()}</option>)}</select></label>
                <label>{t("CourseTemplateEditorPage.fieldPort")}<input disabled={locked || selectedEdge.protocol === "any"} type="number" min="1" max="65535" value={selectedEdge.port ?? ""} onChange={(event) => patchEdge({ port: event.target.value })} /></label>
              </div>
              {!locked && <button type="button" className={styles.inspectorDanger} onClick={() => removeEdge(selectedEdge.id)}><MIcon name="delete_outline" size={16} />{t("CourseTemplateEditorPage.deleteConnectionBtn")}</button>}
            </> : selectedNode ? <>
              <div className={styles.inspectorTitle}><MIcon name="dns" size={18} /><div><strong>{selectedNode.sourceType === "custom" ? t("CourseTemplateEditorPage.sourceCustomSpec") : t("CourseTemplateEditorPage.sourceExistingTemplate")}</strong><small>{selectedNode.type === "lxc" ? t("CourseTemplateEditorPage.typeContainerLxc") : t("CourseTemplateEditorPage.typeVm")}</small></div></div>
              <label>{t("CourseTemplateEditorPage.fieldName")}<input disabled={locked} value={selectedNode.name} onChange={(event) => patchNode(selectedNode.id, { name: event.target.value })} /></label>
              <label>{t("CourseTemplateEditorPage.fieldRole")}<input disabled={locked} value={selectedNode.role} onChange={(event) => patchNode(selectedNode.id, { role: event.target.value })} /></label>
              <div className={styles.inspectorSliders}>
                <label><span className={styles.sliderLabel}>CPU<em>{t("CourseTemplateEditorPage.cpuValue", { count: selectedNode.cpu })}</em></span><input disabled={specLocked} type="range" step="1" min={Math.min(CPU_RANGE[0], selectedNode.cpu)} max={Math.max(CPU_RANGE[1], selectedNode.cpu)} value={selectedNode.cpu} onChange={(event) => patchNode(selectedNode.id, { cpu: Number(event.target.value) })} /></label>
                <label><span className={styles.sliderLabel}>RAM<em>{t("CourseTemplateEditorPage.memoryValue", { count: selectedNode.memory })}</em></span><input disabled={specLocked} type="range" step="1" min={Math.min(MEMORY_RANGE[0], selectedNode.memory)} max={Math.max(MEMORY_RANGE[1], selectedNode.memory)} value={selectedNode.memory} onChange={(event) => patchNode(selectedNode.id, { memory: Number(event.target.value) })} /></label>
                <label><span className={styles.sliderLabel}>Disk<em>{t("CourseTemplateEditorPage.diskValue", { count: selectedNode.disk })}</em></span><input disabled={specLocked} type="range" step="1" min={Math.min(diskRange[0], selectedNode.disk)} max={Math.max(diskRange[1], selectedNode.disk)} value={selectedNode.disk} onChange={(event) => patchNode(selectedNode.id, { disk: Number(event.target.value) })} /></label>
              </div>
              <div className={styles.publicationSection}>
                <div className={styles.publicationHead}>
                  <span>{t("CourseTemplateEditorPage.publicAccessLabel")}</span>
                  {!locked && <button type="button" className={styles.publicationAddBtn} onClick={() => addPublication(selectedNode)}><MIcon name="add" size={14} />{t("CourseTemplateEditorPage.addPublicationBtn")}</button>}
                </div>
                {!zones.length && <p className={styles.inspectorHint}>{t("CourseTemplateEditorPage.noZoneHint")}</p>}
                {nodePublications.length === 0
                  ? <p className={styles.inspectorHint}>{t("CourseTemplateEditorPage.noPublicationHint")}</p>
                  : nodePublications.map((publication) => <div key={publication.id} className={styles.publicationRow}>
                      <div className={styles.inspectorSplit}>
                        <label>{t("CourseTemplateEditorPage.fieldInternalPort")}<input disabled={locked} type="number" min="1" max="65535" value={publication.port} onChange={(event) => patchPublication(publication.id, { port: Number(event.target.value) })} /></label>
                        <label>{t("CourseTemplateEditorPage.fieldPublishMode")}<select disabled={locked} value={publication.mode} onChange={(event) => patchPublication(publication.id, { mode: event.target.value })}><option value="domain" disabled={!zones.length}>{t("CourseTemplateEditorPage.publishModeDomain")}</option><option value="firewall_only">{t("CourseTemplateEditorPage.publishModeFirewallOnly")}</option></select></label>
                      </div>
                      {publication.mode === "domain" ? <>
                        <label>{t("CourseTemplateEditorPage.fieldHostnameTemplate")}<input disabled={locked} value={publication.hostnamePrefix} onChange={(event) => patchPublication(publication.id, { hostnamePrefix: event.target.value })} placeholder="{student}-app" /></label>
                        <label>{t("CourseTemplateEditorPage.fieldZone")}<select disabled={locked} value={publication.zoneId} onChange={(event) => patchPublication(publication.id, { zoneId: event.target.value })}>{zones.map((zone) => <option key={zone.id} value={zone.id}>{zone.name}</option>)}</select></label>
                        <p className={styles.inspectorHint}>{t("CourseTemplateEditorPage.hostnameTemplateHint", { example: previewDomain(publication) })}</p>
                      </> : <p className={styles.inspectorHint}>{t("CourseTemplateEditorPage.firewallOnlyHint")}</p>}
                      {!locked && <button type="button" className={styles.publicationRemoveBtn} onClick={() => removePublication(publication.id)}><MIcon name="close" size={14} />{t("CourseTemplateEditorPage.removePublicationBtn")}</button>}
                    </div>)}
              </div>
              {!locked && <button type="button" className={styles.inspectorDanger} onClick={() => removeMachine(selectedNode.id)}><MIcon name="delete_outline" size={16} />{t("CourseTemplateEditorPage.removeNodeBtn")}</button>}
            </> : null}
          </aside>
        </div>
      </> : <EmptyState icon="dns" title={t("CourseTemplateEditorPage.emptyNodesTitle")} />}
  </section>;
}

/** 只允許站內相對路徑（以單一 "/" 開頭、不含 scheme 或 "//"），其餘視為無效。 */
function sanitizeReturnTo(value) {
  if (typeof value !== "string" || !value) return null;
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return null;
  try {
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

export default function CourseTemplateEditorPage() {
  const { t } = useTranslation("teaching");
  const confirm = useConfirm();
  const { templateId } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const requestedTab = params.get("tab") ?? "basic";
  // 只接受站內相對路徑（單一斜線開頭）：`//evil.com` 或含 scheme 的值會被
  // react-router 交給 window.location.assign，形成 open redirect
  const returnTo = sanitizeReturnTo(params.get("returnTo"));
  const tab = TABS.some(([key]) => key === requestedTab) ? requestedTab : "basic";
  const [template, setTemplate] = useState(() => makeEmptyTemplate());
  const [pveTemplates, setPveTemplates] = useState([]);
  const [vmImages, setVmImages] = useState([]);
  const [lxcImages, setLxcImages] = useState([]);
  const [zones, setZones] = useState([]);
  const [sourceNotice, setSourceNotice] = useState("");
  const [classes, setClasses] = useState([]);
  const [loading, setLoading] = useState(Boolean(templateId));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const isNew = !templateId;
  const locked = template.status !== "draft";
  const invalidTopology = (template.edges ?? []).some((edge) => (
    edge.protocol !== "any"
    && (!Number.isInteger(Number(edge.port)) || Number(edge.port) < 1 || Number(edge.port) > 65535)
  ));
  const offersPractice = template.usageScope === "quick_practice" || template.usageScope === "both";
  const audience = template.audience ?? "class";
  const missingAudienceClass = offersPractice && audience === "class" && (template.audienceClassIds ?? []).length === 0;
  const saveBlockReason = !template.name.trim()
    ? t("CourseTemplateEditorPage.needNameReason")
    : missingAudienceClass
      ? t("CourseTemplateEditorPage.needAudienceClassReason")
      : template.nodes.length === 0
        ? t("CourseTemplateEditorPage.needAtLeastOneMachineReason")
        : template.nodes.length > 3
          ? t("CourseTemplateEditorPage.maxThreeMachinesReason")
          : invalidTopology
            ? t("CourseTemplateEditorPage.fixPortReason")
            : "";
  useEffect(() => {
    if (!templateId) { setTemplate(makeEmptyTemplate()); setLoading(false); return undefined; }
    let active = true;
    setLoading(true);
    CourseEnvironmentsService.get(templateId)
      .then((result) => active && setTemplate(result))
      .catch((reason) => active && setMessage(reason?.message ?? t("CourseTemplateEditorPage.loadTemplateFailed")))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [templateId, t]);
  useEffect(() => {
    let active = true;
    TeachingClassesService.list()
      .then((result) => active && setClasses(result?.data ?? result ?? []))
      .catch(() => {});
    return () => { active = false; };
  }, []);
  useEffect(() => {
    let active = true;
    TemplatesService.list()
      .then((result) => {
        if (!active) return;
        const rows = result?.data ?? result ?? [];
        const ready = rows.filter((item) => item.status === "ready");
        setPveTemplates(ready);
        if (ready.length) setSourceNotice("");
        else if (rows.some((item) => item.status === "creating" || item.status === "updating")) {
          setSourceNotice(t("CourseTemplateEditorPage.templatesProcessingNotice"));
        } else if (rows.some((item) => item.status === "failed")) {
          setSourceNotice(t("CourseTemplateEditorPage.templatesFailedNotice"));
        } else {
          setSourceNotice("");
        }
      })
      .catch((reason) => {
        if (active) setSourceNotice(reason?.message ?? t("CourseTemplateEditorPage.loadTemplatesFailedFallback"));
      });
    return () => { active = false; };
  }, [t]);
  useEffect(() => {
    let active = true;
    // 反向代理沒設定好時回空陣列，發布方式只留「僅開防火牆」
    apiGet("/api/v1/reverse-proxy/setup-context")
      .then((context) => { if (active) setZones(context?.enabled ? (context.zones ?? []) : []); })
      .catch(() => { if (active) setZones([]); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    let active = true;
    Promise.all([apiGet("/api/v1/vm/templates"), apiGet("/api/v1/lxc/templates")])
      .then(([vms, lxcs]) => {
        if (!active) return;
        setVmImages((vms ?? []).map((item) => ({ value: String(item.vmid), label: t("CourseTemplateEditorPage.vmImageLabel", { name: item.name, vmid: item.vmid, node: item.node }), cores: item.cores, memoryMb: item.memory_mb, diskGb: item.disk_gb })));
        setLxcImages((lxcs ?? []).map((item) => ({ value: item.volid, label: item.volid.split("/").pop() ?? item.volid })));
      })
      .catch((reason) => {
        if (active) setSourceNotice(reason?.message ?? t("CourseTemplateEditorPage.loadImagesFailed"));
      });
    return () => { active = false; };
  }, [t]);
  function update(patch) { setTemplate((current) => ({ ...current, ...patch })); }
  function changeTab(nextTab) { setParams(returnTo ? { tab: nextTab, returnTo } : { tab: nextTab }); }
  async function save() {
    setSaving(true); setMessage("");
    try {
      const saved = isNew
        ? await CourseEnvironmentsService.create(template)
        : await CourseEnvironmentsService.update(template.id, template);
      setTemplate(saved);
      if (isNew) navigate(`/course-template-management/${saved.id}${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ""}`, { replace: true });
      else setMessage(t("CourseTemplateEditorPage.draftSavedMsg"));
    } catch (reason) { setMessage(reason?.message ?? t("CourseTemplateEditorPage.saveFailed")); }
    finally { setSaving(false); }
  }
  async function publish() {
    const ok = await confirm({
      title: t("CourseTemplateEditorPage.publishConfirmTitle"),
      message: t("CourseTemplateEditorPage.publishConfirmMessage"),
      confirmText: t("CourseTemplateEditorPage.publishLabel"),
    });
    if (!ok) return;
    setSaving(true); setMessage("");
    try {
      await CourseEnvironmentsService.update(template.id, template);
      const published = await CourseEnvironmentsService.publish(template.id);
      setTemplate(published);
      const destination = template.usageScope === "quick_practice"
        ? t("CourseTemplateEditorPage.destQuickPractice")
        : template.usageScope === "both"
          ? t("CourseTemplateEditorPage.destBoth")
          : t("CourseTemplateEditorPage.destClassManagement");
      setMessage(t("CourseTemplateEditorPage.publishedMsg", { destination }));
      if (returnTo) navigate(returnTo, { state: { createdTemplateId: published.id } });
    } catch (reason) { setMessage(reason?.message ?? t("CourseTemplateEditorPage.publishFailed")); }
    finally { setSaving(false); }
  }
  async function newVersion() {
    setSaving(true); setMessage("");
    try { setTemplate(await CourseEnvironmentsService.createVersion(template.id)); }
    catch (reason) { setMessage(reason?.message ?? t("CourseTemplateEditorPage.newVersionFailed")); }
    finally { setSaving(false); }
  }
  if (loading) return <LoadingState fullPage text={t("CourseTemplateEditorPage.loadingTemplateText")} />;
  return <div className={styles.page}>
    <button type="button" className={styles.backLink} onClick={() => navigate(returnTo ?? "/course-template-management")}><MIcon name="arrow_back" size={18} />{returnTo ? t("CourseTemplateEditorPage.backToClassEnv") : t("CourseTemplateEditorPage.backToTemplateList")}</button>
    <PageHeader title={isNew ? t("CourseTemplateEditorPage.createTemplateTitle") : template.name} subtitle={isNew ? t("CourseTemplateEditorPage.createTemplateSubtitle") : `v${template.version} · ${template.updatedAt}`}><div className={styles.pageActions}><button type="button" className={styles.btnSecondary} onClick={() => navigate(returnTo ?? "/course-template-management")}>{t("CourseTemplateEditorPage.backBtn")}</button>{locked ? <button type="button" className={styles.btnPrimary} disabled={saving} onClick={newVersion}><MIcon name="content_copy" size={16} />{t("CourseTemplateEditorPage.createNewVersionBtn")}</button> : <><button type="button" className={styles.btnSecondary} disabled={saving || !template.name.trim() || missingAudienceClass || template.nodes.length === 0 || template.nodes.length > 3 || invalidTopology} onClick={save}><MIcon name="save" size={16} />{saving ? t("CourseTemplateEditorPage.savingEllipsis") : t("CourseTemplateEditorPage.saveDraftBtn")}</button><button type="button" className={styles.btnPrimary} disabled={isNew || saving || !template.name.trim() || missingAudienceClass || template.nodes.length === 0 || template.nodes.length > 3 || invalidTopology} onClick={publish}><MIcon name="publish" size={16} />{t("CourseTemplateEditorPage.publishLabel")}</button></>}</div></PageHeader>
    {returnTo && <p className={styles.persistentFeedback}><MIcon name="bookmark_added" size={17} /><span><strong>{t("CourseTemplateEditorPage.classDraftSavedTitle")}</strong>{t("CourseTemplateEditorPage.classDraftSavedDesc")}</span></p>}
    {message && <p className={styles.persistentFeedback}><MIcon name="info" size={17} />{message}</p>}
    {!locked && saveBlockReason && <p className={styles.persistentFeedback}><MIcon name="info" size={17} />{t("CourseTemplateEditorPage.cannotSaveYet", { reason: saveBlockReason })}</p>}
    <section className={styles.stepTabsBar}>
      <nav className={styles.stepTabs}>{TABS.map(([key, labelKey], index) => <button type="button" key={key} className={tab === key ? styles.stepActive : ""} onClick={() => changeTab(key)}><span>{index + 1}</span><strong>{t(labelKey)}</strong></button>)}</nav>
    </section>
    {tab === "basic" && <section className={styles.card}><div className={styles.cardHeader}><div><h2>{t("CourseTemplateEditorPage.tabBasicLabel")}</h2><p>{locked ? t("CourseTemplateEditorPage.lockedVersionNote") : t("CourseTemplateEditorPage.reusableEnvNote")}</p></div></div><div className={styles.formGrid}><label className={styles.field}><span>{t("CourseTemplateEditorPage.fieldEnvName")}</span><input disabled={locked} value={template.name} onChange={(event) => update({ name: event.target.value })} placeholder={t("CourseTemplateEditorPage.envNamePlaceholder")} /></label><label className={styles.field}><span>{t("CourseTemplateEditorPage.fieldUsageScope")}</span><select disabled={locked} value={template.usageScope ?? "course"} onChange={(event) => update({ usageScope: event.target.value })}><option value="course">{t("CourseTemplateEditorPage.usageScopeCourseOnly")}</option><option value="quick_practice">{t("CourseTemplateEditorPage.usageScopeQuickPracticeOnly")}</option><option value="both">{t("CourseTemplateEditorPage.usageScopeBoth")}</option></select></label>{offersPractice && <label className={styles.field}><span>{t("CourseTemplateEditorPage.fieldMaxConcurrent")}</span><input disabled={locked} type="number" min={1} max={500} placeholder={t("CourseTemplateEditorPage.maxConcurrentPlaceholder")} value={template.maxConcurrentSessions ?? ""} onChange={(event) => update({ maxConcurrentSessions: event.target.value === "" ? null : Number(event.target.value) })} /></label>}{offersPractice && <label className={styles.field}><span>{t("CourseTemplateEditorPage.fieldAudience")}</span><select disabled={locked} value={audience} onChange={(event) => update({ audience: event.target.value })}><option value="class">{t("CourseTemplateEditorPage.audienceOptClass")}</option><option value="campus">{t("CourseTemplateEditorPage.audienceOptCampus")}</option><option value="owner">{t("CourseTemplateEditorPage.audienceOptOwner")}</option></select></label>}{offersPractice && audience === "class" && <div className={`${styles.field} ${styles.fieldFull}`}><span>{t("CourseTemplateEditorPage.fieldAudienceClasses")}</span>{classes.length === 0 ? <p className={styles.inspectorHint}>{t("CourseTemplateEditorPage.noClassesHint")}</p> : <div className={styles.audienceClassList}>{classes.map((item) => <label key={item.id} className={styles.audienceClassItem}><input type="checkbox" disabled={locked} checked={(template.audienceClassIds ?? []).includes(String(item.id))} onChange={(event) => update({ audienceClassIds: event.target.checked ? [...(template.audienceClassIds ?? []), String(item.id)] : (template.audienceClassIds ?? []).filter((id) => id !== String(item.id)) })} /><span>{item.name}<small>{item.code} · {item.term}</small></span></label>)}</div>}</div>}<label className={`${styles.field} ${styles.fieldFull}`}><span>{t("CourseTemplateEditorPage.fieldEnvDescription")}</span><textarea disabled={locked} rows={3} value={template.description ?? ""} onChange={(event) => update({ description: event.target.value })} /></label></div><div className={styles.actionFooter}><button type="button" className={styles.btnPrimary} onClick={() => changeTab("machines")}>{t("CourseTemplateEditorPage.viewMachineConfigBtn")}<MIcon name="arrow_forward" size={16} /></button></div></section>}
    {tab === "machines" && <MachineEditor value={template.nodes} edges={template.edges ?? []} publications={template.publications ?? []} onChange={(nodes) => update({ nodes })} onEdgesChange={(edges) => update({ edges })} onPublicationsChange={(publications) => update({ publications })} pveTemplates={pveTemplates} vmImages={vmImages} lxcImages={lxcImages} zones={zones} sourceNotice={sourceNotice} locked={locked} />}
  </div>;
}
