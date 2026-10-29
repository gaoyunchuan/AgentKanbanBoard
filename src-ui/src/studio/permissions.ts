import type { TaskConfig } from '../workbench/types';

type Policy = Pick<TaskConfig, 'sandbox_mode' | 'approval_policy'>;
export type PermissionMode = 'on-request' | 'read-only' | 'full-access' | 'custom';
export const permissionPresets: Record<Exclude<PermissionMode, 'custom'>, Required<Policy>> = {
  'on-request': {sandbox_mode:'workspace-write',approval_policy:'on-request'},
  'read-only': {sandbox_mode:'read-only',approval_policy:'on-request'},
  'full-access': {sandbox_mode:'danger-full-access',approval_policy:'never'},
};

export function permissionMode(config?: Policy): PermissionMode {
  if (!config) return 'on-request';
  for (const [mode, preset] of Object.entries(permissionPresets)) {
    if (config.sandbox_mode === preset.sandbox_mode && config.approval_policy === preset.approval_policy) return mode as Exclude<PermissionMode, 'custom'>;
  }
  return 'custom';
}

export function permissionLabel(config?: Policy): string {
  // 放开沙箱但仍逐次审批属于自定义配置，不能把它标成无需确认的“完全访问”。
  return {'on-request':'按需确认','read-only':'只读','full-access':'完全访问',custom:'自定义权限'}[permissionMode(config)];
}
