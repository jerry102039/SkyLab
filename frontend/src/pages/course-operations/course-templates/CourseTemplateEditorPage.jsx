import { useEffect, useState } from "react";
import {
  Background,
  Handle,
  Position,
  ReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
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

const TABS = [
  ["basic", "基本資料"],
  ["machines", "機器配置"],
];

const emptyTemplate = { id: "new", name: "", description: "", usageScope: "course", audience: "class", audienceClassIds: [], maxConcurrentSessions: null, status: "draft", classes: 0, updatedAt: "尚未儲存", nodes: [], edges: [] };

const FIREWALL_PROTOCOLS = ["tcp", "udp", "icmp", "icmpv6", "sctp"];

function TopologyMachineNode({ data, selected, isConnectable }) {
  const node = data.node;
  return <div className={`${styles.flowMachineNode} ${selected ? styles.flowMachineNodeSelected : ""}`}>
    <Handle type="target" position={Position.Left} isConnectable={isConnectable} />
    <div className={styles.flowNodeIcon}><MIcon name={node.type === "lxc" ? "deployed_code" : "dns"} size={18} /></div>
    <div className={styles.flowNodeLabel}>
      <strong>{node.name}</strong>
      <span>{node.sourceType === "custom" ? "自訂" : "範本"} · {node.type === "lxc" ? "容器 (LXC)" : "虛擬機"}</span>
      <small>{node.cpu} CPU · {node.memory} GB RAM · {node.disk} GB</small>
    </div>
    <Handle type="source" position={Position.Right} isConnectable={isConnectable} />
  </div>;
}

const TOPOLOGY_NODE_TYPES = { courseMachine: TopologyMachineNode };
const TOPOLOGY_EDGE_TYPES = { connection: ConnectionEdge };

function MachineEditor({ value, edges, onChange, onEdgesChange, pveTemplates, vmImages, lxcImages, sourceNotice, locked = false }) {
  const [sourceMode, setSourceMode] = useState("template");
  const [sourceId, setSourceId] = useState("");
  const [customType, setCustomType] = useState("qemu");
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const [selectedEdgeId, setSelectedEdgeId] = useState("");
  const atLimit = value.length >= 3;

  function addMachine() {
    if (atLimit || !sourceId) return;
    const nodeId = `node-${Date.now()}`;
    if (sourceMode === "template") {
      const source = pveTemplates.find((item) => String(item.id) === sourceId);
      if (!source) return;
      onChange([...value, {
        id: nodeId, sourceType: "template", sourceTemplateId: source.id, name: source.name, role: "環境機器",
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
        name: source.label.split(" · ")[0], role: "環境機器", type: customType, image: source.label,
        cpu: 2, memory: 2, disk: customType === "lxc" ? 8 : 20, network: "lab-net", icon: "dns",
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
    setSelectedNodeId("");
  }

  function connect(connection) {
    if (locked || connection.source === connection.target) return;
    const duplicate = edges.some((edge) => (
      edge.source === connection.source
      && edge.target === connection.target
      && edge.direction === "one_way"
      && edge.protocol === "tcp"
      && Number(edge.port) === 22
    ));
    if (duplicate) return;
    const edge = {
      id: `edge-${Date.now()}`,
      source: connection.source,
      target: connection.target,
      direction: "one_way",
      protocol: "tcp",
      port: 22,
    };
    onEdgesChange([...edges, edge]);
    setSelectedEdgeId(edge.id);
    setSelectedNodeId("");
  }

  function patchNode(nodeId, patch) {
    onChange(value.map((item) => item.id === nodeId ? { ...item, ...patch } : item));
  }

  function patchEdge(patch) {
    onEdgesChange(edges.map((edge) => edge.id === selectedEdgeId ? { ...edge, ...patch } : edge));
  }

  function removeEdge(edgeId) {
    onEdgesChange(edges.filter((edge) => edge.id !== edgeId));
    setSelectedEdgeId("");
  }

  function handleGraphNodesChange(changes) {
    const positions = new Map(
      changes
        .filter((change) => change.type === "position" && change.position)
        .map((change) => [change.id, change.position]),
    );
    if (!positions.size) return;
    onChange(value.map((node) => {
      const position = positions.get(String(node.id));
      return position
        ? { ...node, positionX: Math.round(position.x), positionY: Math.round(position.y) }
        : node;
    }));
  }

  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId);
  const selectedNode = value.find((node) => node.id === selectedNodeId) ?? (!selectedEdge ? value[0] : null);
  const graphNodes = value.map((node, index) => ({
    id: String(node.id),
    type: "courseMachine",
    position: {
      x: Number(node.positionX ?? (60 + index * 260)),
      y: Number(node.positionY ?? (120 + (index % 2) * 45)),
    },
    data: { node },
    selected: selectedNode?.id === node.id,
  }));
  const graphEdges = edges.map((edge) => ({
    ...edge,
    type: "connection",
    data: {
      edge: {
        course_edge_id: edge.id,
        source_vmid: edge.source,
        target_vmid: edge.target,
      },
      label: `${edge.direction === "bidirectional" ? "雙向" : "單向"} · ${edge.protocol}${edge.port ? `/${edge.port}` : ""}`,
      showLabel: true,
      onSelect: () => { setSelectedEdgeId(edge.id); setSelectedNodeId(""); },
      onDelete: locked ? null : () => removeEdge(edge.id),
    },
    zIndex: 5,
  }));

  return <section className={`${styles.card} ${styles.templateMachineWorkspace}`}>
      <div className={styles.machineWorkspaceHeader}>
        <div><h2>每次套用的多機環境</h2><p>新增節點，再用連線定義可互通的服務。</p></div>
        <span className={styles.nodeLimit}>{value.length} / 3 節點</span>
      </div>
      {sourceNotice && <p className={styles.persistentFeedback}><MIcon name="info" size={17} />{sourceNotice}</p>}
      <div className={styles.machineAddBar}>
        <label className={styles.field}><span>來源方式</span><select value={sourceMode} disabled={locked || atLimit} onChange={(event) => { setSourceMode(event.target.value); setSourceId(""); }}><option value="template">① 選擇既有範本</option><option value="custom">② 新增 VM/LXC 規格</option></select></label>
        {sourceMode === "custom" && <label className={styles.field}><span>機器類型</span><select value={customType} disabled={locked || atLimit} onChange={(event) => { setCustomType(event.target.value); setSourceId(""); }}><option value="qemu">VM</option><option value="lxc">LXC</option></select></label>}
        <label className={styles.field}><span>{sourceMode === "template" ? "既有範本" : "基礎映像"}</span><select value={sourceId} disabled={locked || atLimit} onChange={(event) => setSourceId(event.target.value)}><option value="">{locked ? "已發布版本不可修改" : atLimit ? "已達 3 台上限" : "請選擇"}</option>{sourceMode === "template" ? pveTemplates.map((source) => <option key={source.id} value={source.id}>{source.name} · {source.resource_type ?? "VM"}</option>) : (customType === "lxc" ? lxcImages : vmImages).map((source) => <option key={source.value} value={source.value}>{source.label}</option>)}</select></label>
        <button type="button" className={styles.btnPrimary} disabled={locked || atLimit || !sourceId} onClick={addMachine}><MIcon name={atLimit ? "check" : "add"} size={16} />{atLimit ? "已達上限" : "加入機器"}</button>
      </div>
      {value.length ? <>
        <div className={styles.topologyHelp}><MIcon name="account_tree" size={17} /><span>從來源節點右側圓點拖到目標節點左側圓點；節點本體可直接拖曳移動。</span></div>
        <div className={styles.topologyWorkspace}>
          <div className={styles.topologyCanvas}><ReactFlow
            nodes={graphNodes}
            edges={graphEdges}
            nodeTypes={TOPOLOGY_NODE_TYPES}
            edgeTypes={TOPOLOGY_EDGE_TYPES}
            onConnect={connect}
            onNodesChange={handleGraphNodesChange}
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
              <div className={styles.inspectorTitle}><MIcon name="link" size={18} /><div><strong>連線規則</strong><small>{value.find((node) => node.id === selectedEdge.source)?.name} → {value.find((node) => node.id === selectedEdge.target)?.name}</small></div></div>
              <label>方向<select disabled={locked} value={selectedEdge.direction} onChange={(event) => patchEdge({ direction: event.target.value })}><option value="one_way">單向</option><option value="bidirectional">雙向</option></select></label>
              <div className={styles.inspectorSplit}>
                <label>協定<select disabled={locked} value={selectedEdge.protocol} onChange={(event) => patchEdge({ protocol: event.target.value })}>{selectedEdge.protocol === "any" && <option value="any">全部（舊設定）</option>}{FIREWALL_PROTOCOLS.map((protocol) => <option key={protocol} value={protocol}>{protocol.toUpperCase()}</option>)}</select></label>
                <label>連接埠<input disabled={locked || selectedEdge.protocol === "any"} type="number" min="1" max="65535" value={selectedEdge.port ?? ""} onChange={(event) => patchEdge({ port: event.target.value })} /></label>
              </div>
              <p className={styles.inspectorHint}>單向會建立來源 OUT 與目標 IN 規則；雙向會再建立反向規則。</p>
              {!locked && <button type="button" className={styles.inspectorDanger} onClick={() => removeEdge(selectedEdge.id)}><MIcon name="delete_outline" size={16} />刪除連線</button>}
            </> : selectedNode ? <>
              <div className={styles.inspectorTitle}><MIcon name="dns" size={18} /><div><strong>{selectedNode.name}</strong><small>{selectedNode.sourceType === "custom" ? "自訂規格" : "既有範本"} · {selectedNode.type === "lxc" ? "容器 (LXC)" : "虛擬機"}</small></div></div>
              <label>名稱<input disabled={locked} value={selectedNode.name} onChange={(event) => patchNode(selectedNode.id, { name: event.target.value })} /></label>
              <label>角色<input disabled={locked} value={selectedNode.role} onChange={(event) => patchNode(selectedNode.id, { role: event.target.value })} /></label>
              <div className={styles.inspectorSplit}>
                <label>CPU<input disabled={locked || selectedNode.sourceType !== "custom"} type="number" min="1" max="32" value={selectedNode.cpu} onChange={(event) => patchNode(selectedNode.id, { cpu: Number(event.target.value) })} /></label>
                <label>RAM (GB)<input disabled={locked || selectedNode.sourceType !== "custom"} type="number" min="1" max="64" value={selectedNode.memory} onChange={(event) => patchNode(selectedNode.id, { memory: Number(event.target.value) })} /></label>
              </div>
              <label>Disk (GB)<input disabled={locked || selectedNode.sourceType !== "custom"} type="number" min={selectedNode.type === "lxc" ? 1 : 10} max="1000" value={selectedNode.disk} onChange={(event) => patchNode(selectedNode.id, { disk: Number(event.target.value) })} /></label>
              <p className={styles.inspectorHint}>儲存區由系統依容量、相容類型與管理優先序自動選擇。</p>
              {!locked && <button type="button" className={styles.inspectorDanger} onClick={() => removeMachine(selectedNode.id)}><MIcon name="delete_outline" size={16} />移除節點</button>}
            </> : null}
          </aside>
        </div>
      </> : <EmptyState icon="dns" title="先加入一個節點，再設定機器之間的連線。" />}
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
  const confirm = useConfirm();
  const { templateId } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const requestedTab = params.get("tab") ?? "basic";
  // 只接受站內相對路徑（單一斜線開頭）：`//evil.com` 或含 scheme 的值會被
  // react-router 交給 window.location.assign，形成 open redirect
  const returnTo = sanitizeReturnTo(params.get("returnTo"));
  const tab = TABS.some(([key]) => key === requestedTab) ? requestedTab : "basic";
  const [template, setTemplate] = useState(() => structuredClone(emptyTemplate));
  const [pveTemplates, setPveTemplates] = useState([]);
  const [vmImages, setVmImages] = useState([]);
  const [lxcImages, setLxcImages] = useState([]);
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
    ? "請先輸入環境名稱"
    : missingAudienceClass
      ? "請選擇可以看到這個環境的班級"
      : template.nodes.length === 0
        ? "請到「機器配置」加入至少一台機器"
        : template.nodes.length > 3
          ? "每位學生最多只能配置三台機器"
          : invalidTopology
            ? "請修正拓撲連線的連接埠"
            : "";
  useEffect(() => {
    if (!templateId) { setTemplate(structuredClone(emptyTemplate)); setLoading(false); return undefined; }
    let active = true;
    setLoading(true);
    CourseEnvironmentsService.get(templateId)
      .then((result) => active && setTemplate(result))
      .catch((reason) => active && setMessage(reason?.message ?? "無法讀取多機環境"))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [templateId]);
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
          setSourceNotice("機器範本仍在處理中；可等待完成，或改用「② 新增 VM/LXC 規格」。");
        } else if (rows.some((item) => item.status === "failed")) {
          setSourceNotice("機器範本轉換失敗，請先到機器範本重新轉換，或改用「② 新增 VM/LXC 規格」。");
        } else {
          setSourceNotice("目前沒有可用的機器範本；仍可使用「② 新增 VM/LXC 規格」建立多機環境。");
        }
      })
      .catch((reason) => {
        if (active) setSourceNotice(reason?.message ?? "無法讀取機器範本；仍可改用自訂 VM/LXC 規格。");
      });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    let active = true;
    Promise.all([apiGet("/api/v1/vm/templates"), apiGet("/api/v1/lxc/templates")])
      .then(([vms, lxcs]) => {
        if (!active) return;
        setVmImages((vms ?? []).map((item) => ({ value: String(item.vmid), label: `${item.name} · 編號 ${item.vmid} · ${item.node}`})));
        setLxcImages((lxcs ?? []).map((item) => ({ value: item.volid, label: item.volid.split("/").pop() ?? item.volid })));
      })
      .catch((reason) => {
        if (active) setSourceNotice(reason?.message ?? "無法讀取 VM/LXC 基礎映像，請稍後重試。");
      });
    return () => { active = false; };
  }, []);
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
      else setMessage("草稿已儲存。確認無誤後可以發布鎖定。");
    } catch (reason) { setMessage(reason?.message ?? "儲存失敗"); }
    finally { setSaving(false); }
  }
  async function publish() {
    const ok = await confirm({
      title: "發布並鎖定",
      message: "發布後這個版本將永久鎖定，確定要儲存目前設定並發布嗎？",
      confirmText: "發布",
    });
    if (!ok) return;
    setSaving(true); setMessage("");
    try {
      await CourseEnvironmentsService.update(template.id, template);
      const published = await CourseEnvironmentsService.publish(template.id);
      setTemplate(published);
      const destination = template.usageScope === "quick_practice"
        ? "快速練習"
        : template.usageScope === "both"
          ? "班級管理與快速練習"
          : "班級管理";
      setMessage(`多機環境已發布並鎖定，現在可以在${destination}中使用。`);
      if (returnTo) navigate(returnTo, { state: { createdTemplateId: published.id } });
    } catch (reason) { setMessage(reason?.message ?? "發布失敗"); }
    finally { setSaving(false); }
  }
  async function newVersion() {
    setSaving(true); setMessage("");
    try { setTemplate(await CourseEnvironmentsService.createVersion(template.id)); }
    catch (reason) { setMessage(reason?.message ?? "建立新版本失敗"); }
    finally { setSaving(false); }
  }
  if (loading) return <LoadingState fullPage text="正在讀取多機環境…" />;
  return <div className={styles.page}>
    <button type="button" className={styles.backLink} onClick={() => navigate(returnTo ?? "/course-template-management")}><MIcon name="arrow_back" size={18} />{returnTo ? "返回班級上課環境" : "返回多機環境"}</button>
    <PageHeader title={isNew ? "建立多機環境" : template.name} subtitle={isNew ? "定義可重複套用到正式課程或快速練習的固定機器組合。" : `v${template.version} · ${template.updatedAt}`}><div className={styles.pageActions}><button type="button" className={styles.btnSecondary} onClick={() => navigate(returnTo ?? "/course-template-management")}>返回</button>{locked ? <button type="button" className={styles.btnPrimary} disabled={saving} onClick={newVersion}><MIcon name="content_copy" size={16} />建立新版本</button> : <><button type="button" className={styles.btnSecondary} disabled={isNew || saving || !template.name.trim() || missingAudienceClass || template.nodes.length === 0 || template.nodes.length > 3 || invalidTopology} onClick={publish}><MIcon name="lock" size={16} />儲存、發布並鎖定</button><button type="button" className={styles.btnPrimary} disabled={saving || !template.name.trim() || missingAudienceClass || template.nodes.length === 0 || template.nodes.length > 3 || invalidTopology} onClick={save}><MIcon name="save" size={16} />{saving ? "儲存中…" : "儲存草稿"}</button></>}</div></PageHeader>
    {returnTo && <p className={styles.persistentFeedback}><MIcon name="bookmark_added" size={17} /><span><strong>班級草稿已保存。</strong>請完成機器配置並「發布」模板；發布後會自動回到班級建立流程。</span></p>}
    {message && <p className={styles.persistentFeedback}><MIcon name="info" size={17} />{message}</p>}
    {!locked && saveBlockReason && <p className={styles.persistentFeedback}><MIcon name="info" size={17} />尚不能儲存：{saveBlockReason}。</p>}
    <div className={styles.stepTabs}>{TABS.map(([key, label], index) => <button type="button" key={key} className={tab === key ? styles.stepActive : ""} onClick={() => changeTab(key)}><span>{index + 1}</span>{label}</button>)}</div>
    {tab === "basic" && <section className={styles.card}><div className={styles.cardHeader}><div><h2>基本資料</h2><p>{locked ? "這個版本已發布並鎖定；需要調整時請建立新版本。" : "同一份多機環境可用於正式課程、快速練習，或同時提供兩種用途。"}</p></div></div><div className={styles.formGrid}><label className={styles.field}><span>環境名稱</span><input disabled={locked} value={template.name} onChange={(event) => update({ name: event.target.value })} placeholder="例如：Linux 三層式上課環境" /></label><label className={styles.field}><span>套用方式</span><select disabled={locked} value={template.usageScope ?? "course"} onChange={(event) => update({ usageScope: event.target.value })}><option value="course">只用於正式課程</option><option value="quick_practice">只用於快速練習</option><option value="both">正式課程與快速練習</option></select></label>{offersPractice && <label className={styles.field}><span>同時最多幾組</span><input disabled={locked} type="number" min={1} max={500} placeholder="留空＝不限（仍受每人限制）" value={template.maxConcurrentSessions ?? ""} onChange={(event) => update({ maxConcurrentSessions: event.target.value === "" ? null : Number(event.target.value) })} /></label>}{offersPractice && <label className={styles.field}><span>學生可見對象</span><select disabled={locked} value={audience} onChange={(event) => update({ audience: event.target.value })}><option value="class">只有指定班級的學生</option><option value="campus">全校（所有登入者）</option><option value="owner">先不開放，只有我看得到</option></select></label>}{offersPractice && audience === "class" && <div className={`${styles.field} ${styles.fieldFull}`}><span>可以看到這個環境的班級</span>{classes.length === 0 ? <p className={styles.inspectorHint}>你目前沒有班級；請先建立班級，或改選「全校」。</p> : <div className={styles.audienceClassList}>{classes.map((item) => <label key={item.id} className={styles.audienceClassItem}><input type="checkbox" disabled={locked} checked={(template.audienceClassIds ?? []).includes(String(item.id))} onChange={(event) => update({ audienceClassIds: event.target.checked ? [...(template.audienceClassIds ?? []), String(item.id)] : (template.audienceClassIds ?? []).filter((id) => id !== String(item.id)) })} /><span>{item.name}<small>{item.code} · {item.term}</small></span></label>)}</div>}</div>}<label className={`${styles.field} ${styles.fieldFull}`}><span>環境用途</span><textarea disabled={locked} rows={5} value={template.description ?? ""} onChange={(event) => update({ description: event.target.value })} /></label></div><div className={styles.actionFooter}><button type="button" className={styles.btnPrimary} onClick={() => changeTab("machines")}>查看機器配置<MIcon name="arrow_forward" size={16} /></button></div></section>}
    {tab === "machines" && <MachineEditor value={template.nodes} edges={template.edges ?? []} onChange={(nodes) => update({ nodes })} onEdgesChange={(edges) => update({ edges })} pveTemplates={pveTemplates} vmImages={vmImages} lxcImages={lxcImages} sourceNotice={sourceNotice} locked={locked} />}
  </div>;
}
