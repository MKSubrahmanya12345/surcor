import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";

export interface TreeMenuItem {
  id: string;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
  dividerBefore?: boolean;
  shortcut?: string;
}

export interface MenuPosition {
  x: number;
  y: number;
}

/**
 * VS Code-style context menu for the explorer. Rendered in a fixed-position
 * layer (no portal needed: nothing above it clips or stacks over the sidebar),
 * clamped to the viewport, and closed by Escape, an outside click, window blur
 * or a resize. Arrow keys and Enter work like a real menu.
 */
export function TreeContextMenu({ position, items, onClose }: {
  position: MenuPosition;
  items: TreeMenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [placement, setPlacement] = useState<MenuPosition>(position);
  const [focused, setFocused] = useState(-1);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    setPlacement({
      x: Math.max(4, Math.min(position.x, window.innerWidth - rect.width - 6)),
      y: Math.max(4, Math.min(position.y, window.innerHeight - rect.height - 6)),
    });
  }, [position.x, position.y, items.length]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); return; }
      if (event.key === "ArrowDown") { event.preventDefault(); setFocused((index) => (index + 1) % items.length); return; }
      if (event.key === "ArrowUp") { event.preventDefault(); setFocused((index) => (index <= 0 ? items.length - 1 : index - 1)); return; }
      if (event.key === "Enter" || event.key === " ") {
        const item = items[focused];
        if (!item || item.disabled) return;
        event.preventDefault();
        onClose();
        item.onSelect();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [items, focused, onClose]);

  return (
    <div className="tree-context-menu" role="menu" ref={ref} style={{ left: placement.x, top: placement.y }}>
      {items.map((item, index) => (
        <Fragment key={item.id}>
          {item.dividerBefore && <div className="tree-menu-separator" role="separator" />}
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className={[
              "tree-menu-item",
              item.danger ? "danger" : "",
              index === focused ? "focused" : "",
            ].filter(Boolean).join(" ")}
            disabled={item.disabled}
            onMouseEnter={() => setFocused(index)}
            onMouseLeave={() => setFocused(-1)}
            onClick={() => {
              if (item.disabled) return;
              onClose();
              item.onSelect();
            }}
          >
            <span className="tree-menu-label">{item.label}</span>
            {item.shortcut && <span className="tree-menu-shortcut">{item.shortcut}</span>}
          </button>
        </Fragment>
      ))}
    </div>
  );
}
