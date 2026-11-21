import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { TableClient } from '@azure/data-tables';
import { randomUUID } from 'node:crypto';
import { requireAccess, canAccessCustomer, forbidden } from '../access';

const CUSTOMER_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const ID_PATTERN = /^[A-Za-z0-9-]{1,100}$/;
type Point = [number, number];
type BayRequest = { customerId?: unknown; farmId?: unknown; name?: unknown; points?: unknown };

function isPoint(value: unknown): value is Point {
  return Array.isArray(value) && value.length === 2 &&
    typeof value[0] === 'number' && Number.isFinite(value[0]) && value[0] >= -90 && value[0] <= 90 &&
    typeof value[1] === 'number' && Number.isFinite(value[1]) && value[1] >= -180 && value[1] <= 180;
}

function validPolygon(points: unknown): points is Point[] {
  return Array.isArray(points) && points.length >= 3 && points.length <= 100 && points.every(isPoint);
}

async function checkFarm(connection: string, customerId: string, farmId: string): Promise<boolean> {
  const farms = TableClient.fromConnectionString(connection, 'SentinelFarms');
  try {
    await farms.getEntity(customerId, farmId);
    return true;
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode === 404) return false;
    throw error;
  }
}

async function listBays(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const access = await requireAccess(request);
    if (access.status !== 200) return { status: access.status, jsonBody: { error: 'Access denied' } };
    const customerId = request.query.get('customerId') || '';
    const farmId = request.query.get('farmId') || '';
    if (!CUSTOMER_ID_PATTERN.test(customerId) || !ID_PATTERN.test(farmId))
      return { status: 400, jsonBody: { error: 'Valid customerId and farmId are required' } };
    if (!canAccessCustomer(access, customerId)) return forbidden(403);
    if (!await checkFarm(access.connection, customerId, farmId))
      return { status: 404, jsonBody: { error: 'Farm not found for this customer' } };
    const table = TableClient.fromConnectionString(access.connection, 'SentinelBays');
    const bays: Array<{ id: string; customerId: string; farmId: string; name: unknown; points: unknown; etag: string | undefined }> = [];
    for await (const entity of table.listEntities({ queryOptions: { filter: `PartitionKey eq '${farmId}'` } })) {
      if (entity.customerId !== customerId) continue;
      let points: unknown;
      try { points = JSON.parse(String(entity.pointsJson)); } catch { points = []; }
      bays.push({ id: entity.rowKey!, customerId, farmId, name: entity.name, points, etag: entity.etag });
    }
    return { status: 200, jsonBody: { bays } };
  } catch (error) {
    context.error('Failed to list bays', error);
    return { status: 500, jsonBody: { error: 'Unable to retrieve bays' } };
  }
}

async function createBay(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const access = await requireAccess(request);
    if (access.status !== 200) return { status: access.status, jsonBody: { error: 'Access denied' } };
    let body: BayRequest;
    try { body = await request.json() as BayRequest; }
    catch { return { status: 400, jsonBody: { error: 'Invalid JSON' } }; }
    if (!body || typeof body.customerId !== 'string' || !CUSTOMER_ID_PATTERN.test(body.customerId) ||
      typeof body.farmId !== 'string' || !ID_PATTERN.test(body.farmId) ||
      typeof body.name !== 'string' || !body.name.trim() || body.name.length > 100 || !validPolygon(body.points))
      return { status: 400, jsonBody: { error: 'Invalid bay details or polygon' } };
    if (!access.isAdmin) return forbidden(403);
    if (!await checkFarm(access.connection, body.customerId, body.farmId))
      return { status: 404, jsonBody: { error: 'Farm not found for this customer' } };
    const table = TableClient.fromConnectionString(access.connection, 'SentinelBays');
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    await table.createEntity({ partitionKey: body.farmId, rowKey: id, customerId: body.customerId,
      name: body.name.trim(), pointsJson: JSON.stringify(body.points), createdAt });
    const saved = await table.getEntity(body.farmId, id);
    return { status: 201, jsonBody: { id, customerId: body.customerId, farmId: body.farmId,
      name: body.name.trim(), points: body.points, createdAt, etag: saved.etag } };
  } catch (error) {
    context.error('Failed to create bay', error);
    return { status: 500, jsonBody: { error: 'Unable to create bay' } };
  }
}

async function modifyBay(request: HttpRequest, context: InvocationContext, deleting: boolean): Promise<HttpResponseInit> {
  try {
    const access = await requireAccess(request);
    if (access.status !== 200) return { status: access.status, jsonBody: { error: 'Access denied' } };
    if (!access.isAdmin) return forbidden(403);
    const customerId = request.query.get('customerId') || '';
    const farmId = request.query.get('farmId') || '';
    const bayId = request.params.bayId || '';
    if (!CUSTOMER_ID_PATTERN.test(customerId) || !ID_PATTERN.test(farmId) || !ID_PATTERN.test(bayId))
      return { status: 400, jsonBody: { error: 'Valid customerId, farmId and bayId are required' } };
    if (!await checkFarm(access.connection, customerId, farmId))
      return { status: 404, jsonBody: { error: 'Farm not found for this customer' } };

    const table = TableClient.fromConnectionString(access.connection, 'SentinelBays');
    let existing;
    try { existing = await table.getEntity(farmId, bayId); }
    catch (error) {
      if ((error as { statusCode?: number }).statusCode === 404)
        return { status: 404, jsonBody: { error: 'Bay not found' } };
      throw error;
    }
    if (existing.customerId !== customerId)
      return { status: 404, jsonBody: { error: 'Bay not found' } };

    // Require the ETag returned by GET/POST so stale edits cannot overwrite newer changes.
    const ifMatch = request.headers.get('if-match');
    if (!ifMatch || ifMatch === '*')
      return { status: 428, jsonBody: { error: 'Supply the bay ETag in the If-Match header' } };
    if (ifMatch !== existing.etag)
      return { status: 412, jsonBody: { error: 'Bay changed elsewhere; reload before editing' } };

    try {
      if (deleting) {
        await table.deleteEntity(farmId, bayId, { etag: ifMatch });
        return { status: 204 };
      }
      let body: BayRequest;
      try { body = await request.json() as BayRequest; }
      catch { return { status: 400, jsonBody: { error: 'Invalid JSON' } }; }
      if (!body || typeof body.name !== 'string' || !body.name.trim() || body.name.length > 100 || !validPolygon(body.points))
        return { status: 400, jsonBody: { error: 'Invalid bay details or polygon' } };
      const updatedAt = new Date().toISOString();
      await table.updateEntity({ partitionKey: farmId, rowKey: bayId,
        name: body.name.trim(), pointsJson: JSON.stringify(body.points), updatedAt }, 'Merge', { etag: ifMatch });
      const updated = await table.getEntity(farmId, bayId);
      return { status: 200, jsonBody: { id: bayId, customerId, farmId, name: updated.name,
        points: JSON.parse(String(updated.pointsJson)), etag: updated.etag } };
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 412)
        return { status: 412, jsonBody: { error: 'Bay changed elsewhere; reload before editing' } };
      if ((error as { statusCode?: number }).statusCode === 404)
        return { status: 404, jsonBody: { error: 'Bay no longer exists' } };
      throw error;
    }
  } catch (error) {
    context.error(deleting ? 'Failed to delete bay' : 'Failed to update bay', error);
    return { status: 500, jsonBody: { error: deleting ? 'Unable to delete bay' : 'Unable to update bay' } };
  }
}

app.http('baysGet', { methods: ['GET'], authLevel: 'anonymous', route: 'bays', handler: listBays });
app.http('baysCreate', { methods: ['POST'], authLevel: 'anonymous', route: 'bays', handler: createBay });
app.http('baysUpdate', { methods: ['PUT'], authLevel: 'anonymous', route: 'bays/{bayId}', handler: (request: HttpRequest, context: InvocationContext) => modifyBay(request, context, false) });
app.http('baysDelete', { methods: ['DELETE'], authLevel: 'anonymous', route: 'bays/{bayId}', handler: (request: HttpRequest, context: InvocationContext) => modifyBay(request, context, true) });
