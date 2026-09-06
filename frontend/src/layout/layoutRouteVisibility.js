export function isAiJudgePath(pathname = "") {
  return /^\/class-management\/[^/]+\/ai(?:\/|$)/.test(pathname);
}
