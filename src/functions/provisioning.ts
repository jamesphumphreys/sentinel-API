import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { TableClient } from '@azure/data-tables';
import { createPublicKey, randomBytes, createHash, verify, randomUUID } from 'node:crypto';
import { requireAccess, forbidden, errorStatus } from '../access';

const PK = 'DEVICE';
const fail = (status: number, error: string): HttpResponseInit => ({status, jsonBody: {error}, headers: {'Cache-Control':'no-store'}});
const ok = (status: number, jsonBody: object): HttpResponseInit => ({status, jsonBody, headers: {'Cache-Control':'no-store'}});
const table = (connection: string) => TableClient.fromConnectionString(connection, 'SentinelDeviceProvisioning');
const serialOf = (r: HttpRequest) => (r.params.serialNumber ?? '').toUpperCase();
const valid = (s: string) => /^[0-9A-F]{12}$/.test(s);
type Identity = {publicKey: string; fingerprint: string; status: string; challenge: string; challengeExpiresAt: string; verifiedAt: string; createdAt: string; firmwareVersion: string; deviceId?: string; displayName?: string; approvedAt?: string; approvedBy?: string; issuanceUntil?: string; recoveryAuthorizedAt?: string};
async function body(r: HttpRequest): Promise<Record<string, unknown>> {
  const raw = await r.text();
  if (Buffer.byteLength(raw) > 4096) throw new Error('Invalid body');
  const b = JSON.parse(raw);
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error('Invalid body');
  return b;
}
async function challenge(r: HttpRequest): Promise<HttpResponseInit> {
  const serial = serialOf(r);
  if (!valid(serial)) return fail(400, 'Invalid hardware serial');
  let b: Record<string, unknown>, publicKey: string;
  try {
    b = await body(r);
    if (typeof b.publicKey !== 'string' || b.publicKey.length > 1024) throw new Error();
    const key = createPublicKey({key: Buffer.from(b.publicKey, 'base64'), format:'der', type:'spki'});
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error();
    publicKey = key.export({format:'der', type:'spki'}).toString('base64');
  } catch { return fail(400, 'P-256 SPKI public key required'); }
  const firmwareVersion = typeof b.firmwareVersion === 'string' ? b.firmwareVersion.slice(0,100) : '';
  const connection = process.env.SENTINEL_STORAGE_CONNECTION!;
  const t = table(connection);
  const fingerprint = createHash('sha256').update(Buffer.from(publicKey,'base64')).digest('hex');
  const nonce = randomBytes(32).toString('hex');
  const now = new Date().toISOString();
  const expires = new Date(Date.now()+300000).toISOString();
  const e = await t.getEntity<Identity>(PK,serial).catch(err=>{if(errorStatus(err)===404)return undefined;throw err;});
  if(e) {
    if(e.status !== 'Approved' || e.publicKey !== publicKey) return fail(409,'Identity unavailable');
    if(Date.parse(e.issuanceUntil||'')>Date.now()) return fail(409,'Issuance in progress');
    if(Date.parse(e.challengeExpiresAt)>Date.now()) return ok(200,{serialNumber:serial,challenge:e.challenge,expiresAt:e.challengeExpiresAt});
    await t.updateEntity({partitionKey:PK,rowKey:serial,challenge:nonce,challengeExpiresAt:expires},'Merge',{etag:e.etag});
  } else {
    const denied = enrollmentDenied(serial); if(denied)return denied;
    if(await registryExists(connection,serial))return fail(409,'Identity unavailable');
    const rowKey = `C_${serial}_${fingerprint}`;
    const existing = await t.getEntity<Identity>('CHALLENGE',rowKey).catch(err=>{if(errorStatus(err)===404)return undefined;throw err;});
    if(existing && Date.parse(existing.challengeExpiresAt)>Date.now())return ok(200,{serialNumber:serial,challenge:existing.challenge,expiresAt:existing.challengeExpiresAt});
    const entity={partitionKey:'CHALLENGE',rowKey,publicKey,fingerprint,serialNumber:serial,status:'Challenge',challenge:nonce,challengeExpiresAt:expires,verifiedAt:'',createdAt:now,firmwareVersion};
    if(existing)await t.updateEntity(entity,'Replace',{etag:existing.etag}); else await t.createEntity(entity);
  }
  return ok(200,{serialNumber:serial,challenge:nonce,expiresAt:expires});
}
function enrollmentDenied(serial:string):HttpResponseInit|undefined {
  if(process.env.SENTINEL_ENROLLMENT_ENABLED!=='true')return fail(503,'Enrollment disabled');
  if(!(process.env.SENTINEL_ENROLLMENT_ALLOWLIST??'').split(',').map(v=>v.trim().toUpperCase()).includes(serial))return fail(403,'Serial not authorized for enrollment');
}
async function registryExists(connection:string,serial:string):Promise<boolean>{
  try {await TableClient.fromConnectionString(connection,'SentinelDevices').getEntity(PK,serial);return true;}
  catch(e){if(errorStatus(e)===404)return false;throw e;}
}
async function proof(r:HttpRequest):Promise<HttpResponseInit>{
  const serial=serialOf(r); if(!valid(serial))return fail(400,'Invalid hardware serial');
  let b:Record<string,unknown>;try{b=await body(r);}catch{return fail(400,'Invalid JSON');}
  if(typeof b.signature!=='string'||b.signature.length>256||typeof b.challenge!=='string'||! /^[0-9a-f]{64}$/.test(b.challenge))return fail(400,'Invalid proof');
  const connection=process.env.SENTINEL_STORAGE_CONNECTION!,t=table(connection);
  const bound=await t.getEntity<Identity>(PK,serial).catch(err=>{if(errorStatus(err)===404)return undefined;throw err;});
  const check=(e:Identity)=>e.challenge===b.challenge&&Date.parse(e.challengeExpiresAt)>Date.now()&&verify('sha256',Buffer.from(`SENTINEL-PROVISION-V1\n${serial}\n${e.challenge}`),createPublicKey({key:Buffer.from(e.publicKey,'base64'),format:'der',type:'spki'}),Buffer.from(b.signature as string,'base64'));
  if(bound){if(bound.status!=='Approved'||!check(bound))return fail(409,'Challenge unavailable');return issueCredential(serial,bound,t);}
  const denied=enrollmentDenied(serial);if(denied)return denied;
  if(await registryExists(connection,serial))return fail(409,'Identity unavailable');
  // Require fingerprint to locate a candidate without scanning arbitrary challenges.
  if(typeof b.fingerprint!=='string'||! /^[0-9a-f]{64}$/.test(b.fingerprint))return fail(400,'Fingerprint required for initial proof');
  const rowKey=`C_${serial}_${b.fingerprint}`;
  const e=await t.getEntity<Identity>('CHALLENGE',rowKey);
  if(!check(e))return fail(401,'Invalid or expired proof');
  const candidate={partitionKey:'CANDIDATE',rowKey,serialNumber:serial,publicKey:e.publicKey,fingerprint:e.fingerprint,status:'Pending',challenge:'',challengeExpiresAt:'',verifiedAt:new Date().toISOString(),createdAt:e.createdAt,firmwareVersion:e.firmwareVersion};
  await t.deleteEntity('CHALLENGE',rowKey,{etag:e.etag});
  await t.upsertEntity(candidate,'Replace');
  return ok(200,{serialNumber:serial,status:'Pending',identityVerified:true});
}
async function list(r:HttpRequest):Promise<HttpResponseInit>{
  const a=await requireAccess(r);if(a.status!==200)return forbidden(a.status);if(!a.isAdmin||!a.permissions.canManageDevices)return forbidden(403);
  const t=table(a.connection),items=[];
  const page=await t.listEntities<Identity & {serialNumber:string}>({queryOptions:{filter:"PartitionKey eq 'CANDIDATE'"}}).byPage({maxPageSize:100,continuationToken:r.query.get('cursor')||undefined}).next();
  if(!page.done)for(const e of page.value){if(await t.getEntity(PK,e.serialNumber).catch(err=>{if(errorStatus(err)===404)return undefined;throw err;}))continue;items.push({serialNumber:e.serialNumber,fingerprint:e.fingerprint,createdAt:e.createdAt,firmwareVersion:e.firmwareVersion,identityVerified:true,verifiedAt:e.verifiedAt,status:'Pending'});}
  return ok(200,{items,nextCursor:page.done?null:page.value.continuationToken??null});
}
async function approve(r:HttpRequest):Promise<HttpResponseInit>{
  const a=await requireAccess(r);if(a.status!==200)return forbidden(a.status);if(!a.isAdmin||!a.permissions.canManageDevices)return forbidden(403);
  const serial=serialOf(r);if(!valid(serial))return fail(400,'Invalid hardware serial');
  let b:Record<string,unknown>;try{b=await body(r);}catch{return fail(400,'Invalid JSON');}
  if(typeof b.displayName!=='string'||!b.displayName.trim()||b.displayName.trim().length>100)return fail(400,'Display name required');
  if(typeof b.fingerprint!=='string'||! /^[0-9a-f]{64}$/.test(b.fingerprint))return fail(400,'Fingerprint required');
  const denied=enrollmentDenied(serial);if(denied)return denied;
  const t=table(a.connection),e=await t.getEntity<Identity>('CANDIDATE',`C_${serial}_${b.fingerprint}`);
  if(!e.verifiedAt||e.fingerprint!==b.fingerprint)return fail(409,'Verified pending identity required');
  if(await registryExists(a.connection,serial))return fail(409,'Serial already registered');
  await t.createEntity({partitionKey:PK,rowKey:serial,publicKey:e.publicKey,fingerprint:e.fingerprint,verifiedAt:e.verifiedAt,createdAt:e.createdAt,firmwareVersion:e.firmwareVersion,status:'Approved',deviceId:randomUUID(),displayName:b.displayName.trim(),approvedAt:new Date().toISOString(),approvedBy:a.userId,challenge:'',challengeExpiresAt:''});
  return ok(200,{serialNumber:serial,status:'Approved'});
}
type Registry = {deviceId:string; status:string; customerId:string; deviceKeyHash?:string};
async function issueCredential(serial:string,e:Identity & {etag?:string},t:TableClient):Promise<HttpResponseInit> {
  if(!e.deviceId || !e.displayName) return fail(409,'Approval incomplete');
  const d=TableClient.fromConnectionString(process.env.SENTINEL_STORAGE_CONNECTION!,'SentinelDevices');
  const now=new Date().toISOString();
  // Consume proof before making any registry changes. A lost response can be retried with a fresh proof.
  await t.updateEntity({partitionKey:PK,rowKey:serial,challenge:'',challengeExpiresAt:'',issuanceUntil:new Date(Date.now()+300000).toISOString()},'Merge',{etag:e.etag});
  const secret=randomBytes(32).toString('base64url');
  const deviceKeyHash=createHash('sha256').update(secret).digest('hex');
  let existing;
  try { existing=await d.getEntity<Registry>(PK,serial); }
  catch(err) { if(errorStatus(err)!==404) throw err; }
  if(existing) {
    if(existing.deviceId!==e.deviceId || !['Inventory','Assigned'].includes(existing.status)) return fail(409,'Registry identity unavailable');
    await d.updateEntity({partitionKey:PK,rowKey:serial,deviceKeyHash,updatedAt:now},'Merge',{etag:existing.etag});
  } else {
    if(e.recoveryAuthorizedAt) return fail(409,'Registry identity unavailable');
    await d.createEntity({partitionKey:PK,rowKey:serial,deviceId:e.deviceId,serialNumber:serial,deviceType:'BayMonitor',displayName:e.displayName,status:'Inventory',customerId:'',locationMode:'GPS',deploymentState:'Awaiting',firmwareVersion:e.firmwareVersion,deviceKeyHash,createdAt:now,updatedAt:now});
  }
  const locked=await t.getEntity<Identity>(PK,serial);
  await t.updateEntity({partitionKey:PK,rowKey:serial,issuanceUntil:''},'Merge',{etag:locked.etag});
  return ok(200,{serialNumber:serial,status:'Approved',deviceKey:secret,confirmationRequired:true});
}
async function confirm(r:HttpRequest):Promise<HttpResponseInit> {
  const serial=serialOf(r);
  if(!valid(serial)) return fail(400,'Invalid hardware serial');
  const secret=r.headers.get('x-sentinel-device-key');
  if(!secret || secret.length>200) return fail(401,'Device credential required');
  const connection=process.env.SENTINEL_STORAGE_CONNECTION!, t=table(connection);
  const e=await t.getEntity<Identity>(PK,serial);
  if(Date.parse(e.issuanceUntil||'')>Date.now()) return fail(409,'Issuance in progress');
  if(!['Approved','Provisioned'].includes(e.status)) return fail(409,'Identity unavailable');
  const d=await TableClient.fromConnectionString(connection,'SentinelDevices').getEntity<Registry>(PK,serial);
  const hash=createHash('sha256').update(secret).digest('hex');
  if(d.deviceId!==e.deviceId || d.deviceKeyHash!==hash || !['Inventory','Assigned'].includes(d.status)) return fail(401,'Invalid device credential');
  if(e.status==='Approved') await t.updateEntity({partitionKey:PK,rowKey:serial,status:'Provisioned',challenge:'',challengeExpiresAt:'',provisionedAt:new Date().toISOString()},'Merge',{etag:e.etag});
  return ok(200,{serialNumber:serial,status:'Provisioned'});
}

function safe(handler:(r:HttpRequest)=>Promise<HttpResponseInit>) {
  return async (r:HttpRequest,c:InvocationContext):Promise<HttpResponseInit>=>{
    try{return await handler(r);}catch(e){const s=errorStatus(e);if(s===404)return fail(404,'Identity not found');if(s===409||s===412)return fail(409,'Request conflict; retry');c.error('Provisioning request failed');return fail(500,'Provisioning unavailable');}
  };
}
app.http('provisioningChallenge',{route:'device/v1/{serialNumber}/provisioning/challenge',methods:['POST'],authLevel:'anonymous',handler:safe(challenge)});
app.http('provisioningProof',{route:'device/v1/{serialNumber}/provisioning/proof',methods:['POST'],authLevel:'anonymous',handler:safe(proof)});
app.http('provisioningList',{route:'provisioning/pending',methods:['GET'],authLevel:'anonymous',handler:safe(list)});

app.http('provisioningApprove',{route:'provisioning/{serialNumber}/approve',methods:['POST'],authLevel:'anonymous',handler:safe(approve)});
app.http('provisioningConfirm',{route:'device/v1/{serialNumber}/provisioning/confirm',methods:['POST'],authLevel:'anonymous',handler:safe(confirm)});

// Revocation is fail-closed: block issuance first, then clear the registry hash.
// A failed second write can be retried by invoking revoke again.
async function manage(r:HttpRequest):Promise<HttpResponseInit> {
  const a=await requireAccess(r);
  if(a.status!==200)return forbidden(a.status);
  if(!a.isAdmin || !a.permissions.canManageDevices)return forbidden(403);
  const serial=serialOf(r), action=r.params.action;
  if(!valid(serial))return fail(400,'Invalid hardware serial');
  if(!['revoke','reissue','rotate'].includes(action??''))return fail(400,'Invalid credential action');
  const t=table(a.connection), d=TableClient.fromConnectionString(a.connection,'SentinelDevices');
  let e=await t.getEntity<Identity>(PK,serial);
  if(Date.parse(e.issuanceUntil||'')>Date.now())return fail(409,'Issuance in progress');
  const dev=await d.getEntity<Registry>(PK,serial);
  if(!e.verifiedAt || !e.deviceId || dev.deviceId!==e.deviceId || !['Inventory','Assigned'].includes(dev.status))return fail(409,'Registry identity unavailable');
  const now=new Date().toISOString();
  if(action==='revoke' || action==='rotate') {
    if(!['Approved','Provisioned','Revoking','Revoked'].includes(e.status))return fail(409,'Identity unavailable');
    await t.updateEntity({partitionKey:PK,rowKey:serial,status:'Revoking',challenge:'',challengeExpiresAt:'',revokedBy:a.userId,revokedAt:now},'Merge',{etag:e.etag});
    e=await t.getEntity<Identity>(PK,serial);
    const current=await d.getEntity<Registry>(PK,serial);
    if(current.deviceId!==e.deviceId)return fail(409,'Registry identity changed');
    await d.updateEntity({partitionKey:PK,rowKey:serial,deviceKeyHash:'',updatedAt:now},'Merge',{etag:current.etag});
    await t.updateEntity({partitionKey:PK,rowKey:serial,status:'Revoked'},'Merge',{etag:e.etag});
    if(action==='revoke')return ok(200,{serialNumber:serial,status:'Revoked'});
    e=await t.getEntity<Identity>(PK,serial);
  }
  if(e.status!=='Revoked')return fail(409,'Revoked identity required');
  const latest=await d.getEntity<Registry>(PK,serial);
  if(latest.deviceId!==e.deviceId || latest.deviceKeyHash || !['Inventory','Assigned'].includes(latest.status))return fail(409,'Registry must be active with no credential');
  await t.updateEntity({partitionKey:PK,rowKey:serial,status:'Approved',recoveryAuthorizedAt:now,recoveryAuthorizedBy:a.userId,challenge:'',challengeExpiresAt:''},'Merge',{etag:e.etag});
  return ok(200,{serialNumber:serial,status:'Approved',confirmationRequired:true});
}
app.http('provisioningCredentialManage',{route:'provisioning/{serialNumber}/credential/{action}',methods:['POST'],authLevel:'anonymous',handler:safe(manage)});
