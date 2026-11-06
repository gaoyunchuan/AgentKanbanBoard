import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

/** 项目候选共用导航；高亮独立于已选值，避免浏览候选就修改绑定或筛选。 */
export function useProjectNavigation(ids: string[], onSelect: (id: string) => void, selected?: string, onClose?: () => void) {
  const listId = useId();
  const [highlighted, setHighlighted] = useState<string | undefined>(selected);
  const composing = useRef(false);
  const active = highlighted !== undefined && ids.includes(highlighted) ? highlighted : ids[0];
  const optionId = (id: string) => `${listId}-option-${encodeURIComponent(id)}`;
  useEffect(() => {
    if (active !== undefined) document.getElementById(optionId(active))?.scrollIntoView?.({ block: 'nearest' });
  }, [active, listId]);
  function onKeyDown(e: KeyboardEvent) {
    e.stopPropagation();
    // 某些输入法在 compositionend 后才发送确认键，229 仍必须保留给输入法。
    if (composing.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
    if (e.key === 'Escape' && onClose) { e.preventDefault(); onClose(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (ids.length) setHighlighted(ids[(ids.indexOf(active ?? '') + (e.key === 'ArrowDown' ? 1 : -1) + ids.length) % ids.length]);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (active !== undefined) onSelect(active);
    }
  }
  return {
    listId, active, optionId, setHighlighted,
    reset: () => setHighlighted(undefined),
    inputProps: {
      role: 'combobox' as const, 'aria-expanded': true, 'aria-controls': listId,
      'aria-autocomplete': 'list' as const, 'aria-activedescendant': active === undefined ? undefined : optionId(active),
      onKeyDown, onCompositionStart: () => { composing.current = true; }, onCompositionEnd: () => { composing.current = false; },
    },
    onKeyDown,
  };
}
