import { useEffect, useRef, useState, type RefObject } from "react";
import type { ScreenBox } from "./core/floating";

/** Observe browser selection without taking ownership of its anchor or focus. */
export function useSelectionGesture(root: RefObject<HTMLElement | null>) {
  const [gesture, setGesture] = useState({ active: false, session: 0 });
  const current = useRef(gesture);
  const point = useRef<ScreenBox | undefined>(undefined);
  useEffect(() => {
    const publish = () => { setGesture({ ...current.current }); };
    const eligible = (target: EventTarget | null) => target instanceof Element && root.current?.contains(target) && !!target.closest(".textLayer,.ocr-layer,.answer-body,.region-overlay");
    const start = (event: PointerEvent) => {
      if (event.button !== 0 || !eligible(event.target)) return;
      point.current = { left: event.clientX, right: event.clientX, top: event.clientY, bottom: event.clientY };
      current.current = { active: true, session: current.current.session + (event.shiftKey ? 0 : 1) };
      publish();
    };
    const move = (event: PointerEvent) => {
      if (!current.current.active || event.pointerType === "touch") return;
      point.current = { left: event.clientX, right: event.clientX, top: event.clientY, bottom: event.clientY };
    };
    const finish = () => {
      if (!current.current.active) return;
      point.current = undefined;
      current.current = { ...current.current, active: false };
      publish();
    };
    const keydown = (event: KeyboardEvent) => {
      if (!event.shiftKey || !/^(Arrow|Home|End|Page)/.test(event.key)) return;
      const selection = window.getSelection();
      if (!root.current?.contains(selection?.anchorNode ?? null) || (event.target instanceof Element && event.target.closest("input,textarea,[contenteditable=true]"))) return;
      point.current = undefined;
      current.current = { ...current.current, active: true }; publish();
    };
    document.addEventListener("pointerdown", start, true);
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerup", finish, true);
    document.addEventListener("pointercancel", finish, true);
    document.addEventListener("keydown", keydown, true);
    document.addEventListener("keyup", finish, true);
    window.addEventListener("blur", finish);
    return () => {
      document.removeEventListener("pointerdown", start, true); document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", finish, true); document.removeEventListener("pointercancel", finish, true);
      document.removeEventListener("keydown", keydown, true); document.removeEventListener("keyup", finish, true); window.removeEventListener("blur", finish);
    };
  }, [root]);
  return { ...gesture, point };
}

/** The focus line stays near the pointer even when the selected range spans pages. */
export function nativeSelectionFocus(root: HTMLElement): ScreenBox | undefined {
  const selection = window.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed || !root.contains(selection.focusNode) || !root.contains(selection.anchorNode)) return;
  const range = selection.getRangeAt(0);
  const atStart = selection.focusNode === range.startContainer && selection.focusOffset === range.startOffset;
  return rangeFocusBox(range, atStart);
}
export function rangeFocusBox(range: Range, atStart = false): ScreenBox | undefined {
  const focus = range.cloneRange();
  focus.collapse(atStart);
  const rect = focus.getBoundingClientRect();
  if (rect.height) return rect;
  const rects = [...range.getClientRects()].filter((r) => r.height && r.width);
  return atStart ? rects[0] : rects.at(-1);
}
