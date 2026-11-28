import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { TableClient } from '@azure/data-tables';
import { createPublicKey, randomBytes, createHash, verify, randomUUID } from 'node:crypto';
import { requireAccess, forbidden, errorStatus } from '../access';
import { validateDeviceManifest, ProtocolValidationError } from '../protocol/validation';
import { isEnrollmentAuthorised } from '../provisioning/authorisations';
import { recordVerifiedCandidate, getCandidate, listCandidates, rejectCandidate, restoreCandidate, CandidateConflictError, CandidateStatus } from '../provisioning/candidates';
import { writeProvisioningAudit, ProvisioningAuditEvent } from '../provisioning/audit';

async function audit(connection: string, event: ProvisioningAuditEvent) {
  try { await writeProvisioningAudit(connection, event); return true; }
  catch { console.error('Provisioning audit write failed', event.action, event.serialNumber); return false; }
}


const PK = 'DEVICE';
const fail = (status: number, error: string): HttpResponseInit => ({status, jsonBody: {error}, headers: {'Cache-Control':'no-store'}});
const ok = (status: number, jsonBody: object): HttpResponseInit => ({status, jsonBody, headers: {'Cache-Control':'no-store'}});
const table = (connection: string) => TableClient.fromConnectionString(connection, 'SentinelDeviceProvisioning');
const serialOf = (r: HttpRequest) => (r.params.serialNumber ?? '').toUpperCase();
const valid = (s: string) => /^[0-9A-F]{12}$/.test(s);
type Identity = {publicKey: string; fingerprint: string; status: string; challenge: string; challengeExpiresAt: string; verifiedAt: string; createdAt: string; firmwareVersion: string; manifestJson?: string; isSimulated?: boolean; deviceId?: string; displayName?: string; approvedAt?: string; approvedBy?: string; issuanceUntil?: string; recoveryAuthorizedAt?: string};
async function body(r: HttpRequest): Promise<Record<string, unknown>> {
  const raw = await r.text();
  if (Buffer.byteLength(raw) > 16384) throw new Error('Invalid body');
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
  const manifest = validateDeviceManifest(b);
  const firmwareVersion = manifest.firmwareVersion;
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
    const denied = await enrollmentDenied(connection,serial); if(denied)return denied;
    if(await registryExists(connection,serial))return fail(409,'Identity unavailable');
    const rowKey = `C_${serial}_${fingerprint}`;
    const existing = await t.getEntity<Identity>('CHALLENGE',rowKey).catch(err=>{if(errorStatus(err)===404)return undefined;throw err;});
    if(existing && Date.parse(existing.challengeExpiresAt)>Date.now())return ok(200,{serialNumber:serial,challenge:existing.challenge,expiresAt:existing.challengeExpiresAt});
    const entity={partitionKey:'CHALLENGE',rowKey,publicKey,fingerprint,serialNumber:serial,status:'Challenge',challenge:nonce,challengeExpiresAt:expires,verifiedAt:'',createdAt:now,firmwareVersion,manifestJson:JSON.stringify(manifest)};
    if(existing)await t.updateEntity(entity,'Replace',{etag:existing.etag}); else await t.createEntity(entity);
  }
  return ok(200,{serialNumber:serial,challenge:nonce,expiresAt:expires});
}
async function enrollmentDenied(connection:string,serial:string):Promise<HttpResponseInit|undefined> {
  if(process.env.SENTINEL_ENROLLMENT_ENABLED!=='true')return fail(503,'Enrollment disabled');
  if(!await isEnrollmentAuthorised(connection,serial))return fail(403,'Serial not authorized for enrollment');
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
  if(bound){if(bound.status!=='Approved'||b.fingerprint!==bound.fingerprint||!check(bound))return fail(409,'Challenge unavailable');return issueCredential(serial,bound,t);}
  const denied=await enrollmentDenied(connection,serial);if(denied)return denied;
  if(await registryExists(connection,serial))return fail(409,'Identity unavailable');
  // Require fingerprint to locate a candidate without scanning arbitrary challenges.
  if(typeof b.fingerprint!=='string'||! /^[0-9a-f]{64}$/.test(b.fingerprint))return fail(400,'Fingerprint required for initial proof');
  const rowKey=`C_${serial}_${b.fingerprint}`;
  const e=await t.getEntity<Identity>('CHALLENGE',rowKey);
  if(!check(e))return fail(401,'Invalid or expired proof');
  if (!e.manifestJson) return fail(409,'Fresh manifest challenge required');
  await t.deleteEntity('CHALLENGE',rowKey,{etag:e.etag});
  const status=await recordVerifiedCandidate(connection,{serialNumber:serial,fingerprint:e.fingerprint,publicKey:e.publicKey,manifest:validateDeviceManifest(JSON.parse(e.manifestJson))});
  return ok(200,{serialNumber:serial,status,identityVerified:true});
}
async function list(r:HttpRequest):Promise<HttpResponseInit>{
  const a=await requireAccess(r);if(a.status!==200)return forbidden(a.status);if(!a.isAdmin||!a.permissions.canManageDevices)return forbidden(403);
  const status=r.query.get('status')||'Pending';
  if(!['Pending','Approved','Rejected','Confirmed'].includes(status))return fail(400,'Invalid status');
  return ok(200,await listCandidates(a.connection,status as CandidateStatus,r.query.get('cursor')||undefined));
}
async function approve(r:HttpRequest):Promise<HttpResponseInit>{
  const a=await requireAccess(r);if(a.status!==200)return forbidden(a.status);if(!a.isAdmin||!a.permissions.canManageDevices)return forbidden(403);
  const serial=serialOf(r);if(!valid(serial))return fail(400,'Invalid hardware serial');
  let b:Record<string,unknown>;try{b=await body(r);}catch{return fail(400,'Invalid JSON');}
  if(typeof b.displayName!=='string'||!b.displayName.trim()||b.displayName.trim().length>100)return fail(400,'Display name required');
  if(typeof b.fingerprint!=='string'||! /^[0-9a-f]{64}$/.test(b.fingerprint))return fail(400,'Fingerprint required');
  if(b.isSimulated!==undefined && typeof b.isSimulated!=='boolean')return fail(400,'Invalid simulation flag');
  const denied=await enrollmentDenied(a.connection,serial);if(denied)return denied;
  const t=table(a.connection),e=await getCandidate(a.connection,serial,b.fingerprint);
  if(!e||!e.verifiedAt||!e.manifestJson||!['Pending','Approved'].includes(e.status))return fail(409,'Verified pending identity required');
  const manifest=validateDeviceManifest(JSON.parse(e.manifestJson));
  const bound=await t.getEntity<Identity>(PK,serial).catch(err=>{if(errorStatus(err)===404)return undefined;throw err;});
  if(bound && (bound.fingerprint!==e.fingerprint||bound.status!=='Approved'))return fail(409,'Serial already bound');
  if(await registryExists(a.connection,serial))return fail(409,'Serial already registered');
  const now=new Date().toISOString();
  // Reserve the candidate with an ETag before binding the serial. Retry can finish an interrupted approval.
  if(e.status==='Pending') {
    await t.updateEntity({partitionKey:'CANDIDATE',rowKey:e.rowKey,status:'Approved',approvedAt:now,approvedBy:a.userId,displayName:b.displayName.trim(),isSimulated:b.isSimulated===true,updatedAt:now},'Merge',{etag:e.etag});
  }
  const approved=await t.getEntity<Identity>('CANDIDATE',e.rowKey);
  if(!bound) await t.createEntity({partitionKey:PK,rowKey:serial,publicKey:approved.publicKey,fingerprint:approved.fingerprint,verifiedAt:approved.verifiedAt,createdAt:approved.createdAt,firmwareVersion:manifest.firmwareVersion,manifestJson:approved.manifestJson!,isSimulated:approved.isSimulated===true,status:'Approved',deviceId:randomUUID(),displayName:approved.displayName!,approvedAt:approved.approvedAt!,approvedBy:approved.approvedBy!,challenge:'',challengeExpiresAt:''});
  const auditRecorded=await audit(a.connection,{action:'CANDIDATE_APPROVED',serialNumber:serial,fingerprint:e.fingerprint,actorType:'User',actorId:a.userId,previousStatus:'Pending',newStatus:'Approved'});
  return ok(200,{serialNumber:serial,status:'Approved',auditRecorded});
}
async function decide(r:HttpRequest):Promise<HttpResponseInit>{
  const a=await requireAccess(r);if(a.status!==200)return forbidden(a.status);if(!a.isAdmin||!a.permissions.canManageDevices)return forbidden(403);
  const serial=serialOf(r);if(!valid(serial))return fail(400,'Invalid hardware serial');
  let b:Record<string,unknown>;try{b=await body(r);}catch{return fail(400,'Invalid JSON');}
  if(typeof b.fingerprint!=='string'||! /^[0-9a-f]{64}$/.test(b.fingerprint))return fail(400,'Fingerprint required');
  if(b.reason!==undefined&&(typeof b.reason!=='string'||b.reason.length>1000))return fail(400,'Invalid reason');
  const reject=r.params.decision==='reject';
  if(!reject&&r.params.decision!=='restore')return fail(400,'Invalid decision');
  if(reject)await rejectCandidate(a.connection,serial,b.fingerprint,a.userId,(b.reason as string)||'');
  else await restoreCandidate(a.connection,serial,b.fingerprint,a.userId);
  const status=reject?'Rejected':'Pending';
  const auditRecorded=await audit(a.connection,{action:reject?'CANDIDATE_REJECTED':'CANDIDATE_RESTORED',serialNumber:serial,fingerprint:b.fingerprint,actorType:'User',actorId:a.userId,previousStatus:reject?'Pending':'Rejected',newStatus:status,reason:(b.reason as string)||''});
  return ok(200,{serialNumber:serial,status,auditRecorded});
}

type Registry = {deviceId:string; status:string; customerId:string; deviceKeyHash?:string};
async function issueCredential(serial:string,e:Identity & {etag?:string},t:TableClient):Promise<HttpResponseInit> {
  if(!e.deviceId || !e.displayName || !e.manifestJson) return fail(409,'Approval incomplete');
  const d=TableClient.fromConnectionString(process.env.SENTINEL_STORAGE_CONNECTION!,'SentinelDevices');
  const now=new Date().toISOString();
  // Consume proof before making any registry changes. A lost response can be retried with a fresh proof.
  await t.updateEntity({partitionKey:PK,rowKey:serial,challenge:'',challengeExpiresAt:'',issuanceUntil:new Date(Date.now()+300000).toISOString()},'Merge',{etag:e.etag});
  const manifest=validateDeviceManifest(JSON.parse(e.manifestJson));
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
    await d.createEntity({partitionKey:PK,rowKey:serial,deviceId:e.deviceId,serialNumber:serial,deviceType:manifest.deviceType,manifestJson:e.manifestJson,fingerprint:e.fingerprint,isSimulated:e.isSimulated===true,provisioningStatus:'Approved',allocationStatus:'Inventory',deploymentStatus:'Undeployed',lifecycleStatus:'Active',displayName:e.displayName,status:'Inventory',customerId:'',locationMode:'GPS',deploymentState:'Awaiting',firmwareVersion:e.firmwareVersion,deviceKeyHash,createdAt:now,updatedAt:now});
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
  if(!['Approved','Confirmed'].includes(e.status)) return fail(409,'Identity unavailable');
  const d=await TableClient.fromConnectionString(connection,'SentinelDevices').getEntity<Registry>(PK,serial);
  const hash=createHash('sha256').update(secret).digest('hex');
  if(d.deviceId!==e.deviceId || d.deviceKeyHash!==hash || !['Inventory','Assigned'].includes(d.status)) return fail(401,'Invalid device credential');
  if(e.status==='Approved') await t.updateEntity({partitionKey:PK,rowKey:serial,status:'Confirmed',challenge:'',challengeExpiresAt:'',provisionedAt:new Date().toISOString()},'Merge',{etag:e.etag});
  const registry=TableClient.fromConnectionString(connection,'SentinelDevices');
  await registry.updateEntity({partitionKey:PK,rowKey:serial,provisioningStatus:'Confirmed'},'Merge',{etag:d.etag});
  const candidate=await getCandidate(connection,serial,e.fingerprint);
  if(candidate && candidate.status==='Approved')await t.updateEntity({partitionKey:'CANDIDATE',rowKey:candidate.rowKey,status:'Confirmed',updatedAt:new Date().toISOString()},'Merge',{etag:candidate.etag});
  const auditRecorded=e.status==='Approved'?await audit(connection,{action:'DEVICE_PROVISIONED',serialNumber:serial,fingerprint:e.fingerprint,actorType:'Device',actorId:serial,previousStatus:'Approved',newStatus:'Confirmed'}):true;
  return ok(200,{serialNumber:serial,status:'Confirmed',auditRecorded});
}

function safe(handler:(r:HttpRequest)=>Promise<HttpResponseInit>) {
  return async (r:HttpRequest,c:InvocationContext):Promise<HttpResponseInit>=>{
    try{return await handler(r);}catch(e){if(e instanceof ProtocolValidationError)return fail(400,e.message);if(e instanceof CandidateConflictError)return fail(409,e.message);const s=errorStatus(e);if(s===404)return fail(404,'Identity not found');if(s===409||s===412)return fail(409,'Request conflict; retry');c.error('Provisioning request failed');return fail(500,'Provisioning unavailable');}
  };
}
app.http('provisioningChallenge',{route:'device/v1/{serialNumber}/provisioning/challenge',methods:['POST'],authLevel:'anonymous',handler:safe(challenge)});
app.http('provisioningProof',{route:'device/v1/{serialNumber}/provisioning/proof',methods:['POST'],authLevel:'anonymous',handler:safe(proof)});
app.http('provisioningList',{route:'provisioning/candidates',methods:['GET'],authLevel:'anonymous',handler:safe(list)});

app.http('provisioningApprove',{route:'provisioning/{serialNumber}/approve',methods:['POST'],authLevel:'anonymous',handler:safe(approve)});
app.http('provisioningDecision',{route:'provisioning/{serialNumber}/candidate/{decision}',methods:['POST'],authLevel:'anonymous',handler:safe(decide)});
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
    if(!['Approved','Confirmed','Revoking','Revoked'].includes(e.status))return fail(409,'Identity unavailable');
    await t.updateEntity({partitionKey:PK,rowKey:serial,status:'Revoking',challenge:'',challengeExpiresAt:'',revokedBy:a.userId,revokedAt:now},'Merge',{etag:e.etag});
    e=await t.getEntity<Identity>(PK,serial);
    const current=await d.getEntity<Registry>(PK,serial);
    if(current.deviceId!==e.deviceId)return fail(409,'Registry identity changed');
    await d.updateEntity({partitionKey:PK,rowKey:serial,deviceKeyHash:'',updatedAt:now},'Merge',{etag:current.etag});
    await t.updateEntity({partitionKey:PK,rowKey:serial,status:'Revoked'},'Merge',{etag:e.etag});
    if(action==='revoke'){const auditRecorded=await audit(a.connection,{action:'CREDENTIAL_REVOKED',serialNumber:serial,fingerprint:e.fingerprint,actorType:'User',actorId:a.userId,newStatus:'Revoked'});return ok(200,{serialNumber:serial,status:'Revoked',auditRecorded});}
    e=await t.getEntity<Identity>(PK,serial);
  }
  if(e.status!=='Revoked')return fail(409,'Revoked identity required');
  const latest=await d.getEntity<Registry>(PK,serial);
  if(latest.deviceId!==e.deviceId || latest.deviceKeyHash || !['Inventory','Assigned'].includes(latest.status))return fail(409,'Registry must be active with no credential');
  await t.updateEntity({partitionKey:PK,rowKey:serial,status:'Approved',recoveryAuthorizedAt:now,recoveryAuthorizedBy:a.userId,challenge:'',challengeExpiresAt:''},'Merge',{etag:e.etag});
  const auditRecorded=await audit(a.connection,{action:'CREDENTIAL_ROTATED',serialNumber:serial,fingerprint:e.fingerprint,actorType:'User',actorId:a.userId,previousStatus:'Revoked',newStatus:'Approved',reason:action});
  return ok(200,{serialNumber:serial,status:'Approved',confirmationRequired:true,auditRecorded});
}
app.http('provisioningCredentialManage',{route:'provisioning/{serialNumber}/credential/{action}',methods:['POST'],authLevel:'anonymous',handler:safe(manage)});
