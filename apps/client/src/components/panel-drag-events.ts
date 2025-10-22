export const PANEL_DRAG_START_EVENT = "cmux:panel-drag-start";
export const PANEL_DRAG_END_EVENT = "cmux:panel-drag-end";

export type PanelDragLifecycleEvent =
  | typeof PANEL_DRAG_START_EVENT
  | typeof PANEL_DRAG_END_EVENT;
