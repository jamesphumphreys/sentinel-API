import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { TableClient } from '@azure/data-tables';
import { randomUUID } from 'node:crypto';
import { requireAccess, forbidden } from '../access';

const TABLE = 'SentinelDevices';
const SERIAL = /^[A-Za-z0-9._-]{1,100}$/;
const CUSTOMER = /^[A-Za-z0-9-]{1,64}$/;
const TYPES = ['BayMonitor', 'PumpMonitor'] as const;
const HARDWARE_FIELDS = ['imei', 'simIccid', 'simCarrier', 'simPhoneNumber', 'modemModel', 'firmwareVersion'] as const;
const STATUSES = ['Inventory', 'Assigned', 'Suspended', 'Retired'] as const;
type DeviceType = typeof TYPES[number];
type Status = typeof STATUSES[number];
type Device = {
  deviceId: string; serialNumber: string; deviceType: DeviceType; displayName: string;
  status: Status; customerId: string; locationMode?: string;
  manualLatitude?: number; manualLongitude?: number;
  deploymentState?: string; activeLatitude?: number; activeLongitude?: number;
  deviceKeyHash?: string; currentDeploymentId?: string; lastGoId?: string; lastSeenAt?: string;
  activeFarmId?: string; activeBayId?: string; batteryPercent?: number; lastWaterState?: boolean;
  imei?: string; simIccid?: string; simCarrier?: string; simPhoneNumber?: string; modemModel?: string; firmwareVersion?: string;
  desiredPowerState?: string; telemetryIntervalSeconds?: number; powerOffCheckIntervalSeconds?: number;
  createdAt: string; updatedAt: string;
};
type Body = { serialNumber?: unknown; deviceType?: unknown; displayName?: unknown;
  status?: unknown; customerId?: unknown; locationMode?: unknown;
  manualLatitude?: unknown; manualLongitude?: unknown;
  imei?: unknown; simIccid?: unknown; simCarrier?: unknown; simPhoneNumber?: unknown; modemModel?: unknown; firmwareVersion?: unknown };
const errorStatus = (error: unknown) => (error as { statusCode?: number }).statusCode;
const isType = (value: unknown): value is DeviceType => TYPES.some(v => v === value);
const isStatus = (value: unknown): value is Status => STATUSES.some(v => v === value);
const validCoordinate = (value: unknown, limit: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit;

function present(entity: Device & { etag?: string }) {
  return {
    id: entity.deviceId, serialNumber: entity.serialNumber, deviceType: entity.deviceType,
    displayName: entity.displayName, status: entity.status, customerId: entity.customerId || null,
    locationMode: entity.locationMode === 'Manual' ? 'Manual' : 'GPS',
    manualLatitude: typeof entity.manualLatitude === 'number' ? entity.manualLatitude : null,
    manualLongitude: typeof entity.manualLongitude === 'number' ? entity.manualLongitude : null,
    deploymentState: entity.deploymentState || 'Awaiting',
    activeLatitude: typeof entity.activeLatitude === 'number' ? entity.activeLatitude : null,
    activeLongitude: typeof entity.activeLongitude === 'number' ? entity.activeLongitude : null,
    ...Object.fromEntries(HARDWARE_FIELDS.map(field => [field, entity[field] || null])),
    powerSettings: {desiredPowerState: entity.desiredPowerState === "OFF" ? "OFF" : "ON", telemetryIntervalSeconds: entity.telemetryIntervalSeconds ?? 30, powerOffCheckIntervalSeconds: entity.powerOffCheckIntervalSeconds ?? 300},
    createdAt: entity.createdAt, updatedAt: entity.updatedAt, etag: entity.etag
  };
}

async function checkCustomer(connection: string, customerId: string): Promise<string | null> {
  if (!customerId) return null;
  if (!CUSTOMER.test(customerId)) return 'Invalid customer ID';
  const customers = TableClient.fromConnectionString(connection, 'SentinelCustomers');
  try {
    const customer = await customers.getEntity<{ status: string }>('CUSTOMER', customerId);
    return customer.status === 'Active' ? null : 'Customer is not active';
  } catch (error) {
    if (errorStatus(error) === 404) return 'Customer does not exist';
    throw error;
  }
}

function validateBody(body: Body, creating: boolean): string | null {
  if (!body || typeof body.displayName !== 'string' || !body.displayName.trim() || body.displayName.trim().length > 100)
    return 'Display name is required (maximum 100 characters)';
  if (creating && (typeof body.serialNumber !== 'string' || !SERIAL.test(body.serialNumber.trim()) || !isType(body.deviceType)))
    return 'Valid serial number and device type are required';
  if (!creating && (body.serialNumber !== undefined || body.deviceType !== undefined))
    return 'Serial number and device type cannot be changed';
  if (typeof body.customerId !== 'string' || (body.customerId !== '' && !CUSTOMER.test(body.customerId)))
    return 'Invalid customer ID';
  if (body.locationMode !== 'GPS' && body.locationMode !== 'Manual') return 'Choose GPS or Manual location';
  if (body.locationMode === 'Manual' &&
    (!validCoordinate(body.manualLatitude, 90) || !validCoordinate(body.manualLongitude, 180)))
    return 'A manual location requires valid latitude and longitude';
  if (body.locationMode === 'GPS' && (body.manualLatitude != null || body.manualLongitude != null))
    return 'Clear manual coordinates when using GPS';
  for (const field of HARDWARE_FIELDS) {
    const value = body[field];
    if (value !== undefined && (typeof value !== 'string' || value.length > 100)) return `Invalid ${field}`;
  }
  if (typeof body.imei === 'string' && body.imei && !/^\d{15}$/.test(body.imei)) return 'IMEI must contain 15 digits';
  if (typeof body.simIccid === 'string' && body.simIccid && !/^\d{18,22}$/.test(body.simIccid)) return 'SIM ICCID must contain 18–22 digits';
  if (!creating && !isStatus(body.status)) return 'Invalid lifecycle status';
  if (body.status === 'Assigned' && !body.customerId) return 'Assigned devices require a customer';
  if (body.status === 'Inventory' && body.customerId) return 'Inventory devices cannot have a customer';
  return null;
}

async function listDevices(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const access = await requireAccess(request);
    if (access.status !== 200) return { status: access.status, jsonBody: { error: 'Access denied' } };
    const table = TableClient.fromConnectionString(access.connection, TABLE);
    const devices = [];
    for await (const entity of table.listEntities<Device>()) {
      if (!access.isAdmin && entity.customerId !== access.user.customerId) continue;
      const value = present(entity);
      if (!access.isAdmin) {
        for (const field of HARDWARE_FIELDS) delete (value as Record<string,unknown>)[field];
      }
      devices.push(value);
    }
    devices.sort((a, b) => a.serialNumber.localeCompare(b.serialNumber));
    return { status: 200, jsonBody: { devices } };
  } catch (error) {
    context.error('Unable to list devices', error);
    return { status: 500, jsonBody: { error: 'Unable to retrieve devices' } };
  }
}

async function createDevice(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const access = await requireAccess(request);
    if (access.status !== 200) return { status: access.status, jsonBody: { error: 'Access denied' } };
    if (!access.isAdmin) return forbidden(403);
    let body: Body;
    try { body = await request.json() as Body; } catch { return { status: 400, jsonBody: { error: 'Invalid JSON' } }; }
    const validation = validateBody(body, true);
    if (validation) return { status: 400, jsonBody: { error: validation } };
    const customerId = body.customerId as string;
    const customerError = await checkCustomer(access.connection, customerId);
    if (customerError) return { status: 400, jsonBody: { error: customerError } };
    const serial = (body.serialNumber as string).trim().toUpperCase();
    const now = new Date().toISOString();
    const table = TableClient.fromConnectionString(access.connection, TABLE);
    try {
      await table.createEntity({ partitionKey: 'DEVICE', rowKey: serial, deviceId: randomUUID(),
        serialNumber: serial, deviceType: body.deviceType as DeviceType,
        displayName: (body.displayName as string).trim(), status: customerId ? 'Assigned' : 'Inventory',
        customerId, locationMode: body.locationMode as string,
        ...(body.locationMode === 'Manual' ? { manualLatitude: body.manualLatitude as number, manualLongitude: body.manualLongitude as number } : {}),
        ...Object.fromEntries(HARDWARE_FIELDS.filter(field => typeof body[field] === 'string' && body[field]).map(field => [field, (body[field] as string).trim()])),
        deploymentState: 'Awaiting', createdAt: now, updatedAt: now });
    } catch (error) {
      if (errorStatus(error) === 409) return { status: 409, jsonBody: { error: 'Serial number already registered' } };
      throw error;
    }
    const saved = await table.getEntity<Device>('DEVICE', serial);
    return { status: 201, jsonBody: present(saved) };
  } catch (error) {
    context.error('Unable to register device', error);
    return { status: 500, jsonBody: { error: 'Unable to register device' } };
  }
}

async function updateDevice(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const access = await requireAccess(request);
    if (access.status !== 200) return { status: access.status, jsonBody: { error: 'Access denied' } };
    if (!access.isAdmin) return forbidden(403);
    const serial = (request.params.serialNumber || '').toUpperCase();
    if (!SERIAL.test(serial)) return { status: 400, jsonBody: { error: 'Invalid serial number' } };
    const table = TableClient.fromConnectionString(access.connection, TABLE);
    let existing;
    try { existing = await table.getEntity<Device>('DEVICE', serial); }
    catch (error) { if (errorStatus(error) === 404) return { status: 404, jsonBody: { error: 'Device not found' } }; throw error; }
    const etag = request.headers.get('if-match');
    if (!etag || etag === '*') return { status: 428, jsonBody: { error: 'Supply the device ETag in If-Match' } };
    if (etag !== existing.etag) return { status: 412, jsonBody: { error: 'Device changed elsewhere; reload first' } };
    if (existing.status === 'Retired') return { status: 409, jsonBody: { error: 'Retired devices cannot be modified' } };
    let body: Body;
    try { body = await request.json() as Body; } catch { return { status: 400, jsonBody: { error: 'Invalid JSON' } }; }
    const validation = validateBody(body, false);
    if (validation) return { status: 400, jsonBody: { error: validation } };
    const customerId = body.customerId as string;
    const customerError = await checkCustomer(access.connection, customerId);
    if (customerError) return { status: 400, jsonBody: { error: customerError } };
    // Existing records may contain farmId/bayId from the first prototype. Clear these legacy assignments.
    // Replace is deliberate: preserve immutable identity and deployment fields, omit legacy assignment fields.
    const updated: Device & { partitionKey: string; rowKey: string } = {
      partitionKey: 'DEVICE', rowKey: serial, deviceId: existing.deviceId,
      serialNumber: existing.serialNumber, deviceType: existing.deviceType,
      displayName: (body.displayName as string).trim(), status: body.status as Status, customerId,
      locationMode: body.locationMode as string,
      ...(body.locationMode === 'Manual' ? { manualLatitude: body.manualLatitude as number, manualLongitude: body.manualLongitude as number } : {}),
      ...Object.fromEntries(HARDWARE_FIELDS.filter(field => typeof body[field] === 'string' && body[field]).map(field => [field, (body[field] as string).trim()])),
      deploymentState: existing.customerId === customerId ? (existing.deploymentState || 'Awaiting') : 'Awaiting',
      ...(existing.customerId === customerId ? {
        ...(existing.deviceKeyHash ? {deviceKeyHash:existing.deviceKeyHash}:{}),
        ...(existing.desiredPowerState ? {desiredPowerState:existing.desiredPowerState}:{}),
        ...(typeof existing.telemetryIntervalSeconds === "number" ? {telemetryIntervalSeconds:existing.telemetryIntervalSeconds}:{}),
        ...(typeof existing.powerOffCheckIntervalSeconds === "number" ? {powerOffCheckIntervalSeconds:existing.powerOffCheckIntervalSeconds}:{}),
        ...(existing.currentDeploymentId ? {currentDeploymentId:existing.currentDeploymentId}:{}),
        ...(existing.lastGoId ? {lastGoId:existing.lastGoId}:{}),
        ...(existing.lastSeenAt ? {lastSeenAt:existing.lastSeenAt}:{}),
        ...(existing.activeFarmId ? {activeFarmId:existing.activeFarmId}:{}),
        ...(existing.activeBayId ? {activeBayId:existing.activeBayId}:{}),
        ...(typeof existing.batteryPercent==='number' ? {batteryPercent:existing.batteryPercent}:{}),
        ...(typeof existing.lastWaterState==='boolean' ? {lastWaterState:existing.lastWaterState}:{}),
      } : {}),
      ...(existing.customerId === customerId && typeof existing.activeLatitude === 'number' && typeof existing.activeLongitude === 'number' ?
        { activeLatitude: existing.activeLatitude, activeLongitude: existing.activeLongitude } : {}),
      createdAt: existing.createdAt, updatedAt: new Date().toISOString()
    };
    try { await table.updateEntity(updated, 'Replace', { etag }); }
    catch (error) {
      if (errorStatus(error) === 412) return { status: 412, jsonBody: { error: 'Device changed elsewhere; reload first' } };
      if (errorStatus(error) === 404) return { status: 404, jsonBody: { error: 'Device no longer exists' } };
      throw error;
    }
    const saved = await table.getEntity<Device>('DEVICE', serial);
    return { status: 200, jsonBody: present(saved) };
  } catch (error) {
    context.error('Unable to update device', error);
    return { status: 500, jsonBody: { error: 'Unable to update device' } };
  }
}

app.http('devicesGet', { methods: ['GET'], authLevel: 'anonymous', route: 'devices', handler: listDevices });
app.http('devicesCreate', { methods: ['POST'], authLevel: 'anonymous', route: 'devices', handler: createDevice });
app.http('devicesUpdate', { methods: ['PUT'], authLevel: 'anonymous', route: 'devices/{serialNumber}', handler: updateDevice });
