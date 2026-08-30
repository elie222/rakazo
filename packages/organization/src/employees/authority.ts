import type { AuthorityPolicy } from "@rakazo/contracts";

export const DEFAULT_AUTHORITY: AuthorityPolicy = {
  canCreateWorkItems: true,
  canAssignWork: false,
  canDelegate: false,
  canReview: false,
  canManageDepartment: false,
  canCreateProjects: false,
  canModifyProjects: false,
  canCreateGoals: false,
  canModifyGoals: false,
  canManageEmployees: false,
  canResolveEscalations: false,
  canTriggerDeployment: false,
  canSendExternalCommunication: false,
  canSpendMoney: false,
};

export const MANAGER_AUTHORITY: AuthorityPolicy = {
  canCreateWorkItems: true,
  canAssignWork: true,
  canDelegate: true,
  canReview: true,
  canManageDepartment: false,
  canCreateProjects: true,
  canModifyProjects: true,
  canCreateGoals: false,
  canModifyGoals: false,
  canManageEmployees: false,
  canResolveEscalations: true,
  canTriggerDeployment: false,
  canSendExternalCommunication: false,
  canSpendMoney: false,
};

export const EXECUTIVE_AUTHORITY: AuthorityPolicy = {
  canCreateWorkItems: true,
  canAssignWork: true,
  canDelegate: true,
  canReview: true,
  canManageDepartment: true,
  canCreateProjects: true,
  canModifyProjects: true,
  canCreateGoals: true,
  canModifyGoals: true,
  canManageEmployees: true,
  canResolveEscalations: true,
  canTriggerDeployment: true,
  canSendExternalCommunication: true,
  canSpendMoney: true,
};

export function mergeAuthority(
  base: Partial<AuthorityPolicy>,
  overrides: Partial<AuthorityPolicy>,
): AuthorityPolicy {
  return { ...DEFAULT_AUTHORITY, ...base, ...overrides };
}

export function hasAuthority(authority: AuthorityPolicy, key: keyof AuthorityPolicy): boolean {
  return Boolean(authority[key]);
}
