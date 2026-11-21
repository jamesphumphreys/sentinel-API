import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { TableClient } from '@azure/data-tables';
import { requireAccess, canAccessCustomer, forbidden, normaliseAUPhone } from '../access';

type SentinelUser = {
  displayName?: string;
  email?: string;
  role?: string;
  status?: string;
  defaultFarmId?: string;
  defaultCustomerId?: string;
};

type SentinelUserEntity = SentinelUser & {
  etag: string;
  partitionKey?: string;
  rowKey?: string;
  timestamp?: string;
};

const CUSTOMER_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const FARM_ID_PATTERN = /^[A-Za-z0-9-]{1,100}$/;

async function me(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const access = await requireAccess(request);
    if (access.status !== 200) return forbidden(access.status);
    const user = access.user;
    return {
      status: 200,
      jsonBody: {
        authenticated: true,
        userId: access.userId,
        displayName: user.displayName,
        email: user.email,
        role: user.role,
        permissions: access.permissions,
        customerId: user.customerId ?? null,
        phoneNumber: user.phoneNumber ?? null,
        status: user.status,
        defaultFarmId: typeof user.defaultFarmId === 'string' ? user.defaultFarmId : null,
        defaultCustomerId: typeof user.defaultCustomerId === 'string' ? user.defaultCustomerId : null
      }
    };
  } catch (error) {
    context.error('Failed to retrieve Sentinel user', error);
    return { status: 500, jsonBody: { error: 'Unable to verify Sentinel account' } };
  }
}

async function setDefaultFarm(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const access = await requireAccess(request);
    if (access.status !== 200) return forbidden(access.status);



    let body: { customerId?: unknown; farmId?: unknown };
    try { body = await request.json() as typeof body; }
    catch { return { status: 400, jsonBody: { error: 'Invalid JSON' } }; }

    if (!body || typeof body.customerId !== 'string' || !CUSTOMER_ID_PATTERN.test(body.customerId) ||
        typeof body.farmId !== 'string' || !FARM_ID_PATTERN.test(body.farmId))
      return { status: 400, jsonBody: { error: 'Valid customerId and farmId are required' } };
    if (!canAccessCustomer(access, body.customerId)) return forbidden(403);

    const farms = TableClient.fromConnectionString(access.connection, 'SentinelFarms');
    try {
      await farms.getEntity(body.customerId, body.farmId);
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 404)
        return { status: 404, jsonBody: { error: 'Property not found for this customer' } };
      throw error;
    }

    const users = TableClient.fromConnectionString(access.connection, 'SentinelUsers');
    await users.updateEntity({
      partitionKey: 'USER',
      rowKey: access.userId,
      defaultCustomerId: body.customerId,
      defaultFarmId: body.farmId
    }, 'Merge');

    return { status: 200, jsonBody: { defaultCustomerId: body.customerId, defaultFarmId: body.farmId } };
  } catch (error) {
    context.error('Failed to save default property', error);
    return { status: 500, jsonBody: { error: 'Unable to save default property' } };
  }
}

app.http('me', { methods: ['GET'], authLevel: 'anonymous', route: 'me', handler: me });
app.http('meDefaultFarm', { methods: ['PUT'], authLevel: 'anonymous', route: 'me/default-farm', handler: setDefaultFarm });

async function setContact(request:HttpRequest,context:InvocationContext):Promise<HttpResponseInit>{
  try{
    const a=await requireAccess(request);if(a.status!==200)return forbidden(a.status);
    const body=await request.json() as {phoneNumber?:unknown};
    if(!body || typeof body.phoneNumber!=='string' || (body.phoneNumber && !normaliseAUPhone(body.phoneNumber)))
      return {status:400,jsonBody:{error:'Enter a valid Australian mobile or leave blank'}};
    const phoneNumber=body.phoneNumber ? normaliseAUPhone(body.phoneNumber)! : '';
    await TableClient.fromConnectionString(a.connection,'SentinelUsers').updateEntity({partitionKey:'USER',rowKey:a.userId,phoneNumber},'Merge');
    return {status:200,jsonBody:{phoneNumber}};
  }catch(e){context.error('Contact update failed',e);return{status:500,jsonBody:{error:'Unable to update contact number'}};}
}
app.http('meContact',{methods:['PUT'],authLevel:'anonymous',route:'me/contact',handler:setContact});
