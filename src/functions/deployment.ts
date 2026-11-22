import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { TableClient } from '@azure/data-tables';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { requireAccess, canAccessCustomer, forbidden, errorStatus, normaliseAUPhone, validCustomerId, readUserAccess } from '../access';
import { sendSimulationPush } from './push';

const SERIAL = /^[A-Za-z0-9._-]{1,100}$/;
const ID = /^[A-Za-z0-9._:-]{1,100}$/;
const GO = /^[A-Za-z0-9._:-]{1,80}$/;
const TABLES = {devices:'SentinelDevices', deployments:'SentinelDeployments', events:'SentinelDeviceEvents', commands:'SentinelDeviceCommands'};
const sha = (s:string) => createHash('sha256').update(s).digest('hex');
const storage = () => { const connection = process.env.SENTINEL_STORAGE_CONNECTION; if (!connection) throw new Error('Storage not configured'); return connection; };
const table = (c:string,n:string) => TableClient.fromConnectionString(c,n);
const fail = (status:number,error:string):HttpResponseInit => ({status,jsonBody:{error}});
const now = () => new Date().toISOString();
const isNumber = (v:unknown,limit:number):v is number => typeof v==='number' && Number.isFinite(v) && Math.abs(v)<=limit;
type Coordinate = [number,number];
type Device = { deviceId:string; status:string; deviceType:string; displayName:string; customerId:string; deviceKeyHash?:string;
  locationMode?:string; manualLatitude?:number; manualLongitude?:number; currentDeploymentId?:string; lastGoId?:string;
  deploymentState?:string; lastSeenAt?:string; batteryPercent?:number; lastWaterState?:boolean;
  activeLatitude?:number; activeLongitude?:number; activeFarmId?:string; activeBayId?:string;
  desiredPowerState?:string; telemetryIntervalSeconds?:number; powerOffCheckIntervalSeconds?:number; };
type Config = { deploymentId:string; version:number; farmId:string; farmName:string; bayId:string; bayName:string;
  pushEnabled:boolean; smsEnabled:boolean; smsRepeatMinutes:number; smsMaxReminders:number;
  smsRecipients:{userId:string; phoneNumber:string}[]; };
type Deployment = { customerId:string; serialNumber:string; status:string; farmId?:string; farmName?:string; bayId?:string; bayName?:string;
  latitude?:number;longitude?:number; goId?:string; requestedAt?:string; confirmedAt?:string; configuredAt?:string; ackCommandAlertId?:string;
  configVersion?:number; configJson?:string; currentAlertId?:string; ackCommandId?:string; ackPhone?:string; ackAt?:string; };
type DeviceEvent = {eventId:string;type:string;at?:string; relatedEventId?:string;recipient?:string;modemResult?:string;sender?:string;commandId?:string};

type PowerCommand = {partitionKey:string;rowKey:string;customerId:string;type:string;status:string;
  requestedAt:string;expiresAt:string;deliveredAt?:string;appliedAt?:string;confirmedAt?:string};

// Commands are queued by the portal and delivered during authenticated device check-in.
async function pendingPowerCommands(connection:string, serial:string, customerId:string) {
  const commands=table(connection,TABLES.commands);
  try {
    const result:{commandId:string;type:string}[]=[];
    for await(const cmd of commands.listEntities<PowerCommand>({queryOptions:{filter:`PartitionKey eq '${serial}'`}})) {
      if(cmd.customerId!==customerId || !['DEVICE_RESTART','DEVICE_SHUTDOWN'].includes(cmd.type))continue;
      if(cmd.status!=='Queued' && cmd.status!=='Delivered')continue;
      if(Date.parse(cmd.expiresAt)<=Date.now()) {
        try {await commands.updateEntity({partitionKey:serial,rowKey:cmd.rowKey,status:'Expired'},'Merge',{etag:cmd.etag});}
        catch(e){if(errorStatus(e)!==412 && errorStatus(e)!==404)throw e;}
        continue;
      }
      if(cmd.status==='Queued') {
        try {await commands.updateEntity({partitionKey:serial,rowKey:cmd.rowKey,status:'Delivered',deliveredAt:now()},'Merge',{etag:cmd.etag});}
        catch(e){if(errorStatus(e)===412 || errorStatus(e)===404)continue;throw e;}
      }
      result.push({commandId:cmd.rowKey,type:cmd.type});
    }
    return result;
  }catch(e){if(errorStatus(e)===404)return [];throw e;}
}

async function applyPowerCommandEvent(connection:string, serial:string, customerId:string, ev:DeviceEvent) {
  if(!ev.commandId || (ev.type!=='COMMAND_APPLIED' && ev.type!=='BOOT'))return;
  const commands=table(connection,TABLES.commands);
  let cmd:PowerCommand & {etag?:string};
  try {cmd=await commands.getEntity<PowerCommand>(serial,ev.commandId);}
  catch(e){if(errorStatus(e)===404)return;throw e;}
  if(cmd.customerId!==customerId || !['DEVICE_RESTART','DEVICE_SHUTDOWN'].includes(cmd.type))return;
  if(ev.type==='COMMAND_APPLIED' && cmd.status==='Delivered') {
    try {await commands.updateEntity({partitionKey:serial,rowKey:cmd.rowKey,status:'Applied',appliedAt:now()},'Merge',{etag:cmd.etag});}
    catch(e){if(errorStatus(e)!==412)throw e;}
  }
  if(ev.type==='BOOT' && cmd.type==='DEVICE_RESTART' && (cmd.status==='Applied' || cmd.status==='Delivered')) {
    try {await commands.updateEntity({partitionKey:serial,rowKey:cmd.rowKey,status:'Confirmed',confirmedAt:now()},'Merge',{etag:cmd.etag});}
    catch(e){if(errorStatus(e)!==412)throw e;}
  }
}

function inside([lat,lng]:Coordinate,polygon:Coordinate[]) {
  let result=false;
  for(let i=0,j=polygon.length-1;i<polygon.length;j=i++) {
    const [yi,xi]=polygon[i], [yj,xj]=polygon[j];
    if((yi>lat)!==(yj>lat) && lng<(xj-xi)*(lat-yi)/(yj-yi)+xi) result=!result;
  }
  return result;
}
async function resolveLocation(connection:string,customerId:string,latitude:number,longitude:number) {
  const farms = table(connection,'SentinelFarms');
  const bays = table(connection,'SentinelBays');
  const matches: {farmId:string;farmName:string;bayId:string;bayName:string}[]=[];
  for await(const farm of farms.listEntities({queryOptions:{filter:`PartitionKey eq '${customerId}'`}})) {
    for await(const bay of bays.listEntities({queryOptions:{filter:`PartitionKey eq '${farm.rowKey}'`}})) {
      if(bay.customerId!==customerId) continue;
      try {const points=JSON.parse(String(bay.pointsJson)) as Coordinate[];
        if(Array.isArray(points) && points.length>=3 && inside([latitude,longitude],points)) matches.push({farmId:String(farm.rowKey),farmName:String(farm.name),bayId:String(bay.rowKey),bayName:String(bay.name)});
      } catch { /* an invalid polygon is not a match */ }
    }
  }
  return matches.length===1 ? matches[0] : null;
}
async function checkDeviceOwnership(c:string, serial:string, user:Awaited<ReturnType<typeof requireAccess>>) {
  if(user.status!==200) return null;
  try {
    const device = await table(c,TABLES.devices).getEntity<Device>('DEVICE',serial);
    return canAccessCustomer(user,device.customerId) && device.status==='Assigned' && device.deviceType==='BayMonitor' ? device : null;
  } catch(e) {if(errorStatus(e)===404)return null;throw e;}
}
function presentDeployment(d:Deployment & {rowKey?:string}) {
  let config:Config|null=null;
  try { if(d.configJson) config=JSON.parse(d.configJson) as Config; } catch { /* corrupt record */ }
  return { id:d.rowKey,serialNumber:d.serialNumber,customerId:d.customerId,status:d.status,goId:d.goId,
    farmId:d.farmId??null,farmName:d.farmName??null,bayId:d.bayId??null,bayName:d.bayName??null,
    latitude:d.latitude??null,longitude:d.longitude??null,requestedAt:d.requestedAt??null,confirmedAt:d.confirmedAt??null,
    configuredAt:d.configuredAt??null,configVersion:d.configVersion??null,
    currentAlertId:d.currentAlertId??null,ackPhone:d.ackPhone??null,ackAt:d.ackAt??null,
    preferences:config?{pushEnabled:config.pushEnabled,smsEnabled:config.smsEnabled,smsRepeatMinutes:config.smsRepeatMinutes,smsMaxReminders:config.smsMaxReminders,smsRecipientUserIds:config.smsRecipients.map(r=>r.userId)}:null };
}

// Only administrators can provision/rotate a device credential. The secret is returned once.
async function credential(request:HttpRequest,context:InvocationContext):Promise<HttpResponseInit> {
  try {
    const a=await requireAccess(request); if(a.status!==200)return forbidden(a.status);
    if(!a.isAdmin)return forbidden(403);
    const serial=(request.params.serialNumber??'').toUpperCase();
    if(!SERIAL.test(serial))return fail(400,'Invalid serial number');
    const devices=table(a.connection,TABLES.devices);
    let device;
    try {device=await devices.getEntity<Device>('DEVICE',serial);} catch(e){if(errorStatus(e)===404)return fail(404,'Device not found');throw e;}
    if(device.status==='Retired')return fail(409,'Retired devices cannot be provisioned');
    try { await table(a.connection,'SentinelDeviceProvisioning').getEntity('DEVICE',serial); return fail(409,'Use OTA credential management for this device'); } catch(e) { if(errorStatus(e)!==404)throw e; }
    const secret=randomBytes(32).toString('base64url');
    await devices.updateEntity({partitionKey:'DEVICE',rowKey:serial,deviceKeyHash:sha(secret),updatedAt:now()},'Merge',{etag:device.etag});
    return {status:200,headers:{'Cache-Control':'no-store'},jsonBody:{serialNumber:serial,deviceKey:secret,warning:'Save in device secure storage now. It cannot be recovered. Rotating invalidates previous key.'}};
  } catch(e){context.error('Credential provisioning failed',e);return fail(500,'Unable to provision device credential');}
}

async function deviceCheckin(request:HttpRequest,context:InvocationContext):Promise<HttpResponseInit> {
  try {
    const serial=(request.params.serialNumber??'').toUpperCase();
    if(!SERIAL.test(serial))return fail(400,'Invalid device serial number');
    const provided=request.headers.get('x-sentinel-device-key')??'';
    if(!provided || provided.length>200)return fail(401,'Device credential required');
    const c=storage(),devices=table(c,TABLES.devices);
    let device;
    try {device=await devices.getEntity<Device>('DEVICE',serial);}catch(e){if(errorStatus(e)===404)return fail(401,'Unknown device');throw e;}
    const saved=device.deviceKeyHash ?? '';
    if(!/^[0-9a-f]{64}$/.test(saved) || !timingSafeEqual(Buffer.from(saved,'hex'),Buffer.from(sha(provided),'hex')))return fail(401,'Invalid device credential');
    if(device.status!=='Assigned' || !validCustomerId(device.customerId))return fail(403,'Device is not assigned');
    if(device.deviceType!=='BayMonitor')return fail(403,'This endpoint is for BayMonitors');
    const body=await request.json() as Record<string,unknown>;
    if(!body || typeof body!=='object' || Array.isArray(body))return fail(400,'Invalid check-in');
    const latitude=body.latitude,longitude=body.longitude;
    if((latitude!==undefined||longitude!==undefined) && (!isNumber(latitude,90)||!isNumber(longitude,180)))return fail(400,'Invalid GPS coordinates');
    if(body.batteryPercent!==undefined && (typeof body.batteryPercent!=='number'||body.batteryPercent<0||body.batteryPercent>100))return fail(400,'Invalid battery percentage');
    if(body.wet!==undefined && typeof body.wet!=='boolean')return fail(400,'Invalid water state');
    const goId: string | undefined =
    typeof body.goId === 'string' ? body.goId : undefined;
    if(goId!==undefined && (typeof goId!=='string'||!GO.test(goId)))return fail(400,'Invalid GO identifier');
    const events=body.events===undefined?[]:body.events;
    if(!Array.isArray(events) || events.length>25)return fail(400,'Maximum 25 events per upload');
    const allowed=['WATER_DETECTED','WATER_CLEARED','SMS_SENT','SMS_FAILED','ALERT_ACKNOWLEDGED','LOCAL_FALLBACK','CONFIG_APPLIED','COMMAND_APPLIED','BOOT'];
    for(const ev of events) {
      if(!ev || typeof ev!=='object' || Array.isArray(ev) || typeof ev.eventId!=='string' || !ID.test(ev.eventId) || !allowed.includes(ev.type) ||
        (ev.at!==undefined && (typeof ev.at!=='string'||ev.at.length>40)) ||
        (ev.relatedEventId!==undefined && (typeof ev.relatedEventId!=='string'||!ID.test(ev.relatedEventId))) ||
        (ev.commandId!==undefined && (typeof ev.commandId!=='string'||!ID.test(ev.commandId))) ||
        (ev.recipient!==undefined && (typeof ev.recipient!=='string'||!normaliseAUPhone(ev.recipient))) ||
        (ev.sender!==undefined && (typeof ev.sender!=='string'||!normaliseAUPhone(ev.sender))) ||
        (ev.modemResult!==undefined && (typeof ev.modemResult!=='string'||ev.modemResult.length>100))) return fail(400,'Invalid event data');
    }
    const deployments=table(c,TABLES.deployments);
    await deployments.createTable().catch(e=>{if(errorStatus(e)!==409)throw e;});
    let deployment: (Deployment & {rowKey?:string})|null=null;
    if(device.currentDeploymentId) {
      try {deployment=await deployments.getEntity<Deployment>(serial,device.currentDeploymentId);}catch(e){if(errorStatus(e)!==404)throw e;}
    }
    // GO is idempotent by goId; a retry must never create an additional deployment.
    if(goId && (!deployment || device.lastGoId!==goId)) {
      const lat=device.locationMode==='Manual'?device.manualLatitude:latitude;
      const lng=device.locationMode==='Manual'?device.manualLongitude:longitude;
      const match=isNumber(lat,90)&&isNumber(lng,180)?await resolveLocation(c,device.customerId,lat,lng):null;
      const deploymentId=randomUUID();
      const item={partitionKey:serial,rowKey:deploymentId,customerId:device.customerId,serialNumber:serial,status:'Pending',goId,
        ...(isNumber(lat,90)&&isNumber(lng,180)?{latitude:lat,longitude:lng}:{}),
        ...(match??{}),requestedAt:now()};
      await deployments.createEntity(item);
      deployment=item;
      await devices.updateEntity({partitionKey:'DEVICE',rowKey:serial,currentDeploymentId:deploymentId,lastGoId:goId,
        deploymentState:'Pending',updatedAt:now()},'Merge');
    }
    const eventTable=table(c,TABLES.events);
    await eventTable.createTable().catch(e=>{if(errorStatus(e)!==409)throw e;});
    const acknowledged:string[]=[];
    for(const raw of events) {
      const ev=raw as DeviceEvent;
      // ID uniquely identifies a durable event for a given serial, including retries.
      let newlyStored=true;
      try {
        await eventTable.createEntity({partitionKey:serial,rowKey:ev.eventId,customerId:device.customerId,
          deploymentId:deployment?.rowKey??'',type:ev.type,at:ev.at??'',relatedEventId:ev.relatedEventId??'',
          recipient:ev.recipient?normaliseAUPhone(ev.recipient)!:'',sender:ev.sender?normaliseAUPhone(ev.sender)!:'',
          commandId:ev.commandId??'',modemResult:ev.modemResult??'',receivedAt:now()});
      } catch(e) {if(errorStatus(e)!==409)throw e;newlyStored=false;}
      acknowledged.push(ev.eventId); // only after persisted or confirmed duplicate
      await applyPowerCommandEvent(c,serial,device.customerId,ev);
      if(deployment && newlyStored && (ev.type==='WATER_DETECTED'||ev.type==='WATER_CLEARED') && deployment.configJson) {
        try { const config=JSON.parse(deployment.configJson) as Config;
          if(config.pushEnabled) await sendSimulationPush(c,device.customerId,`${device.displayName} · Sentinel`,
            ev.type==='WATER_DETECTED' ? `Water detected at ${config.farmName} / ${config.bayName}` : `Water cleared at ${config.farmName} / ${config.bayName}`);
        }catch(e){context.error('Push delivery failed; device event already stored',e);}
      }
      if(deployment && ev.type==='WATER_DETECTED') {
        await deployments.updateEntity({partitionKey:serial,rowKey:deployment.rowKey!,currentAlertId:ev.eventId,ackPhone:'',ackAt:'',ackCommandId:'',ackCommandAlertId:''},'Merge');
        deployment.currentAlertId=ev.eventId;deployment.ackPhone='';deployment.ackAt='';deployment.ackCommandId='';deployment.ackCommandAlertId='';
      }
      if(deployment && ev.type==='ALERT_ACKNOWLEDGED' && ev.sender && ev.relatedEventId===deployment.currentAlertId) {
        let allowedSender=false;
        try {const config=JSON.parse(deployment.configJson??'{}') as Config;
          const sender=normaliseAUPhone(ev.sender);
          allowedSender=!!sender && (config.smsRecipients?.some(r=>r.phoneNumber===sender)??false);
        }catch{/* no config */}
        if(allowedSender && !deployment.ackAt) {
          const ackAt=ev.at && !Number.isNaN(Date.parse(ev.at))?ev.at:now();
          await deployments.updateEntity({partitionKey:serial,rowKey:deployment.rowKey!,ackPhone:normaliseAUPhone(ev.sender)!,ackAt},'Merge');
          deployment.ackPhone=normaliseAUPhone(ev.sender)!;deployment.ackAt=ackAt;
        }
      }
      if(deployment && ev.type==='COMMAND_APPLIED' && ev.commandId && deployment.ackCommandId===ev.commandId) {
        await deployments.updateEntity({partitionKey:serial,rowKey:deployment.rowKey!,ackCommandId:'',ackCommandAlertId:''},'Merge');
        deployment.ackCommandId='';deployment.ackCommandAlertId='';
      }
      if(deployment && ev.type==='LOCAL_FALLBACK' && deployment.status==='Pending') {
        await deployments.updateEntity({partitionKey:serial,rowKey:deployment.rowKey!,status:'Fallback'},'Merge');
        deployment.status='Fallback';
      }
    }
    if(deployment && (deployment.status==='Configured'||deployment.status==='Active') &&
       body.configAppliedVersion===deployment.configVersion) {
      if(deployment.status!=='Active') {
        await deployments.updateEntity({partitionKey:serial,rowKey:deployment.rowKey!,status:'Active',configuredAt:now()},'Merge');
        deployment.status='Active';
      }
      await devices.updateEntity({partitionKey:'DEVICE',rowKey:serial,deploymentState:'Monitoring',
        activeFarmId:deployment.farmId??'',activeBayId:deployment.bayId??'',
        ...(isNumber(deployment.latitude,90)&&isNumber(deployment.longitude,180)?{activeLatitude:deployment.latitude,activeLongitude:deployment.longitude}:{}),updatedAt:now()},'Merge');
    }
    await devices.updateEntity({partitionKey:'DEVICE',rowKey:serial,lastSeenAt:now(),
      ...(body.batteryPercent!==undefined?{batteryPercent:body.batteryPercent as number}:{}),
      ...(body.wet!==undefined?{lastWaterState:body.wet as boolean}:{}),updatedAt:now()},'Merge');
    let config: Config|null=null;
    if(deployment?.configJson && ['Configured','Active'].includes(deployment.status))config=JSON.parse(deployment.configJson) as Config;
    const powerCommands=await pendingPowerCommands(c,serial,device.customerId);
    return {status:200,headers:{'Cache-Control':'no-store'},jsonBody:{serverTime:now(),
      acknowledgedEventIds:acknowledged,
      deployment:deployment?{id:deployment.rowKey,status:deployment.status,farmName:deployment.farmName??null,bayName:deployment.bayName??null,
        waitingForConfirmation:deployment.status==='Pending',timeoutSeconds:600}:null,
      configuration:config,
      commands:powerCommands,
      powerSettings: {
        desiredPowerState: device.desiredPowerState === 'OFF' ? 'OFF' : 'ON',
        telemetryIntervalSeconds: typeof device.telemetryIntervalSeconds === 'number' ? device.telemetryIntervalSeconds : 30,
        powerOffCheckIntervalSeconds: typeof device.powerOffCheckIntervalSeconds === 'number' ? device.powerOffCheckIntervalSeconds : 300,
        configurationPollIntervalSeconds: 30
      },
      nextReportSeconds: typeof device.telemetryIntervalSeconds === 'number' ? device.telemetryIntervalSeconds : 30}};
  } catch(e){context.error('Device check-in error',e);return fail(500,'Device check-in failed');}
}

async function customerDeployment(request:HttpRequest,context:InvocationContext):Promise<HttpResponseInit> {
  try {
    const a=await requireAccess(request);if(a.status!==200)return forbidden(a.status);
    const serial=(request.params.serialNumber??'').toUpperCase();
    if(!SERIAL.test(serial))return fail(400,'Invalid serial number');
    const dev=await checkDeviceOwnership(a.connection,serial,a);
    if(!dev)return fail(404,'Assigned BayMonitor not found');
    const devices=table(a.connection,TABLES.devices), deployments=table(a.connection,TABLES.deployments);
    if(!dev.currentDeploymentId)return fail(404,'No GO request received yet');
    const dep=await deployments.getEntity<Deployment>(serial,dev.currentDeploymentId);
    if(request.method==='GET')return {status:200,jsonBody:{deployment:presentDeployment(dep)}};
    const body=await request.json() as Record<string,unknown>;
    if(!body || typeof body!=='object')return fail(400,'Invalid deployment');
    if(body.deploymentId!==dev.currentDeploymentId)return fail(409,'GO deployment has changed; reload the latest request');
    if(dep.status!=='Pending' && dep.status!=='Fallback')return fail(409,'Deployment already confirmed; press GO to start a new deployment');
    const farmId=body.farmId??dep.farmId, bayId=body.bayId??dep.bayId;
    if(typeof farmId!=='string'||!ID.test(farmId)||typeof bayId!=='string'||!ID.test(bayId))return fail(400,'Select a farm and bay before confirming');
    let farm, bay;
    try {farm=await table(a.connection,'SentinelFarms').getEntity(dev.customerId,farmId);
      bay=await table(a.connection,'SentinelBays').getEntity(farmId,bayId);}catch(e){if(errorStatus(e)===404)return fail(404,'Farm or bay not found');throw e;}
    if(bay.customerId!==dev.customerId)return fail(404,'Bay not found for customer');
    const pushEnabled=body.pushEnabled===true, smsEnabled=body.smsEnabled===true;
    const smsRepeatMinutes=body.smsRepeatMinutes===undefined?10:body.smsRepeatMinutes;
    const smsMaxReminders=body.smsMaxReminders===undefined?0:body.smsMaxReminders;
    if(!Number.isInteger(smsRepeatMinutes)||Number(smsRepeatMinutes)<5||Number(smsRepeatMinutes)>60 ||
       !Number.isInteger(smsMaxReminders)||Number(smsMaxReminders)<0||Number(smsMaxReminders)>24)return fail(400,'Invalid SMS reminder settings');
    if(!Array.isArray(body.smsRecipientUserIds)||body.smsRecipientUserIds.length>10 ||
      body.smsRecipientUserIds.some((id:unknown)=>typeof id!=='string'||!OIDish(id)))return fail(400,'Choose up to ten valid users');
    if(smsEnabled && body.smsRecipientUserIds.length===0)return fail(400,'SMS requires at least one recipient');
    const recipients:{userId:string;phoneNumber:string}[]=[];
    for(const userId of [...new Set(body.smsRecipientUserIds as string[])]) {
      let u;
      try {u=(await readUserAccess(a.connection,userId)).user;}catch(e){if(errorStatus(e)===404)return fail(400,'Unknown recipient');throw e;}
      if(u.status!=='Active'||(u.customerId!==dev.customerId && !((u as {role?:string;defaultCustomerId?:string}).role==='SuperAdministrator' && (u as {defaultCustomerId?:string}).defaultCustomerId===dev.customerId)) )return fail(400,'Recipient is not active for this customer');
      const phone=normaliseAUPhone(u.phoneNumber??'');
      if(smsEnabled && !phone)return fail(400,'Every SMS recipient needs a valid Australian mobile');
      if(phone)recipients.push({userId,phoneNumber:phone});
    }
    const version=(dep.configVersion??0)+1;
    const config:Config={deploymentId:dep.rowKey,version,farmId,farmName:String(farm.name),bayId,bayName:String(bay.name),
      pushEnabled,smsEnabled,smsRepeatMinutes:Number(smsRepeatMinutes),smsMaxReminders:Number(smsMaxReminders),smsRecipients:recipients};
    await deployments.updateEntity({partitionKey:serial,rowKey:dep.rowKey,status:'Configured',farmId,farmName:config.farmName,
      bayId,bayName:config.bayName,configVersion:version,configJson:JSON.stringify(config),confirmedAt:now()},'Merge',{etag:dep.etag});
    await devices.updateEntity({partitionKey:'DEVICE',rowKey:serial,deploymentState:'Configured',updatedAt:now()},'Merge');
    return {status:200,jsonBody:{deployment:{...presentDeployment(dep),status:'Configured',configVersion:version,
      preferences:{pushEnabled,smsEnabled,smsRepeatMinutes,smsMaxReminders,smsRecipientUserIds:recipients.map(r=>r.userId)}}}};
  }catch(e){if(errorStatus(e)===412)return fail(409,'Deployment changed; reload before confirming');
    context.error('Deployment configuration failed',e);return fail(500,'Unable to configure deployment');}
}
function OIDish(value:string){return /^[a-fA-F0-9-]{30,40}$/.test(value);}
async function acknowledge(request:HttpRequest,context:InvocationContext):Promise<HttpResponseInit> {
  try {
    const a=await requireAccess(request);if(a.status!==200)return forbidden(a.status);
    const serial=(request.params.serialNumber??'').toUpperCase();
    if(!SERIAL.test(serial))return fail(400,'Invalid serial');
    const dev=await checkDeviceOwnership(a.connection,serial,a);if(!dev)return fail(404,'Device not found');
    if(!dev.currentDeploymentId)return fail(404,'No active deployment');
    const deployments=table(a.connection,TABLES.deployments);
    const d=await deployments.getEntity<Deployment>(serial,dev.currentDeploymentId);
    const body=await request.json() as {alertId?:unknown};
    if(!body || body.alertId!==d.currentAlertId)return fail(409,'Water alert has changed; reload before acknowledging');
    if(!d.currentAlertId)return fail(409,'No active water alert');
    if(d.ackAt)return {status:200,jsonBody:{acknowledged:true,alreadyAcknowledged:true}};
    const ackAt=now(), command=randomUUID();
    await deployments.updateEntity({partitionKey:serial,rowKey:dev.currentDeploymentId,ackAt,ackPhone:'',ackCommandId:command,ackCommandAlertId:d.currentAlertId},'Merge',{etag:d.etag});
    const events=table(a.connection,TABLES.events);
    await events.createTable().catch(e=>{if(errorStatus(e)!==409)throw e;});
    await events.createEntity({partitionKey:serial,rowKey:`cloud-${command}`,customerId:dev.customerId,
      deploymentId:dev.currentDeploymentId,type:'CLOUD_ACKNOWLEDGED',relatedEventId:d.currentAlertId,
      userId:a.userId,receivedAt:ackAt});
    return {status:200,jsonBody:{acknowledged:true,acknowledgedBy:a.userId,pendingDeviceCommand:true}};
  } catch(e){context.error('Cloud acknowledgement failed',e);return fail(500,'Unable to acknowledge water alert');}
}
async function getEvents(request:HttpRequest,context:InvocationContext):Promise<HttpResponseInit>{
  try {const a=await requireAccess(request);if(a.status!==200)return forbidden(a.status);
    const serial=(request.params.serialNumber??'').toUpperCase();if(!SERIAL.test(serial))return fail(400,'Invalid serial');
    const dev=await checkDeviceOwnership(a.connection,serial,a);if(!dev)return fail(404,'Device not found');
    const events=[];
    const t=table(a.connection,TABLES.events);
    for await(const row of t.listEntities({queryOptions:{filter:`PartitionKey eq '${serial}'`}})) {
      if (row.customerId !== dev.customerId) continue;
      events.push({eventId:row.rowKey,type:row.type,at:row.at||row.receivedAt,receivedAt:row.receivedAt,
        sender:row.sender||null,recipient:row.recipient||null,modemResult:row.modemResult||null,relatedEventId:row.relatedEventId||null,userId:row.userId||null});
    }
    events.sort((x,y)=>String(y.receivedAt).localeCompare(String(x.receivedAt)));
    return {status:200,jsonBody:{events:events.slice(0,100)}};
  }catch(e){if(errorStatus(e)===404)return {status:200,jsonBody:{events:[]}};
    context.error('Event history failed',e);return fail(500,'Unable to load event history');}
}
app.http('deviceCredential',{methods:['POST'],authLevel:'anonymous',route:'devices/{serialNumber}/credential',handler:credential});
app.http('deviceCheckin',{methods:['POST'],authLevel:'anonymous',route:'device/v1/{serialNumber}/checkin',handler:deviceCheckin});
app.http('deployment',{methods:['GET','PUT'],authLevel:'anonymous',route:'devices/{serialNumber}/deployment',handler:customerDeployment});
app.http('deploymentAcknowledge',{methods:['POST'],authLevel:'anonymous',route:'devices/{serialNumber}/deployment/acknowledge',handler:acknowledge});
app.http('deviceEvents',{methods:['GET'],authLevel:'anonymous',route:'devices/{serialNumber}/events',handler:getEvents});
