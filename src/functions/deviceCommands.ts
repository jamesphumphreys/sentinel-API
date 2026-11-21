import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { TableClient } from '@azure/data-tables';
import { randomUUID } from 'node:crypto';
import { requireAccess, forbidden, errorStatus } from '../access';

const SERIAL = /^[A-Za-z0-9._-]{1,100}$/;
const COMMAND_ID = /^[0-9a-f-]{36}$/i;
const TABLE = 'SentinelDeviceCommands';
const EXPIRES_MS = 5 * 60 * 1000;

type CommandType = 'DEVICE_RESTART' | 'DEVICE_SHUTDOWN';
type CommandStatus = 'Queued' | 'Delivered' | 'Applied' | 'Confirmed' | 'Expired' | 'Failed';
type CommandEntity = {
  partitionKey: string;
  rowKey: string;
  customerId: string;
  type: CommandType;
  status: CommandStatus;
  requestedBy: string;
  requestedAt: string;
  expiresAt: string;
  deliveredAt?: string;
  appliedAt?: string;
  confirmedAt?: string;
  failedAt?: string;
  bootIdBefore?: string;
  bootIdAfter?: string;
};

const fail = (status: number, error: string): HttpResponseInit => ({ status, jsonBody: { error } });
const tableFor = (connection: string) => TableClient.fromConnectionString(connection, TABLE);
const publicCommand = (c: CommandEntity) => ({
  commandId: c.rowKey, serialNumber: c.partitionKey, type: c.type, status: c.status,
  requestedAt: c.requestedAt, requestedBy: c.requestedBy, expiresAt: c.expiresAt,
  deliveredAt: c.deliveredAt ?? null, appliedAt: c.appliedAt ?? null,
  confirmedAt: c.confirmedAt ?? null, failedAt: c.failedAt ?? null
});

async function getDevice(connection: string, serial: string) {
  return TableClient.fromConnectionString(connection, 'SentinelDevices')
    .getEntity<{ status: string; customerId: string; deviceType: string }>('DEVICE', serial);
}

async function createCommand(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const access = await requireAccess(request);
    if (access.status !== 200) return forbidden(access.status);
    if (!access.permissions.canManageDevices) return forbidden(403);
    const serial = (request.params.serialNumber ?? '').toUpperCase();
    if (!SERIAL.test(serial)) return fail(400, 'Invalid serial number');

    let body: unknown;
    try { body = await request.json(); } catch { return fail(400, 'Invalid JSON'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'Invalid command');
    const type = (body as Record<string, unknown>).type;
    if (type !== 'DEVICE_RESTART' && type !== 'DEVICE_SHUTDOWN') return fail(400, 'Unsupported command type');
    if (type === 'DEVICE_SHUTDOWN' && !access.permissions.canShutdownDevices) return forbidden(403);

    let device;
    try { device = await getDevice(access.connection, serial); }
    catch (e) { if (errorStatus(e) === 404) return fail(404, 'Device not found'); throw e; }
    if (device.status !== 'Assigned' || !device.customerId) return fail(409, 'Device must be assigned');
    if (device.deviceType !== 'BayMonitor') return fail(409, 'Device does not support this command');

    const commands = tableFor(access.connection);
    await commands.createTable().catch(e => { if (errorStatus(e) !== 409) throw e; });
    const now = new Date();
    for await (const existing of commands.listEntities<CommandEntity>({
      queryOptions: { filter: `PartitionKey eq '${serial}'` }
    })) {
      if ((existing.status === 'Queued' || existing.status === 'Delivered') &&
          Date.parse(existing.expiresAt) > now.getTime()) {
        return fail(409, 'Another power command is already pending for this device');
      }
    }
    const command: CommandEntity = {
      partitionKey: serial, rowKey: randomUUID(), customerId: device.customerId,
      type, status: 'Queued', requestedBy: access.userId,
      requestedAt: now.toISOString(), expiresAt: new Date(now.getTime() + EXPIRES_MS).toISOString()
    };
    await commands.createEntity(command);
    return { status: 201, headers: { 'Cache-Control': 'no-store' }, jsonBody: publicCommand(command) };
  } catch (e) {
    context.error('Unable to queue device command', e);
    return fail(500, 'Unable to queue device command');
  }
}

async function listCommands(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const access = await requireAccess(request);
    if (access.status !== 200) return forbidden(access.status);
    if (!access.permissions.canManageDevices) return forbidden(403);
    const serial = (request.params.serialNumber ?? '').toUpperCase();
    if (!SERIAL.test(serial)) return fail(400, 'Invalid serial number');
    try { await getDevice(access.connection, serial); }
    catch (e) { if (errorStatus(e) === 404) return fail(404, 'Device not found'); throw e; }
    const commands: ReturnType<typeof publicCommand>[] = [];
    try {
      for await (const entity of tableFor(access.connection).listEntities<CommandEntity>({
        queryOptions: { filter: `PartitionKey eq '${serial}'` }
      })) commands.push(publicCommand(entity));
    } catch (e) { if (errorStatus(e) !== 404) throw e; }
    commands.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
    return { status: 200, headers: { 'Cache-Control': 'no-store' }, jsonBody: { commands: commands.slice(0, 50) } };
  } catch (e) {
    context.error('Unable to list device commands', e);
    return fail(500, 'Unable to list device commands');
  }
}

app.http('devicePowerCommandCreate', {
  methods: ['POST'], authLevel: 'anonymous', route: 'devices/{serialNumber}/commands', handler: createCommand
});
app.http('devicePowerCommandsList', {
  methods: ['GET'], authLevel: 'anonymous', route: 'devices/{serialNumber}/commands', handler: listCommands
});
