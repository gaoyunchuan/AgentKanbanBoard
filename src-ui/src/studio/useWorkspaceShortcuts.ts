import { useEffect, useRef } from 'react';
import { shortcutActions, shortcutFromEvent, type ShortcutAction, type Shortcuts } from './workspacePreferences';

export type WorkspaceShortcutAction = ShortcutAction | 'renameConversation' | 'newConversation' | 'settings';
type NativeShortcut = { action: WorkspaceShortcutAction; conversationId?: string };
type NativeShortcutBridge = {
  platform?: string;
  setShortcuts?: (shortcuts: Shortcuts) => void;
  onBrowserNotice?: (handler: (message: string) => void) => () => void;
  onShortcut?: (handler: (event: NativeShortcut) => void) => () => void;
};

function inRightDock(target: Element | null) {
  return Boolean(target?.closest('.right-dock:not([hidden]), .dock-tabbar:not(.tools-collapsed)'));
}

function nativeBridge(): NativeShortcutBridge | undefined {
  return (window as Window & { akb?: NativeShortcutBridge }).akb;
}

export function useWorkspaceShortcuts(shortcuts: Shortcuts, owner: string | undefined,
  run: (action: WorkspaceShortcutAction, rightSide: boolean) => void, navigate: (view: 'chat' | 'tasks') => void, closeEnabled: boolean, notify: (message: string) => void) {
  const latest = useRef({ owner, run, navigate, shortcuts, closeEnabled, notify });
  latest.current = { owner, run, navigate, shortcuts, closeEnabled, notify };

  useEffect(() => { nativeBridge()?.setShortcuts?.(shortcuts); }, [shortcuts]);
  useEffect(() => {
    const unsubscribe = nativeBridge()?.onShortcut?.(({ action, conversationId }) => {
      if (conversationId !== undefined) {
        if (conversationId === latest.current.owner) latest.current.run(action, true);
      } else if (action !== 'close' || latest.current.closeEnabled) {
        latest.current.run(action, inRightDock(document.activeElement));
      }
    });
    const unsubscribeNotice = nativeBridge()?.onBrowserNotice?.(message => latest.current.notify(message));
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.target instanceof Element && event.target.closest('[data-shortcut-capture]')) return;
      // 任务树也使用 F2 编辑任务名，仅在会话可见时拦截。
      if (latest.current.owner && event.key === 'F2' && !event.isComposing
        && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) latest.current.run('renameConversation', false);
        return;
      }
      if (event.key === ',' && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) latest.current.run('settings', false);
        return;
      }
      const combo = shortcutFromEvent(event);
      if (!combo) return;
      // 固定的新建会话快捷键只作用于当前会话，避免空聊天或任务树误创建。
      if (combo === 'N' && event.metaKey && !event.ctrlKey && latest.current.owner) {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) latest.current.run('newConversation', false);
        return;
      }
      if (combo === '1' || combo === '2') {
        event.preventDefault();
        if (!event.repeat) latest.current.navigate(combo === '1' ? 'tasks' : 'chat');
        return;
      }
      // macOS 终端中的 Ctrl 组合键属于 Shell。
      if (event.ctrlKey && combo !== 'Ctrl+Backquote' && nativeBridge()?.platform === 'darwin') return;
      // 与原生菜单、独立网页共用固定关闭语义，Cmd+W 不得落回主窗口关闭。
      const action = combo === 'W' ? 'close' : shortcutActions.find(key => latest.current.shortcuts[key] === combo);
      if (!action || action === 'close' && !latest.current.closeEnabled) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      const target = event.target instanceof Element ? event.target : document.activeElement;
      latest.current.run(action, inRightDock(target));
    };
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('keydown', onKey, true); unsubscribe?.(); unsubscribeNotice?.(); };
  }, []);
}
