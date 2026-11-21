import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { TableClient } from '@azure/data-tables';
import { requireAccess, validCustomerId, normaliseAUPhone, errorStatus, forbidden, readUserAccess } from '../access';

const OID = /^[0-9a-fA-F]{8}-[0-9a-fA-F-]{27,40}$/;
const USER = 'SentinelUsers';
function present(row: Record<string, unknown>) {
  return { userId: row.rowKey, displayName: row.displayName ?? '', email: row.email ?? '', phoneNumber: row.phoneNumber ?? '',
    role: row.role, status: row.status, customerId: row.customerId ?? null };
}
async function handler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const access = await requireAccess(request);
    if (access.status !== 200) return forbidden(access.status);
    const table = TableClient.fromConnectionString(access.connection, USER);
    const grants = TableClient.fromConnectionString(access.connection, 'SentinelUserAccess');
    if (request.method === 'GET') {
      const customerId = request.query.get('customerId');
      if (!customerId || !validCustomerId(customerId) || (!access.isAdmin && access.user.customerId !== customerId)) return forbidden(403);
      const users: ReturnType<typeof present>[] = [];
      for await (const profile of table.listEntities()) {
        if (profile.partitionKey !== 'USER') continue;
        let row;
        try { row = (await readUserAccess(access.connection, profile.rowKey)).user; }
        catch(e) { if(errorStatus(e) === 404) continue; throw e; }
        if ((row.status === 'Active' || (access.isAdmin && row.status === 'Disabled')) && (row.customerId === customerId || (access.isAdmin && row.role === 'SuperAdministrator' && row.defaultCustomerId === customerId))) users.push(present(row));
      }
      return { status: 200, jsonBody: { users } };
    }
    if (!access.isAdmin) return forbidden(403);
    const body = await request.json() as Record<string, unknown>;
    if (typeof body.userId !== 'string' || !OID.test(body.userId) || typeof body.displayName !== 'string' || !body.displayName.trim() || body.displayName.length > 100 ||
        typeof body.email !== 'string' || body.email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.email) ||
        !validCustomerId(body.customerId) || !['Active', 'Disabled'].includes(String(body.status)) ||
        (body.phoneNumber !== undefined && body.phoneNumber !== '' && (typeof body.phoneNumber !== 'string' || !normaliseAUPhone(body.phoneNumber))))
      return { status: 400, jsonBody: { error: 'Supply an Entra user object ID, name, email, customer, valid Australian mobile and status' } };
    const customers = TableClient.fromConnectionString(access.connection, 'SentinelCustomers');
    let customer;
    try { customer = await customers.getEntity('CUSTOMER', body.customerId as string); }
    catch (e) { if (errorStatus(e) === 404) return {status:404,jsonBody:{error:'Customer not found'}}; throw e; }
    if (customer.status !== 'Active') return {status:400,jsonBody:{error:'Customer is not active'}};
    const id = (body.userId as string).toLowerCase();
    let existing: Record<string, unknown> | null = null;
    try { existing = await table.getEntity('USER', id); }
    catch (e) { if (errorStatus(e) !== 404) throw e; }
    let grant;
    try { grant = await grants.getEntity('USER', id); } catch(e) { if(errorStatus(e) !== 404) throw e; }
    if ((existing && existing.role === 'SuperAdministrator') || grant?.role === 'SuperAdministrator') return {status:403,jsonBody:{error:'SuperAdministrator records cannot be changed here'}};
    const record = { partitionKey: 'USER', rowKey: id, status: body.status as string,
      displayName: (body.displayName as string).trim(), email: (body.email as string).trim(),
      phoneNumber: body.phoneNumber ? normaliseAUPhone(body.phoneNumber as string)! : '',
      ...(!existing ? {createdAt:new Date().toISOString()} : {}), updatedAt: new Date().toISOString() };
    await grants.upsertEntity({partitionKey:'USER',rowKey:id,role:'Customer',customerId:body.customerId as string,canManageDevices:false,canShutdownDevices:false}, 'Merge');
    await table.upsertEntity(record, 'Merge');
    return { status: existing ? 200 : 201, jsonBody: present({...record,role:'Customer',customerId:body.customerId}) };
  } catch (e) { context.error('Customer user management error', e); return {status:500,jsonBody:{error:'Customer user request failed'}}; }
}
app.http('customerUsers',{methods:['GET','PUT'],authLevel:'anonymous',route:'customer/users',handler});
