import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { TableClient } from '@azure/data-tables';
import { requireAccess, canAccessCustomer, forbidden, validCustomerId, validFarmId, errorStatus } from '../access';
type Point=[number,number];
function inside([lat,lng]:Point,polygon:Point[]){let found=false;for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){
  const [yi,xi]=polygon[i], [yj,xj]=polygon[j];if((yi>lat)!==(yj>lat)&&lng<(xj-xi)*(lat-yi)/(yj-yi)+xi)found=!found;
}return found;}
async function handler(req:HttpRequest,ctx:InvocationContext):Promise<HttpResponseInit>{
 try{
  const a=await requireAccess(req);if(a.status!==200)return forbidden(a.status);
  const customerId=req.query.get('customerId')??'',farmId=req.query.get('farmId')??'';
  if(!validCustomerId(customerId)||!validFarmId(farmId))return {status:400,jsonBody:{error:'Customer and farm required'}};
  if(!canAccessCustomer(a,customerId))return forbidden(403);
  const farms=TableClient.fromConnectionString(a.connection,'SentinelFarms');
  try{await farms.getEntity(customerId,farmId)}catch(e){if(errorStatus(e)===404)return {status:404,jsonBody:{error:'Farm not found'}};throw e;}
  const polys:Point[][]=[];
  for await(const bay of TableClient.fromConnectionString(a.connection,'SentinelBays').listEntities({queryOptions:{filter:`PartitionKey eq '${farmId}'`}})){
    if(bay.customerId!==customerId)continue;
    try{const points=JSON.parse(String(bay.pointsJson));if(Array.isArray(points)&&points.length>=3)polys.push(points as Point[])}catch{/* skip */}
  }
  const devices:Record<string,unknown>[]=[];
  // Simulations are read-only customer dashboard data, never used as hardware credentials.
  try{
   for await(const row of TableClient.fromConnectionString(a.connection,'SentinelSimulations').listEntities({queryOptions:{filter:"PartitionKey eq 'SIM'"}})){
    if(row.customerId!==customerId || typeof row.latitude!=='number'||typeof row.longitude!=='number')continue;
    if(!polys.some(p=>inside([row.latitude as number,row.longitude as number],p)))continue;
    devices.push({id:row.rowKey,name:row.name,customerId,wet:row.wet,batteryPercent:row.batteryPercent,
     latitude:row.latitude,longitude:row.longitude,state:row.state,lastReport:row.lastReport,simulated:true});
   }
  }catch(e){if(errorStatus(e)!==404)throw e;}
  for await(const row of TableClient.fromConnectionString(a.connection,'SentinelDevices').listEntities({queryOptions:{filter:"PartitionKey eq 'DEVICE'"}})){
    if(row.customerId!==customerId||row.status!=='Assigned'||row.deviceType!=='BayMonitor'||row.activeFarmId!==farmId)continue;
    devices.push({id:row.serialNumber,name:row.displayName,customerId,wet:row.lastWaterState??false,batteryPercent:row.batteryPercent??null,
      latitude:row.activeLatitude,longitude:row.activeLongitude,state:row.deploymentState==='Monitoring'?'Monitoring':'Awaiting',
      lastReport:row.lastSeenAt??'',simulated:false});
  }
  return{status:200,jsonBody:{devices}};
 }catch(e){ctx.error('Monitoring error',e);return{status:500,jsonBody:{error:'Unable to retrieve monitor status'}};}
}
app.http('monitoring',{methods:['GET'],authLevel:'anonymous',route:'monitoring',handler});
