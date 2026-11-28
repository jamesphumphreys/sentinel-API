import {
  app,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext
} from '@azure/functions';

import { TableClient } from '@azure/data-tables';
import { randomUUID } from 'node:crypto';

import {
  requireAccess,
  forbidden,
  errorStatus,
  canAccessCustomer
} from '../access';

import {
  type CommandEntity,
  toDeviceCommand,
  presentCommand
} from '../devices/commandEntity';

import {
  commandMatchesDevice
} from '../devices/commandTarget';

import type {
  AuthenticatedDevice
} from '../devices/authentication';

import {
  validateDeviceManifest,
  validateCommand,
  ProtocolValidationError
} from '../protocol/validation';

const SERIAL = /^[A-F0-9]{12}$/;
const LEGACY_SERIAL = '0000001';

const TABLE = 'SentinelDeviceCommands';
const EXPIRES_MS = 5 * 60 * 1000;

type Access = Extract<
  Awaited<ReturnType<typeof requireAccess>>,
  { status: 200 }
>;

type LegacyCommand = {
  partitionKey: string;
  rowKey: string;

  customerId: string;

  type: 'DEVICE_RESTART' | 'DEVICE_SHUTDOWN';
  status: string;

  requestedBy: string;
  requestedAt: string;
  expiresAt: string;

  deliveredAt?: string;
  appliedAt?: string;
  confirmedAt?: string;
  failedAt?: string;
};

const fail = (
  status: number,
  error: string
): HttpResponseInit => ({
  status,
  jsonBody: { error }
});

const ok = (
  status: number,
  jsonBody: unknown
): HttpResponseInit => ({
  status,
  headers: {
    'Cache-Control': 'no-store'
  },
  jsonBody
});

const tableFor = (connection: string) =>
  TableClient.fromConnectionString(
    connection,
    TABLE
  );

function validSerial(serial: string): boolean {
  return (
    serial === LEGACY_SERIAL ||
    SERIAL.test(serial)
  );
}

function isLegacyDevice(
  serial: string,
  device: AuthenticatedDevice
): boolean {

  return (
    serial === LEGACY_SERIAL &&
    !device.manifestJson &&
    !device.provisioningStatus
  );
}

function hasDeviceAccess(
  access: Access,
  device: AuthenticatedDevice
): boolean {

  if (access.isAdmin) {
    return true;
  }

  return (
    !!device.customerId &&
    canAccessCustomer(
      access,
      device.customerId
    )
  );
}

async function getDevice(
  connection: string,
  serial: string
) {

  return TableClient.fromConnectionString(
    connection,
    'SentinelDevices'
  ).getEntity<AuthenticatedDevice>(
    'DEVICE',
    serial
  );
}

function presentLegacyCommand(
  command: LegacyCommand
) {

  return {
    commandId: command.rowKey,
    serialNumber: command.partitionKey,

    type: command.type,
    status: command.status,

    requestedBy: command.requestedBy,
    requestedAt: command.requestedAt,
    expiresAt: command.expiresAt,

    deliveredAt: command.deliveredAt ?? null,
    appliedAt: command.appliedAt ?? null,
    confirmedAt: command.confirmedAt ?? null,
    failedAt: command.failedAt ?? null
  };
}

async function createLegacyCommand(
  access: Access,
  serial: string,
  device: AuthenticatedDevice,
  body: Record<string, unknown>
): Promise<HttpResponseInit> {

  const type = body.type;

  if (
    type !== 'DEVICE_RESTART' &&
    type !== 'DEVICE_SHUTDOWN'
  ) {
    return fail(400, 'Unsupported command type');
  }

  if (
    type === 'DEVICE_SHUTDOWN' &&
    !access.permissions.canShutdownDevices
  ) {
    return forbidden(403);
  }

  if (
    device.status !== 'Assigned' ||
    !device.customerId
  ) {
    return fail(409, 'Device must be assigned');
  }

  if (device.deviceType !== 'BayMonitor') {
    return fail(
      409,
      'Device does not support this command'
    );
  }

  const commands = tableFor(access.connection);
  const now = new Date();

  for await (
    const existing of commands.listEntities<
      LegacyCommand & { protocolVersion?: number }
    >({
      queryOptions: {
        filter: `PartitionKey eq '${serial}'`
      }
    })
  ) {

    if (existing.protocolVersion !== undefined) {
      continue;
    }

    if (
      existing.customerId === device.customerId &&
      (
        existing.status === 'Queued' ||
        existing.status === 'Delivered'
      ) &&
      Date.parse(existing.expiresAt) > now.getTime()
    ) {
      return fail(
        409,
        'Another power command is already pending'
      );
    }
  }

  const command: LegacyCommand = {
    partitionKey: serial,
    rowKey: randomUUID(),

    customerId: device.customerId,

    type,
    status: 'Queued',

    requestedBy: access.userId,
    requestedAt: now.toISOString(),

    expiresAt: new Date(
      now.getTime() + EXPIRES_MS
    ).toISOString()
  };

  await commands.createEntity(command);

  return ok(
    201,
    presentLegacyCommand(command)
  );
}

// Persist timeouts using optimistic concurrency so a concurrent device
// acknowledgement cannot be overwritten by a stale history read.
async function settleExpiredCommand(
  commands: TableClient,
  serial: string,
  commandId: string
): Promise<CommandEntity> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await commands.getEntity<CommandEntity>(serial, commandId);
    const now = Date.now();
    const expires = Date.parse(current.expiresAt);
    if (current.protocolVersion !== 1 || !Number.isFinite(expires) || expires > now) {
      return current;
    }

    const at = new Date(now).toISOString();
    let patch: Partial<CommandEntity>;
    switch (current.status) {
      case 'Queued':
        patch = { status: 'Expired', expiredAt: at };
        break;
      case 'Delivered':
        patch = { status: 'Failed', failedAt: at, failureReason: 'Device acknowledgement timeout; execution unconfirmed' };
        break;
      case 'Accepted':
        patch = { status: 'Failed', failedAt: at, failureReason: 'Device execution timeout; outcome unconfirmed' };
        break;
      case 'Applied':
        patch = { status: 'Failed', failedAt: at, failureReason: 'Device confirmation timeout; outcome unconfirmed' };
        break;
      default:
        return current;
    }

    if (!current.etag) throw new Error('Command ETag unavailable');
    try {
      await commands.updateEntity({ partitionKey: serial, rowKey: commandId, ...patch }, 'Merge', { etag: current.etag });
      return { ...current, ...patch };
    } catch (error) {
      if (errorStatus(error) !== 412) throw error;
    }
  }
  throw new Error('Command changed repeatedly during timeout processing');
}

async function createProtocolCommand(
  access: Access,
  serial: string,
  device: AuthenticatedDevice,
  body: Record<string, unknown>
): Promise<HttpResponseInit> {

  if (
    device.provisioningStatus !== 'Confirmed' ||
    device.lifecycleStatus !== 'Active'
  ) {
    return fail(
      409,
      'Device must be provisioned and active'
    );
  }

  if (
    device.allocationStatus === 'Inventory' &&
    device.status === 'Inventory' &&
    !device.customerId
  ) {

    if (!access.isAdmin) {
      return forbidden(403);
    }

  } else if (
    device.allocationStatus !== 'Allocated' ||
    device.status !== 'Assigned' ||
    !device.customerId ||
    !canAccessCustomer(access, device.customerId)
  ) {
    return fail(
      409,
      'Invalid device allocation state'
    );
  }

  if (
    !device.fingerprint ||
    !device.manifestJson ||
    !device.deviceKeyHash
  ) {
    return fail(
      409,
      'Device identity or credential unavailable'
    );
  }

  // Check authoritative provisioning state.
  // The registry alone may not reflect revocation.

  const provisioning =
    TableClient.fromConnectionString(
      access.connection,
      'SentinelDeviceProvisioning'
    );

  let identity;

  try {

    identity = await provisioning.getEntity<{
      status: string;
      deviceId: string;
      fingerprint: string;
      issuanceUntil?: string;
    }>(
      'DEVICE',
      serial
    );

  } catch (error) {

    if (errorStatus(error) === 404) {
      return fail(
        409,
        'Provisioned identity unavailable'
      );
    }

    throw error;
  }

  if (
    identity.status !== 'Confirmed' ||
    identity.deviceId !== device.deviceId ||
    identity.fingerprint !== device.fingerprint ||
    Date.parse(identity.issuanceUntil || '') > Date.now()
  ) {
    return fail(
      409,
      'Device credential is not currently active'
    );
  }

  if (body.type === 'DEVICE_SHUTDOWN') {
    return fail(
      400,
      'Shutdown must use desired power configuration'
    );
  }

  // Other actions remain disabled until their
  // execution and confirmation workflows exist.

  if (body.type !== 'DEVICE_RESTART') {
    return fail(
      400,
      'Command type is not currently enabled'
    );
  }

  for (const key of Object.keys(body)) {

    if (
      key !== 'type' &&
      key !== 'parameters'
    ) {
      return fail(
        400,
        `Unsupported command field: ${key}`
      );
    }
  }

  const manifest = validateDeviceManifest(
    JSON.parse(device.manifestJson)
  );

  if (manifest.deviceType !== device.deviceType) {
    return fail(
      409,
      'Device manifest does not match registry'
    );
  }

  if (
    !manifest.capabilities.actions.includes(
      'DEVICE_RESTART'
    )
  ) {
    return fail(
      409,
      'Device does not support remote restart'
    );
  }

  const deploymentRevision =
    device.deploymentRevision ?? 0;

  if (
    !Number.isSafeInteger(deploymentRevision) ||
    deploymentRevision < 0
  ) {
    return fail(
      409,
      'Invalid deployment revision'
    );
  }

  const now = new Date();

  const command: CommandEntity = {
    partitionKey: serial,
    rowKey: randomUUID(),

    protocolVersion: 1,

    deviceId: device.deviceId,
    fingerprint: device.fingerprint,
    customerId: device.customerId,
    deploymentRevision,

    type: 'DEVICE_RESTART',
    status: 'Queued',

    parametersJson: JSON.stringify(
      body.parameters === undefined
        ? {}
        : body.parameters
    ),

    requestedBy: access.userId,
    requestedAt: now.toISOString(),

    expiresAt: new Date(
      now.getTime() + EXPIRES_MS
    ).toISOString()
  };

  // Validate the same command envelope that
  // will ultimately be delivered to the device.

  try {

    const validated = validateCommand(
      manifest.deviceType,
      manifest.capabilities,
      toDeviceCommand(command),
      now.getTime()
    );

    command.parametersJson = JSON.stringify(
      validated.parameters
    );

  } catch (error) {

    if (error instanceof ProtocolValidationError) {
      return fail(400, error.message);
    }

    throw error;
  }

  const commands = tableFor(access.connection);

  for await (
    const existing of commands.listEntities<CommandEntity>({
      queryOptions: {
        filter: `PartitionKey eq '${serial}'`
      }
    })
  ) {

    if (!commandMatchesDevice(
      existing,
      serial,
      device
    )) {
      continue;
    }

    const current = await settleExpiredCommand(commands, serial, existing.rowKey);
    const pending =
      current.status === 'Queued' ||
      current.status === 'Delivered' ||
      current.status === 'Accepted' ||
      current.status === 'Applied';

    if (pending) {
      return fail(
        409,
        'Another command is awaiting completion'
      );
    }
  }

  await commands.createEntity(command);

  return ok(
    201,
    presentCommand(command)
  );
}

async function createCommand(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {

  try {

    const access = await requireAccess(request);

    if (access.status !== 200) {
      return forbidden(access.status);
    }

    if (!access.permissions.canManageDevices) {
      return forbidden(403);
    }

    const serial = (
      request.params.serialNumber ?? ''
    ).toUpperCase();

    if (!validSerial(serial)) {
      return fail(400, 'Invalid serial number');
    }

    let body: unknown;

    try {
      body = await request.json();
    } catch {
      return fail(400, 'Invalid JSON');
    }

    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body)
    ) {
      return fail(400, 'Invalid command');
    }

    let device;

    try {

      device = await getDevice(
        access.connection,
        serial
      );

    } catch (error) {

      if (errorStatus(error) === 404) {
        return fail(404, 'Device not found');
      }

      throw error;
    }

    if (!hasDeviceAccess(access, device)) {
      return forbidden(403);
    }

    const commandBody =
      body as Record<string, unknown>;

    if (isLegacyDevice(serial, device)) {

      return await createLegacyCommand(
        access,
        serial,
        device,
        commandBody
      );
    }

    return await createProtocolCommand(
      access,
      serial,
      device,
      commandBody
    );

  } catch (error) {

    context.error(
      'Unable to queue device command',
      error
    );

    return fail(
      500,
      'Unable to queue device command'
    );
  }
}

async function listCommands(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {

  try {

    const access = await requireAccess(request);

    if (access.status !== 200) {
      return forbidden(access.status);
    }

    if (!access.permissions.canManageDevices) {
      return forbidden(403);
    }

    const serial = (
      request.params.serialNumber ?? ''
    ).toUpperCase();

    if (!validSerial(serial)) {
      return fail(400, 'Invalid serial number');
    }

    let device;

    try {

      device = await getDevice(
        access.connection,
        serial
      );

    } catch (error) {

      if (errorStatus(error) === 404) {
        return fail(404, 'Device not found');
      }

      throw error;
    }

    if (!hasDeviceAccess(access, device)) {
      return forbidden(403);
    }

    const legacy = isLegacyDevice(
      serial,
      device
    );

    const results: Array<
      ReturnType<typeof presentCommand> |
      ReturnType<typeof presentLegacyCommand>
    > = [];

    try {

      const commands = tableFor(access.connection);
      for await (
        const entity of commands.listEntities<CommandEntity>({
          queryOptions: {
            filter: `PartitionKey eq '${serial}'`
          }
        })
      ) {

        // Never expose another customer's
        // historical commands to ordinary users.

        if (
          !access.isAdmin &&
          entity.customerId !== device.customerId
        ) {
          continue;
        }

        if (legacy) {

          if (entity.protocolVersion !== undefined) {
            continue;
          }

          results.push(
            presentLegacyCommand(
              entity as unknown as LegacyCommand
            )
          );

          continue;
        }

        if (entity.protocolVersion !== 1) {
          continue;
        }

        if (!commandMatchesDevice(
          entity,
          serial,
          device
        )) {
          continue;
        }

        results.push(
          presentCommand(await settleExpiredCommand(commands, serial, entity.rowKey))
        );
      }

    } catch (error) {

      if (errorStatus(error) !== 404) {
        throw error;
      }
    }

    results.sort(
      (a, b) =>
        b.requestedAt.localeCompare(a.requestedAt)
    );

    return ok(200, {
      commands: results.slice(0, 50)
    });

  } catch (error) {

    context.error(
      'Unable to list device commands',
      error
    );

    return fail(
      500,
      'Unable to list device commands'
    );
  }
}

app.http('devicePowerCommandCreate', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'devices/{serialNumber}/commands',
  handler: createCommand
});

app.http('devicePowerCommandsList', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'devices/{serialNumber}/commands',
  handler: listCommands
});