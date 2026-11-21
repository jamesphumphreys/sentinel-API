import { TableClient } from '@azure/data-tables';
import type { HttpRequest } from '@azure/functions';
import { authenticateUser } from './auth';

export type SentinelAccount = {
  displayName?: string; email?: string; phoneNumber?: string;
  role?: string; status?: string; customerId?: string;
  defaultFarmId?: string; defaultCustomerId?: string;
};
export type SentinelPermissions = { canManageDevices: boolean; canShutdownDevices: boolean };
export type Access = { status: 200; connection: string; userId: string; user: SentinelAccount; isAdmin: boolean; permissions: SentinelPermissions } | { status: 401 | 403 };
export const validCustomerId = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(id);
export const validFarmId = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(id);
export const errorStatus = (e: unknown) => (e as { statusCode?: number }).statusCode;
export const forbidden = (status: number) => ({ status, jsonBody: { error: status === 401 ? 'Sign-in required' : 'Access denied' } });

export async function readUserAccess(connection: string, userId: string) {
  const profile = await TableClient.fromConnectionString(connection, 'SentinelUsers').getEntity<SentinelAccount>('USER', userId);
  const grant = await TableClient.fromConnectionString(connection, 'SentinelUserAccess').getEntity<{role?:string; customerId?:string; canManageDevices?:boolean; canShutdownDevices?:boolean}>('USER', userId);
  const user = { ...profile, role: grant.role, customerId: grant.customerId };
  const isAdmin = grant.role === 'SuperAdministrator';
  const canManageDevices = user.status === 'Active' && isAdmin && grant.canManageDevices === true;
  return { user, isAdmin, permissions: { canManageDevices, canShutdownDevices: canManageDevices && grant.canShutdownDevices === true } };
}

export async function requireAccess(request: HttpRequest): Promise<Access> {
  const identity = await authenticateUser(request);
  if (!identity) return { status: 401 };
  const connection = process.env.SENTINEL_STORAGE_CONNECTION;
  if (!connection) throw new Error('SENTINEL_STORAGE_CONNECTION is missing');
  try {
    const {user, isAdmin, permissions} = await readUserAccess(connection, identity.userId);
    if (user.status !== 'Active') return { status: 403 };
    if (!isAdmin && (user.role !== 'Customer' || !validCustomerId(user.customerId))) return { status: 403 };
    return { status: 200, connection, userId: identity.userId, user, isAdmin, permissions };
  } catch (e) {
    if (errorStatus(e) === 404) return { status: 403 };
    throw e;
  }
}
export function canAccessCustomer(a: Extract<Access, { status: 200 }>, customerId: string) {
  return validCustomerId(customerId) && (a.isAdmin || a.user.customerId === customerId);
}
export function customerForUser(a: Extract<Access, { status: 200 }>): string | null {
  return a.isAdmin ? (validCustomerId(a.user.defaultCustomerId) ? a.user.defaultCustomerId : null) : a.user.customerId ?? null;
}
export function normaliseAUPhone(value: string): string | null {
  const raw = value.replace(/[\s()-]/g, '');
  const normalized = /^04\d{8}$/.test(raw) ? '+61' + raw.slice(1) : raw;
  return /^\+614\d{8}$/.test(normalized) ? normalized : null;
}
