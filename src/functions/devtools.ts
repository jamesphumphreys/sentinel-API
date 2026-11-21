import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { TableClient } from '@azure/data-tables';
import { requireAccess } from '../access';
import { sendSimulationPush } from './push';

async function authorise(request: HttpRequest) {
  const access = await requireAccess(request);
  return access.status === 200 && access.isAdmin ? access.connection : null;
}
const idPattern = /^SIM-[A-Za-z0-9-]{1,50}$/;
async function handler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const connection = await authorise(request);
    if (!connection) return {status: 403, jsonBody: {error: 'SuperAdministrator access required'}};
    const table = TableClient.fromConnectionString(connection, 'SentinelSimulations');
    await table.createTable().catch(e => { if ((e as {statusCode?: number}).statusCode !== 409) throw e; });
    if (request.method === 'GET') {
      const devices = [];
      for await (const row of table.listEntities()) {
        if (row.partitionKey !== 'SIM') continue;
        devices.push({id: row.rowKey, name: row.name, wet: row.wet, batteryPercent: row.batteryPercent,
          latitude: row.latitude, longitude: row.longitude, state: row.state, lastReport: row.lastReport,
          intervalMinutes: row.intervalMinutes, customerId: row.customerId});
      }
      return {status: 200, jsonBody: {devices}};
    }
    const body = await request.json() as Record<string, unknown>;
    const id = body.id;
    if (typeof id !== 'string' || !idPattern.test(id)) return {status:400,jsonBody:{error:'Simulation IDs must start SIM-'}};
    if (body.action === 'delete') {
      try { await table.deleteEntity('SIM', id); } catch(e) { if ((e as {statusCode?:number}).statusCode !== 404) throw e; }
      return {status:200,jsonBody:{ok:true}};
    }
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 100 ||
        typeof body.wet !== 'boolean' || typeof body.batteryPercent !== 'number' || body.batteryPercent < 0 || body.batteryPercent > 100 ||
        typeof body.latitude !== 'number' || !Number.isFinite(body.latitude) || Math.abs(body.latitude) > 90 ||
        typeof body.longitude !== 'number' || !Number.isFinite(body.longitude) || Math.abs(body.longitude) > 180 ||
        !['Monitoring','Offline','Shutdown'].includes(String(body.state)) ||
        typeof body.intervalMinutes !== 'number' || body.intervalMinutes < 1 || body.intervalMinutes > 1440 ||
        typeof body.customerId !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(body.customerId))
      return {status:400,jsonBody:{error:'Invalid simulation data'}};
    let previous: {wet?: boolean;state?:string;customerId?:string}|null = null;
    try { previous = await table.getEntity('SIM',id) as {wet?:boolean;state?:string;customerId?:string}; } catch(e) { if ((e as {statusCode?:number}).statusCode!==404) throw e; }
    const now = new Date().toISOString();
    await table.upsertEntity({partitionKey:'SIM',rowKey:id,name:body.name.trim(),wet:body.wet,
      batteryPercent:body.batteryPercent,latitude:body.latitude,longitude:body.longitude,
      state:body.state,intervalMinutes:body.intervalMinutes,customerId:body.customerId,
      lastReport: body.state === 'Monitoring' ? now : ''}, 'Replace');
    if (previous && previous.customerId === body.customerId) {
      const title = `${body.name.trim()} · Sentinel`;
      let event: string | null = null;
      if (previous.state !== body.state && body.state === 'Offline') event = 'Device offline';
      else if (previous.state === 'Monitoring' && body.state === 'Monitoring' && previous.wet !== body.wet) event = body.wet ? 'Water detected' : 'Water cleared';
      if (event) await sendSimulationPush(connection,body.customerId,title,event).catch(e=>context.error('Push failed; simulation saved',e));
    }
    return {status:200,jsonBody:{ok:true,lastReport:now}};
  } catch(e) { context.error('Developer simulation error',e); return {status:500,jsonBody:{error:'Simulation request failed'}}; }
}
app.http('devtools', {methods:['GET','POST'],authLevel:'anonymous',route:'devtools/simulations',handler});
