import { useState } from "react";

/* 群組（班級環境、快速練習）的開合狀態記在本機，離開頁面、重整、篩選後再出現都維持使用者上次的選擇。
   只記「收起來的」群組 id，沒記過的照預設展開；群組會結束消失，只留最近收起的 MAX_REMEMBERED 筆，清單不會無限長 */
const KEY_PREFIX = "skylab:collapsed-groups:";
const MAX_REMEMBERED = 200;

/** 讀某個頁面（scope）收起的群組 id；沒記過、內容壞掉或 localStorage 不可用都當沒有收起的 */
export function loadCollapsedGroups(scope) {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(KEY_PREFIX + scope) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function saveGroupCollapsed(scope, groupId, collapsed) {
  const ids = loadCollapsedGroups(scope).filter((id) => id !== groupId);
  if (collapsed) ids.push(groupId);
  try {
    window.localStorage.setItem(KEY_PREFIX + scope, JSON.stringify(ids.slice(-MAX_REMEMBERED)));
  } catch {
    // localStorage 不可用時開合只在這次瀏覽有效
  }
}

/**
 * 回傳 [expanded, toggle]。scope 區分頁面（各頁各記各的），groupId 是群組的穩定 id。
 */
export default function usePersistedGroupExpansion(scope, groupId) {
  const id = String(groupId);
  const [expanded, setExpanded] = useState(() => !loadCollapsedGroups(scope).includes(id));
  function toggle() {
    const next = !expanded;
    setExpanded(next);
    saveGroupCollapsed(scope, id, !next);
  }
  return [expanded, toggle];
}
