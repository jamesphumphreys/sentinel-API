import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { TableClient } from '@azure/data-tables';
import { createHash } from 'node:crypto';
import webpush from 'web-push';
import { requireAccess, customerForUser, forbidden, errorStatus, readUserAccess } from '../access';

export type SubscriptionRecord = { endpoint: string; p256dh: string; auth: string; customerId: string; enabled: boolean };
const tableName = 'SentinelPushSubscriptions';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function configure() {
  const publicKey = process.env.SENTINEL_VAPID_PUBLIC_KEY;
  const privateKey = process.env.SENTINEL_VAPID_PRIVATE_KEY;
  const subject = process.env.SENTINEL_VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject) throw new Error('VAPID settings missing');
  webpush.setVapidDetails(subject, publicKey, privateKey);
  return publicKey;
}

export async function sendSimulationPush(connection: string, customerId: string, title: string, body: string, allowedUserIds?: string[]) {
  configure();
  const table = TableClient.fromConnectionString(connection, tableName);
  await table.createTable().catch(e => {if ((e as {statusCode?:number}).statusCode !== 409) throw e;});
  for await (const record of table.listEntities<SubscriptionRecord & {userId?:string}>({queryOptions:{filter:`PartitionKey eq '${customerId.replace(/'/g,"''")}'`}})) {
    if (!record.enabled || !record.userId || (allowedUserIds && !allowedUserIds.includes(record.userId))) continue;
    // Revoking/moving a customer must also revoke their old push deliveries immediately.
    try {
      const {user} = await readUserAccess(connection, record.userId);
      if (user.status !== 'Active' || (user.role !== 'SuperAdministrator' && (user.role !== 'Customer' || user.customerId !== customerId))) continue;
    } catch (e) { if ((e as {statusCode?:number}).statusCode===404) continue; throw e; }
    try {
      await webpush.sendNotification({endpoint:record.endpoint,keys:{p256dh:record.p256dh,auth:record.auth}}, JSON.stringify({title,body,url:'/'}), {TTL:3600});
    } catch (e) {
      const status = (e as {statusCode?:number}).statusCode;
      if (status === 404 || status === 410) await table.deleteEntity(record.partitionKey,record.rowKey).catch(()=>{});
      else console.error('Push delivery failed', status ?? e);
    }
  }
}

async function handler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const a = await requireAccess(request);
    if (a.status !== 200) return forbidden(a.status);
    if (request.method === 'GET') return {status:200,jsonBody:{publicKey:configure()}};
    const data = await request.json() as Record<string,unknown>;
    if (typeof data.endpoint !== 'string' || !data.endpoint.startsWith('https://') || data.endpoint.length > 2048 ||
      typeof data.p256dh !== 'string' || data.p256dh.length > 256 || typeof data.auth !== 'string' || data.auth.length > 256)
      return {status:400,jsonBody:{error:'Invalid push subscription'}};
    const table = TableClient.fromConnectionString(a.connection,tableName);
    await table.createTable().catch(e=>{if((e as {statusCode?:number}).statusCode!==409)throw e;});
    const rowKey = hash(a.userId + ':' + data.endpoint);
    const customerId = customerForUser(a);
    if (!customerId) return {status:400,jsonBody:{error:'Choose a default customer/property before enabling push'}};
    if (request.method === 'DELETE') {
      await table.deleteEntity(customerId,rowKey).catch(e=>{if((e as {statusCode?:number}).statusCode!==404)throw e;});
    } else {
      await table.upsertEntity({partitionKey:customerId,rowKey,userId:a.userId,endpoint:data.endpoint,p256dh:data.p256dh,auth:data.auth,enabled:true},'Replace');
    }
    return {status:200,jsonBody:{ok:true}};
  } catch(e) {context.error('Push subscription error',e);return {status:500,jsonBody:{error:'Push operation failed'}};}
}
app.http('pushSubscription',{methods:['GET','POST','DELETE'],authLevel:'anonymous',route:'push/subscription',handler});
