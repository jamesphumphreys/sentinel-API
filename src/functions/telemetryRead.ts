import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { TableClient, odata } from '@azure/data-tables';
import { requireAccess, errorStatus, forbidden } from '../access';

const SERIAL = /^[A-Za-z0-9._-]{1,100}$/;
const fields = ['uptimeSeconds','batteryVoltageMv','batteryPercent','solarVoltageMv','powerSource','batteryPresent','charging','operatorCode','operatorName','networkTechnology','networkBand','rssiDbm','rsrpDbm','rsrqDb','csq','rsrpRaw','rsrqRaw','registrationStatus','networkRegistered','packetAttached','dataContextActive','gnssFixType','gnssElapsedSeconds','latitude','longitude','altitudeMetres','hdop','pdop','vdop','firmwareVersion','sampledAt','receivedAt','deviceStatus'];
const fail = (status: number, error: string): HttpResponseInit => ({status, jsonBody:{error}});
function present(row: Record<string, unknown>, admin: boolean) {
  return Object.fromEntries(['rowKey', ...fields, ...(admin ? ['rawGnss','rawCpsi','customerId'] : [])].filter(k => row[k] !== undefined).map(k => [k,row[k]]));
}
async function read(request: HttpRequest, context: InvocationContext, latest: boolean): Promise<HttpResponseInit> {
  try {
    const access = await requireAccess(request);
    if (access.status !== 200) return forbidden(access.status);
    const serial = (request.params.serialNumber ?? '').toUpperCase();
    if (!SERIAL.test(serial)) return fail(400,'Invalid serial number');
    const devices = TableClient.fromConnectionString(access.connection,'SentinelDevices');
    let device;
    try { device = await devices.getEntity<{deviceId:string; customerId:string}>('DEVICE',serial); }
    catch(e) { if(errorStatus(e) === 404) return fail(404,'Device not found'); throw e; }
    if (!access.isAdmin && (!device.customerId || device.customerId !== access.user.customerId)) return fail(404,'Device not found');
    const limitRaw = request.query.get('limit') ?? '120';
    if (!latest && (!/^\d{1,4}$/.test(limitRaw) || Number(limitRaw)<1 || Number(limitRaw)>1000)) return fail(400,'limit must be between 1 and 1000');
    const limit = latest ? 1 : Number(limitRaw);
    const before = latest ? null : request.query.get('before');
    if (before !== null && !/^\d{13}-[0-9a-f-]{36}$/.test(before)) return fail(400,'Invalid before cursor');
    let filter = odata`PartitionKey eq ${serial} and deviceId eq ${device.deviceId}`;
    if (!access.isAdmin) filter += odata` and customerId eq ${device.customerId}`;
    if (before) filter += odata` and RowKey gt ${before}`;
    const table = TableClient.fromConnectionString(access.connection,'SentinelDeviceTelemetry');
    const rows: Record<string,unknown>[] = [];
    for await (const row of table.listEntities({queryOptions:{filter}}).byPage({maxPageSize:Math.min(limit+1,1000)})) {
      for (const entity of row) {
        rows.push(present(entity,access.isAdmin));
        if (rows.length > limit) break;
      }
      if (rows.length > limit || (latest && rows.length)) break;
    }
    const more = rows.length > limit;
    const samples = rows.slice(0,limit);
    return {status:200, headers:{'Cache-Control':'no-store'}, jsonBody: latest ? {serialNumber:serial,telemetry:samples[0] ?? null} : {serialNumber:serial,samples,nextBefore:more ? samples[samples.length-1].rowKey : null}};
  } catch(e) { context.error('Telemetry retrieval failed',e); return fail(500,'Unable to retrieve telemetry'); }
}
app.http('deviceTelemetryLatest',{methods:['GET'],authLevel:'anonymous',route:'devices/{serialNumber}/telemetry/latest',handler:(r,c)=>read(r,c,true)});
app.http('deviceTelemetryHistory',{methods:['GET'],authLevel:'anonymous',route:'devices/{serialNumber}/telemetry',handler:(r,c)=>read(r,c,false)});
