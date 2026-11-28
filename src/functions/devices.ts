import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { TableClient } from '@azure/data-tables';
import { validateDeviceManifest } from '../protocol/validation';
import { requireAccess, forbidden } from '../access';

const TABLE = 'SentinelDevices';
const SERIAL = /^[A-Za-z0-9._-]{1,100}$/;
const CUSTOMER = /^[A-Za-z0-9-]{1,64}$/;
const TYPES = ['BayMonitor', 'PumpMonitor', 'DamMonitor', 'FenceMonitor'] as const;
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
  provisioningStatus?: string; allocationStatus?: string; deploymentStatus?: string;
  lifecycleStatus?: string; manifestJson?: string; fingerprint?: string; isSimulated?: boolean;
  gpsEnabled?: boolean;
  createdAt: string; updatedAt: string;
};
type Body = { serialNumber?: unknown; deviceType?: unknown; displayName?: unknown;
  allocationStatus?: unknown; lifecycleStatus?: unknown; status?: unknown; customerId?: unknown; locationMode?: unknown;
  manualLatitude?: unknown; manualLongitude?: unknown;
  imei?: unknown; simIccid?: unknown; simCarrier?: unknown; simPhoneNumber?: unknown; modemModel?: unknown; firmwareVersion?: unknown };
const errorStatus = (error: unknown) => (error as { statusCode?: number }).statusCode;
const isType = (value: unknown): value is DeviceType => TYPES.some(v => v === value);
const isStatus = (value: unknown): value is Status => STATUSES.some(v => v === value);
const validCoordinate = (value: unknown, limit: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit;

function present(entity: Device & { etag?: string }) {
  const manifest = entity.manifestJson ? validateDeviceManifest(JSON.parse(entity.manifestJson)) : null;
  // Deployment handlers still own the legacy deployment state until migrated.
  const deploymentStatus = entity.deploymentState === 'Monitoring' ? 'Deployed' : 'Undeployed';
  return {
    provisioningStatus: entity.provisioningStatus ?? null,
    allocationStatus: entity.customerId ? 'Allocated' : 'Inventory',
    deploymentStatus,
    lifecycleStatus: entity.status === 'Retired' ? 'Retired' : 'Active',
    isSimulated: entity.isSimulated ?? null,
    protocolVersion: manifest?.protocolVersion ?? null,
    hardwareModel: manifest?.hardwareModel ?? null,
    hardwareRevision: manifest?.hardwareRevision ?? null,
    capabilities: manifest?.capabilities ?? null,
    fingerprint: entity.fingerprint ?? null,
    id: entity.deviceId, serialNumber: entity.serialNumber, deviceType: entity.deviceType,
    displayName: entity.displayName, status: entity.status, customerId: entity.customerId || null,
    locationMode: entity.locationMode === 'Manual' ? 'Manual' : 'GPS',
    manualLatitude: typeof entity.manualLatitude === 'number' ? entity.manualLatitude : null,
    manualLongitude: typeof entity.manualLongitude === 'number' ? entity.manualLongitude : null,
    deploymentState: entity.deploymentState || 'Awaiting',
    activeLatitude: typeof entity.activeLatitude === 'number' ? entity.activeLatitude : null,
    activeLongitude: typeof entity.activeLongitude === 'number' ? entity.activeLongitude : null,
    ...Object.fromEntries(HARDWARE_FIELDS.map(field => [field, entity[field] || null])),
    powerSettings: {desiredPowerState: entity.desiredPowerState === "OFF" ? "OFF" : "ON", telemetryIntervalSeconds: entity.telemetryIntervalSeconds ?? 30, powerOffCheckIntervalSeconds: entity.powerOffCheckIntervalSeconds ?? 300, gpsEnabled: entity.gpsEnabled ?? null},
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
    for await (const entity of table.listEntities<Device>({queryOptions: {filter: "PartitionKey eq 'DEVICE'"}})) {
      if (!access.isAdmin && (entity.customerId !== access.user.customerId || entity.status === 'Retired' || (entity.provisioningStatus && entity.provisioningStatus !== 'Confirmed'))) continue;
      const value = present(entity);
      if (!access.isAdmin) {
        for (const field of [...HARDWARE_FIELDS, 'fingerprint']) delete (value as Record<string,unknown>)[field];
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
  const access = await requireAccess(request);
  if (access.status !== 200) return forbidden(access.status);
  if (!access.isAdmin || !access.permissions.canManageDevices) return forbidden(403);
  return { status: 409, jsonBody: { error: 'Register new devices through cryptographic provisioning' } };
}

async function updateDevice(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const access = await requireAccess(request);
    if (access.status !== 200) return { status: access.status, jsonBody: { error: 'Access denied' } };
    if (!access.isAdmin || !access.permissions.canManageDevices) return forbidden(403);
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
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { status: 400, jsonBody: { error: 'Expected JSON object' } };
    // Accept canonical allocation/lifecycle fields and temporarily retain the old UI contract.
    if (body.allocationStatus !== undefined || body.lifecycleStatus !== undefined) {
      if (!['Inventory','Allocated'].includes(body.allocationStatus as string) || !['Active','Retired'].includes(body.lifecycleStatus as string))
        return { status: 400, jsonBody: { error: 'Invalid allocation or lifecycle status' } };
      if ((body.allocationStatus === 'Allocated') !== Boolean(body.customerId) || (body.lifecycleStatus === 'Retired' && body.customerId))
        return { status: 400, jsonBody: { error: 'Invalid allocation for customer or lifecycle' } };
      const status = body.lifecycleStatus === 'Retired' ? 'Retired' : body.allocationStatus === 'Allocated' ? 'Assigned' : 'Inventory';
      if (body.status !== undefined && body.status !== status) return { status: 400, jsonBody: { error: 'Conflicting status fields' } };
      body.status = status;
    }
    const validation = validateBody(body, false);
    if (validation) return { status: 400, jsonBody: { error: validation } };
    const customerId = body.customerId as string;
    const customerError = await checkCustomer(access.connection, customerId);
    if (customerError) return { status: 400, jsonBody: { error: customerError } };
    if (existing.provisioningStatus && existing.provisioningStatus !== 'Confirmed' && customerId)
      return { status: 409, jsonBody: { error: 'Confirm provisioning before allocation' } };
    if (body.status === 'Retired' && customerId)
      return { status: 400, jsonBody: { error: 'Retired devices must be unallocated' } };
    const customerChanged = existing.customerId !== customerId;
    if ((customerChanged || body.status === 'Retired') && (existing.currentDeploymentId || (existing.deploymentState && existing.deploymentState !== 'Awaiting')))
      return { status: 409, jsonBody: { error: 'Clear the existing deployment before changing allocation or retiring' } };
    // Preserve all stored identity, credential, configuration and diagnostic fields.
    // Strip SDK metadata before sending the replacement entity.
    const { etag: ignoredEtag, timestamp: ignoredTimestamp, ...stored } = existing as typeof existing & { timestamp?: unknown };
    const updated = {
      ...stored,
      partitionKey: 'DEVICE', rowKey: serial,
      displayName: (body.displayName as string).trim(), status: body.status as Status, customerId,
      allocationStatus: customerId ? 'Allocated' : 'Inventory',
      lifecycleStatus: body.status === 'Retired' ? 'Retired' : 'Active',
      deploymentStatus: existing.deploymentState === 'Monitoring' ? 'Deployed' : 'Undeployed',
      locationMode: body.locationMode as string,
      updatedAt: new Date().toISOString()
    } as Device & { partitionKey: string; rowKey: string; [key: string]: any };
    delete updated.farmId;
    delete updated.bayId;
    if (body.locationMode === 'Manual') {
      updated.manualLatitude = body.manualLatitude as number;
      updated.manualLongitude = body.manualLongitude as number;
    } else {
      delete updated.manualLatitude;
      delete updated.manualLongitude;
    }
    for (const field of HARDWARE_FIELDS) {
      if (field === 'firmwareVersion' && existing.manifestJson) continue;
      if (typeof body[field] === 'string') {
        const value = (body[field] as string).trim();
        if (value) updated[field] = value;
        else delete updated[field];
      }
    }
    if (customerChanged) {
      for (const field of ['currentDeploymentId','lastGoId','activeFarmId','activeBayId','activeLatitude','activeLongitude','lastWaterState','lastSeenAt','batteryPercent']) delete updated[field];
      updated.deploymentState = 'Awaiting';
      updated.deploymentStatus = 'Undeployed';
    }
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
