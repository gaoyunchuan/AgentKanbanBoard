import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';
import type { BackendProject } from '../types';
import { ProjectPicker } from './ProjectPicker';

type Props = {
  id?: string; label: string; value: string; projects: BackendProject[]; emptyLabel: string;
  onValueChange: (value: string) => void; disabled?: boolean;
};

/** 项目下拉独立于普通枚举选择：搜索输入不能被 Select 的字母跳转截获。 */
export function ProjectSelect({ id, label, value, projects, emptyLabel, onValueChange, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({});
  const trigger = useRef<HTMLButtonElement>(null), popup = useRef<HTMLDivElement>(null);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const below = innerHeight - rect.bottom - 18, above = rect.top - 18;
      const upwards = below < 220 && above > below;
      setPosition({ left: Math.max(12, Math.min(rect.left, innerWidth - rect.width - 12)), width: Math.min(rect.width, innerWidth - 24),
        top: upwards ? undefined : rect.bottom + 6, bottom: upwards ? innerHeight - rect.top + 6 : undefined,
        maxHeight: Math.max(100, Math.min(360, upwards ? above : below)) });
    };
    const outside = (e: PointerEvent) => {
      if (!trigger.current?.contains(e.target as Node) && !popup.current?.contains(e.target as Node)) setOpen(false);
    };
    place(); document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open]);
  const name = value ? projects.find(p => p.id === value)?.name || '项目已隐藏或不可用' : emptyLabel;
  return <>
    <button type="button" id={id} ref={trigger} role="combobox" aria-label={label} aria-expanded={open} aria-haspopup="listbox" disabled={disabled}
      className="studio-select-trigger" data-state={open ? 'open' : 'closed'} onClick={() => setOpen(!open)}
      onKeyDown={e => { if (!disabled && ['ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); setOpen(true); } }}>
      <span>{name}</span><ChevronDown size={14}/>
    </button>
    {open && !disabled && createPortal(<div className="studio hover-portal"><div ref={popup} className="project-select-popup" style={position} onKeyDownCapture={e => {
      // portal 不在 Modal 的焦点环内，Tab 先收起选择器，避免焦点落到底层页面。
      if(e.key==='Tab'){e.preventDefault();e.stopPropagation();close();}
    }}>
      <ProjectPicker projects={projects} selected={value} emptyLabel={emptyLabel} onClose={close} onSelect={id => { onValueChange(id); close(); }}/>
    </div></div>, document.body)}
  </>;
}
