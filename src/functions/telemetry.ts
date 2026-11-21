import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { TableClient } from '@azure/data-tables';
import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { errorStatus, validCustomerId } from '../access';

const SERIAL = /^[A-Za-z0-9._-]{1,100}$/;
const TABLE = 'SentinelDeviceTelemetry';
const numeric: Record<string, [number, number]> = {
  uptimeSeconds: [0, Number.MAX_SAFE_INTEGER], batteryVoltageMv: [0, 6000],
  batteryPercent: [0, 100], solarVoltageMv: [0, 30000],
  rssiDbm: [-150, 0], rsrpDbm: [-160, 0], rsrqDb: [-40, 0],
  csq: [0, 31], rsrpRaw: [0, 97], rsrqRaw: [0, 34],
  registrationStatus: [0, 255], gnssFixType: [0, 3],
  gnssElapsedSeconds: [0, Number.MAX_SAFE_INTEGER],
  latitude: [-90, 90], longitude: [-180, 180], altitudeMetres: [-1000, 30000],
  hdop: [0, 999], pdop: [0, 999], vdop: [0, 999]
};
const booleans = ['batteryPresent', 'charging', 'networkRegistered', 'packetAttached', 'dataContextActive'];
const strings: Record<string, number> = { operatorCode: 6, operatorName: 100,
  networkTechnology: 30, networkBand: 40, firmwareVersion: 100,
  rawGnss: 1024, rawCpsi: 1024 };
const fail = (status: number, error: string): HttpResponseInit => ({status, jsonBody: {error}});

async function ingest(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const serial = (request.params.serialNumber ?? '').toUpperCase();
    if (!SERIAL.test(serial)) return fail(400, 'Invalid device serial number');
    const key = request.headers.get('x-sentinel-device-key') ?? '';
    if (!key || key.length > 200) return fail(401, 'Device credential required');
    const connection = process.env.SENTINEL_STORAGE_CONNECTION;
    if (!connection) throw new Error('Storage not configured');
    const devices = TableClient.fromConnectionString(connection, 'SentinelDevices');
    let device;
    try { device = await devices.getEntity<{deviceId: string; status: string; customerId: string; deviceKeyHash?: string}>('DEVICE', serial); }
    catch (e) { if (errorStatus(e) === 404) return fail(401, 'Invalid device credential'); throw e; }
    const saved = device.deviceKeyHash ?? '';
    if (!/^[0-9a-f]{64}$/.test(saved) || !timingSafeEqual(Buffer.from(saved, 'hex'), createHash('sha256').update(key).digest())) return fail(401, 'Invalid device credential');
    if (!(device.status === 'Inventory' && !device.customerId) && !(device.status === 'Assigned' && validCustomerId(device.customerId))) return fail(403, 'Device lifecycle status does not permit telemetry');
    let body: Record<string, unknown>;
    try {
      const raw = await request.text();
      if (Buffer.byteLength(raw, 'utf8') > 8192) return fail(413, 'Telemetry too large');
      body = JSON.parse(raw);
    } catch { return fail(400, 'Invalid JSON'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'Invalid telemetry');
    const fields: Record<string, string | number | boolean> = {};
    for (const [name, value] of Object.entries(body)) {
      const range = Object.prototype.hasOwnProperty.call(numeric, name) ? numeric[name] : undefined;
      const maxLength = Object.prototype.hasOwnProperty.call(strings, name) ? strings[name] : undefined;
      if (!range && maxLength === undefined && !booleans.includes(name) && name !== 'sampledAt' && name !== 'powerSource') return fail(400, `Unknown field: ${name}`);
      if (value === null) continue; // Azure Tables omit unknown values.
      if (range) {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < range[0] || value > range[1]) return fail(400, `Invalid ${name}`);
        fields[name] = value;
      } else if (booleans.includes(name)) {
        if (typeof value !== 'boolean') return fail(400, `Invalid ${name}`);
        fields[name] = value;
      } else if (maxLength !== undefined) {
        if (typeof value !== 'string' || value.length > maxLength || (name === 'operatorCode' && !/^\d{5,6}$/.test(value))) return fail(400, `Invalid ${name}`);
        fields[name] = value;
      } else if (name === 'powerSource') {
        if (typeof value !== 'string' || !['unknown', 'usb', 'battery', 'solar'].includes(value)) return fail(400, 'Invalid powerSource');
        fields[name] = value;
      } else {
        if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) return fail(400, 'Invalid sampledAt');
        fields[name] = new Date(value).toISOString();
      }
    }
    if (typeof fields.uptimeSeconds !== 'number' || !Number.isSafeInteger(fields.uptimeSeconds)) return fail(400, 'Integer uptimeSeconds is required');
    if ((fields.latitude === undefined) !== (fields.longitude === undefined)) return fail(400, 'Supply both GPS coordinates or neither');
    const now = new Date();
    const rowKey = String(9999999999999 - now.getTime()).padStart(13, '0') + '-' + randomUUID();
    const telemetry = TableClient.fromConnectionString(connection, TABLE);
    await telemetry.createEntity({ ...fields, partitionKey: serial, rowKey,
      receivedAt: now.toISOString(), serialNumber: serial, deviceId: device.deviceId,
      customerId: device.customerId || '', deviceStatus: device.status });
    return {status: 201, jsonBody: {serialNumber: serial, rowKey, receivedAt: now.toISOString()}};
  } catch (e) {
    context.error('Telemetry ingestion failed', e);
    return fail(500, 'Unable to store telemetry');
  }
}
app.http('deviceTelemetryIngest', {methods: ['POST'], authLevel: 'anonymous', route: 'device/v1/{serialNumber}/telemetry', handler: ingest});
