import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { TableClient } from '@azure/data-tables';
import { requireAccess, forbidden } from '../access';

const SERIAL = /^[A-Za-z0-9._-]{1,100}$/;
const response = (status:number,error:string):HttpResponseInit => ({status,jsonBody:{error}});

async function powerSettingsUpdate(request:HttpRequest, context:InvocationContext):Promise<HttpResponseInit> {
  try {
    const access=await requireAccess(request);
    if(access.status!==200)return forbidden(access.status);
    if(!access.permissions.canManageDevices)return forbidden(403);
    const serial=(request.params.serialNumber??'').toUpperCase();
    if(!SERIAL.test(serial))return response(400,'Invalid serial number');
    const table=TableClient.fromConnectionString(access.connection,'SentinelDevices');
    let device;
    try {device=await table.getEntity<{status:string;customerId:string;deviceType:string;desiredPowerState?:string;telemetryIntervalSeconds?:number;powerOffCheckIntervalSeconds?:number}>('DEVICE',serial);}
    catch(e) {if((e as {statusCode?:number}).statusCode===404)return response(404,'Device not found');throw e;}
    if(device.status!=='Assigned'||!device.customerId||device.deviceType!=='BayMonitor')return response(409,'Device must be an assigned BayMonitor');
    let body:Record<string,unknown>;
    try {body=await request.json() as Record<string,unknown>;}catch{return response(400,'Invalid JSON');}
    if(!body||typeof body!=='object'||Array.isArray(body))return response(400,'Invalid settings');
    const state=body.desiredPowerState;
    const telemetry=body.telemetryIntervalSeconds;
    const sleeping=body.powerOffCheckIntervalSeconds;
    if(state!==undefined&&state!=='ON'&&state!=='OFF')return response(400,'desiredPowerState must be ON or OFF');
    if(telemetry!==undefined&&(!Number.isInteger(telemetry)|| (telemetry as number)<15||(telemetry as number)>86400))return response(400,'telemetryIntervalSeconds must be 15–86400');
    if(sleeping!==undefined&&(!Number.isInteger(sleeping)||(sleeping as number)<60||(sleeping as number)>86400))return response(400,'powerOffCheckIntervalSeconds must be 60–86400');
    if(state===undefined&&telemetry===undefined&&sleeping===undefined)return response(400,'No settings supplied');
    if(state==='OFF'&&!access.permissions.canShutdownDevices)return forbidden(403);
    const update:{partitionKey:string;rowKey:string;desiredPowerState?:string;telemetryIntervalSeconds?:number;powerOffCheckIntervalSeconds?:number;updatedAt:string}={partitionKey:'DEVICE',rowKey:serial,updatedAt:new Date().toISOString()};
    if(state!==undefined)update.desiredPowerState=state as string;
    if(telemetry!==undefined)update.telemetryIntervalSeconds=telemetry as number;
    if(sleeping!==undefined)update.powerOffCheckIntervalSeconds=sleeping as number;
    const etag=request.headers.get('if-match');
    if(!etag||etag==='*')return response(428,'Supply device ETag in If-Match');
    if(etag!==device.etag)return response(412,'Device changed; reload first');
    try {await table.updateEntity(update,'Merge',{etag});}
    catch(e){if((e as {statusCode?:number}).statusCode===412)return response(412,'Device changed; reload first');throw e;}
    const saved=await table.getEntity<typeof device>('DEVICE',serial);
    return {status:200,headers:{'Cache-Control':'no-store'},jsonBody:{
      desiredPowerState:saved.desiredPowerState==='OFF'?'OFF':'ON',
      telemetryIntervalSeconds:saved.telemetryIntervalSeconds??30,
      powerOffCheckIntervalSeconds:saved.powerOffCheckIntervalSeconds??300,
      etag:saved.etag
    }};
  }catch(e){context.error('Unable to update device power settings',e);return response(500,'Unable to update power settings');}
}
app.http('devicePowerSettingsUpdate',{methods:['PATCH'],authLevel:'anonymous',route:'devices/{serialNumber}/power-settings',handler:powerSettingsUpdate});
