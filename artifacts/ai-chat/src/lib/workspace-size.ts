export const WORKSPACE_WIDTH_KEY = 'nexo-workspace-width';
export function workspaceBounds(viewport: number, sidebar = 0) {
  if (viewport < 768) return { min: viewport, max: viewport };
  const max = Math.max(320, Math.min(1000, viewport <= 1100 ? viewport - 48 : viewport - sidebar - 336));
  return { min: 320, max: Math.floor(max) };
}
export const clampWorkspaceWidth = (width: number, bounds: { min: number; max: number }) =>
  Math.round(Math.min(bounds.max, Math.max(bounds.min, Number.isFinite(width) ? width : 520)));
