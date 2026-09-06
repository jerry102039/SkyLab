/**
 * FirewallPage
 * 防火牆拓撲頁面，使用 @xyflow/react 繪製互動式節點圖。
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  ReactFlow,
  useNodesState,
  useEdgesState,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import {
  getTopology,
  createConnection,
  deleteConnection,
  saveLayout,
} from "../../../services/firewall";
import RulesPanel       from "../../../components/RulesPanel/RulesPanel";
import ConnectionDialog from "../../../components/ConnectionDialog/ConnectionDialog";
import GatewayNode      from "./nodes/GatewayNode";
import VMNode           from "./nodes/VMNode";
import ConnectionEdge   from "./edges/ConnectionEdge";
import { buildFlow, portLabel } from "./utils/buildFlow";
import { useTheme } from "../../../contexts/ThemeContext";
import useAutoRefresh from "../../../hooks/useAutoRefresh";
import useDialogPresence from "../../../hooks/useDialogPresence";
import styles from "./FirewallPage.module.scss";
import MIcon from "../../../components/MIcon";
import PageHeader from "../../../components/PageHeader/PageHeader";

/* ─── 常數 ──────────────────────────────────────────────── */
const GATEWAY_KEY   = "gateway";
const SAVE_DEBOUNCE = 600;
const VM_COL_X      = 160;
const ROW_H         = 160;
const GATEWAY_X     = VM_COL_X + 520;

const NODE_TYPES = { gateway: GatewayNode, vm: VMNode };
const EDGE_TYPES = { connection: ConnectionEdge };

/** ReactFlow 節點 id → ConnectionDialog 的選項 key（網關節點對應 "internet"） */
const toDialogKey = (nodeId) => (nodeId === GATEWAY_KEY ? "internet" : String(nodeId));

/* ─── 主頁面 ─────────────────────────────────────────────── */
export default function FirewallPage() {
  const { t } = useTranslation("network");
  const { theme } = useTheme();
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [topology,     setTopology]     = useState(null);
  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState("");
  const [selectedNode, setSelectedNode] = useState(null);
  const [showDialog,   setShowDialog]   = useState(false);
  const [dialogPreset, setDialogPreset] = useState(null); // 拉線帶入的來源/目標
  const [deleteEdge,   setDeleteEdge]   = useState(null);
  const [showLabels,   setShowLabels]   = useState(false);
  const [showMiniMap,  setShowMiniMap]  = useState(true);
  const connDialog    = useDialogPresence(showDialog);
  const deleteConfirm = useDialogPresence(deleteEdge);
  const rfInstance = useRef(null);
  const saveTimer  = useRef(null);

  /* ── 刪除邊回呼 ── */
  const handleDeleteEdge = useCallback((edge) => setDeleteEdge(edge), []);

  /* ── showLabels 變更時同步更新所有邊 ── */
  useEffect(() => {
    setEdges((prev) =>
      prev.map((e) => ({ ...e, data: { ...e.data, showLabel: showLabels } }))
    );
  }, [showLabels, setEdges]);

  /* ── 載入拓撲（silent = true 時不觸發 loading / error state，供背景自動刷新使用） ── */
  const fetchTopology = useCallback(async (silent = false, signal) => {
    if (!silent) {
      setLoading(true);
      setError("");
    }
    try {
      const data = await getTopology({ signal });
      setTopology(data ?? { nodes: [], edges: [] });
    } catch (err) {
      if (!silent) setError(err?.message ?? t("FirewallPage.loadTopologyFailed"));
    } finally {
      if (!silent && !signal?.aborted) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!topology) return;
    const { nodes: nextNodes, edges: nextEdges } = buildFlow(
      topology,
      handleDeleteEdge,
      showLabels
    );
    setSelectedNode(null);
    setDeleteEdge(null);
    setNodes(nextNodes);
    setEdges(nextEdges);
    window.requestAnimationFrame(() => rfInstance.current?.fitView({ padding: 0.2, duration: 250 }));
  }, [handleDeleteEdge, setEdges, setNodes, showLabels, topology]);

  useEffect(() => {
    const controller = new AbortController();
    fetchTopology(false, controller.signal);
    return () => controller.abort();
  }, [fetchTopology]);
  useAutoRefresh(() => fetchTopology(true));

  /* ── 自動排列 ── */
  const autoArrange = useCallback(() => {
    setNodes((prev) => {
      const vmNodes = prev.filter((n) => n.type === "vm");
      const gateway = prev.find((n) => n.type === "gateway");
      const startY  = 80;
      const totalH  = vmNodes.length * ROW_H;

      const arranged = vmNodes.map((node, i) => ({
        ...node,
        position: { x: VM_COL_X, y: startY + i * ROW_H },
      }));

      if (gateway) {
        arranged.push({
          ...gateway,
          position: { x: GATEWAY_X, y: startY + (totalH - ROW_H) / 2 },
        });
      }

      setTimeout(() => {
        const layoutNodes = arranged.map((n) => ({
          vmid:       n.id === GATEWAY_KEY ? null : Number(n.id),
          node_type:  n.id === GATEWAY_KEY ? "gateway" : "vm",
          position_x: Math.round(n.position.x),
          position_y: Math.round(n.position.y),
        }));
        saveLayout(layoutNodes).catch(() => {});
        rfInstance.current?.fitView({ padding: 0.2, duration: 400 });
      }, 50);

      return arranged;
    });
  }, [setNodes]);

  /* ── 節點拖曳結束 → debounce 儲存佈局 ── */
  const onNodeDragStop = useCallback((_, __, draggedNodes) => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const layoutNodes = draggedNodes.map((n) => ({
        vmid:       n.id === GATEWAY_KEY ? null : Number(n.id),
        node_type:  n.id === GATEWAY_KEY ? "gateway" : "vm",
        position_x: Math.round(n.position.x),
        position_y: Math.round(n.position.y),
      }));
      saveLayout(layoutNodes).catch(() => {});
    }, SAVE_DEBOUNCE);
  }, []);

  /* ── 點擊節點：開啟規則面板 ── */
  const onNodeClick = useCallback((_, node) => {
    if (node.type === "gateway") { setSelectedNode(null); return; }
    setSelectedNode((prev) => prev?.id === node.id ? null : node);
  }, []);

  /* ── 點擊空白處：取消選取 ── */
  const onPaneClick = useCallback(() => setSelectedNode(null), []);

  /* ── 拉線前驗證：禁止自連（網關只有一個，自連即網關對網關） ── */
  const isValidConnection = useCallback(
    (conn) => Boolean(conn?.source && conn?.target && conn.source !== conn.target),
    []
  );

  /* ── 拉線完成：帶入來源/目標，開啟新增連線對話框 ── */
  const onConnect = useCallback((conn) => {
    if (!conn?.source || !conn?.target || conn.source === conn.target) return;
    setDialogPreset({ source: toDialogKey(conn.source), target: toDialogKey(conn.target) });
    setShowDialog(true);
  }, []);

  /* ── VM 節點列表（供 ConnectionDialog 使用） ── */
  const vmNodes = (topology?.nodes ?? [])
    .filter((n) => n.node_type !== "gateway")
    .map((n) => ({ key: String(n.vmid), vmid: n.vmid, name: n.name }));

  /* ── 建立連線 ── */
  const handleCreateConnection = async (data) => {
    await createConnection(data);
    setShowDialog(false);
    fetchTopology();
  };

  /* ── 確認刪除邊 ── */
  const confirmDeleteEdge = async () => {
    if (!deleteEdge) return;
    try {
      await deleteConnection({
        source_vmid: deleteEdge.source_vmid,
        target_vmid: deleteEdge.target_vmid,
        ports: null,
      });
      setDeleteEdge(null);
      fetchTopology();
    } catch (err) {
      alert(err?.message ?? t("FirewallPage.deleteFailed"));
    }
  };

  return (
    <div className={styles.page}>
      {/* ── Header ── */}
      <PageHeader title={t("FirewallPage.title")} subtitle={t("FirewallPage.subtitle")}>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.btnPrimary}
            onClick={() => { setDialogPreset(null); setShowDialog(true); }}
            data-guide="firewall-create"
          >
            <MIcon name="add" size={16} />
            {t("FirewallPage.addConnection")}
          </button>
        </div>
      </PageHeader>

      {/* ── Content ── */}
      <div className={styles.content}>
        {loading && !topology && (
          <div className={styles.centerState}>
            <div className={styles.topoLoader}>
              {Array.from({ length: 9 }, (_, i) => (
                <div key={i} className={styles.topoNode} style={{ "--i": i }} />
              ))}
            </div>
            <span className={styles.loadingTitle}>{t("FirewallPage.loadingTopology")}</span>
          </div>
        )}

        {error && (
          <div className={styles.centerState}>
            <MIcon name="error_outline" size={36} />
            <span>{error}</span>
            <button type="button" className={styles.btnSecondary} onClick={fetchTopology}>
              {t("FirewallPage.retry")}
            </button>
          </div>
        )}

        {!loading && !error && topology && (
          <div className={styles.flowWrap} data-guide="firewall-map">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onNodeDragStop={onNodeDragStop}
              onNodeClick={onNodeClick}
              onPaneClick={onPaneClick}
              onConnect={onConnect}
              isValidConnection={isValidConnection}
              connectionRadius={36}
              onInit={(instance) => { rfInstance.current = instance; }}
              nodeTypes={NODE_TYPES}
              edgeTypes={EDGE_TYPES}
              deleteKeyCode={null}
              fitView
              fitViewOptions={{ padding: 0.2 }}
              colorMode={theme}
              proOptions={{ hideAttribution: true }}
            >
              <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
              <Controls />
              {showMiniMap && <MiniMap zoomable pannable />}

              {nodes.length === 0 && (
                <Panel position="top-center">
                  <div className={styles.emptyTopology}>
                    <MIcon name="security" size={23} />
                    <strong>{t("FirewallPage.emptyTitle")}</strong>
                    <span>{t("FirewallPage.emptyDesc")}</span>
                  </div>
                </Panel>
              )}

              <Panel position="top-left">
                <div className={styles.toolbar} data-guide="firewall-tools">
                  <button
                    type="button"
                    className={styles.toolbarBtn}
                    onClick={autoArrange}
                  >
                    <MIcon name="dashboard" size={16} />
                    {t("FirewallPage.autoArrange")}
                  </button>
                  <button
                    type="button"
                    className={`${styles.toolbarBtn} ${showLabels ? styles.toolbarBtnActive : ""}`}
                    onClick={() => setShowLabels((v) => !v)}
                  >
                    <MIcon name={showLabels ? "label" : "label_off"} size={16} />
                    {t("FirewallPage.connectionLabels")}
                  </button>
                  <button
                    type="button"
                    className={`${styles.toolbarBtn} ${showMiniMap ? styles.toolbarBtnActive : ""}`}
                    onClick={() => setShowMiniMap((v) => !v)}
                  >
                    <MIcon name="map" size={16} />
                    {t("FirewallPage.miniMap")}
                  </button>
                </div>
              </Panel>

              <Panel position="bottom-left" style={{ marginLeft: 60 }}>
                <p className={styles.hint}>
                  {t("FirewallPage.hint")}
                </p>
              </Panel>
            </ReactFlow>

            {selectedNode && (
              <RulesPanel
                node={{ vmid: Number(selectedNode.id), name: selectedNode.data.name }}
                onClose={() => setSelectedNode(null)}
              />
            )}
          </div>
        )}
      </div>

      {/* ── 新增連線 Dialog ── */}
      {connDialog.open && (
        <ConnectionDialog
          key={dialogPreset ? `${dialogPreset.source}->${dialogPreset.target}` : "manual"}
          nodes={vmNodes}
          initialSource={dialogPreset?.source}
          initialTarget={dialogPreset?.target}
          onConfirm={handleCreateConnection}
          onClose={() => setShowDialog(false)}
          closing={connDialog.closing}
        />
      )}

      {/* ── 刪除確認 ── */}
      {deleteConfirm.open && (
        <div
          className={`${styles.confirmOverlay} ${deleteConfirm.closing ? styles.confirmOverlayOut : ""}`}
          onClick={() => setDeleteEdge(null)}
        >
          <div className={styles.confirmDialog} onClick={(e) => e.stopPropagation()}>
            <h3 className={styles.confirmTitle}>{t("FirewallPage.deleteConnectionTitle")}</h3>
            <p className={styles.confirmMsg}>
              {t("FirewallPage.deleteConnectionConfirm")}
              {deleteConfirm.item.ports?.length > 0 && (
                <><br /><small>{portLabel(deleteConfirm.item.ports)}</small></>
              )}
            </p>
            <div className={styles.confirmActions}>
              <button type="button" className={styles.btnSecondary} onClick={() => setDeleteEdge(null)}>{t("FirewallPage.cancel")}</button>
              <button type="button" className={styles.btnDanger} onClick={confirmDeleteEdge}>{t("FirewallPage.delete")}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
