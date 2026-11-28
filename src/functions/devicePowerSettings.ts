import {
  app,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext
} from '@azure/functions';

import { TableClient } from '@azure/data-tables';

import {
  requireAccess,
  forbidden,
  canAccessCustomer,
  errorStatus
} from '../access';

import {
  readDeviceConfiguration,
  validateConfigurationPatch,
  type ConfigurationEntity
} from '../devices/configuration';

import {
  validateDeviceManifest
} from '../protocol/validation';

const SERIAL = /^[A-Za-z0-9._-]{1,100}$/;
const HARDWARE_SERIAL = /^[0-9A-F]{12}$/;

type Device = ConfigurationEntity & {
  status: string;
  customerId: string;
  deviceType: string;
  provisioningStatus?: string;
  lifecycleStatus?: string;
  manifestJson?: string;
};

const response = (
  status: number,
  error: string
): HttpResponseInit => ({
  status,
  headers: { 'Cache-Control': 'no-store' },
  jsonBody: { error }
});

async function powerSettingsUpdate(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  try {
    const access = await requireAccess(request);

    if (access.status !== 200)
      return forbidden(access.status);

    if (!access.permissions.canManageDevices)
      return forbidden(403);

    const serial = (
      request.params.serialNumber ?? ''
    ).toUpperCase();

    if (!SERIAL.test(serial))
      return response(400, 'Invalid serial number');

    const table = TableClient.fromConnectionString(
      access.connection,
      'SentinelDevices'
    );

    let device;

    try {
      device = await table.getEntity<Device>(
        'DEVICE',
        serial
      );
    } catch (error) {
      if (errorStatus(error) === 404)
        return response(404, 'Device not found');

      throw error;
    }

    // Inventory devices are manageable by administrators only.
    if (!access.isAdmin) {
      if (
        !device.customerId ||
        !canAccessCustomer(access, device.customerId)
      ) {
        return forbidden(403);
      }
    }

    if (
      device.lifecycleStatus === 'Retired' ||
      !['Inventory', 'Assigned'].includes(device.status)
    ) {
      return response(409, 'Device is not active');
    }

    // Temporary compatibility for the existing physical device.
    const legacy =
      serial === '0000001' &&
      !device.manifestJson &&
      device.provisioningStatus === undefined;

    let supportsGps = false;

    if (legacy) {

      supportsGps = device.deviceType === 'BayMonitor';

    } else {

      if (!HARDWARE_SERIAL.test(serial))
        return response(409, 'Invalid hardware identity');

      if (device.provisioningStatus !== 'Confirmed')
        return response(
          409,
          'Device provisioning is not confirmed'
        );

      if (device.lifecycleStatus !== 'Active')
        return response(409, 'Device is not active');

      // Capabilities are defined by the provisioned manifest.
      try {
        const manifest = validateDeviceManifest(
          JSON.parse(device.manifestJson ?? '')
        );

        if (manifest.deviceType !== device.deviceType)
          return response(
            409,
            'Device manifest does not match registry'
          );

        supportsGps =
          manifest.capabilities.features.includes('gps');

      } catch {
        return response(409, 'Invalid device manifest');
      }
    }

    let body: Record<string, unknown>;

    try {
      body = await request.json() as Record<string, unknown>;
    } catch {
      return response(400, 'Invalid JSON');
    }

    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body)
    ) {
      return response(400, 'Invalid settings');
    }

    const validation = validateConfigurationPatch(
      body,
      supportsGps
    );

    if (validation)
      return response(400, validation);

    if (
      body.desiredPowerState === 'OFF' &&
      !access.permissions.canShutdownDevices
    ) {
      return forbidden(403);
    }

    const etag = request.headers.get('if-match');

    if (!etag || etag === '*')
      return response(428, 'Supply device ETag in If-Match');

    if (etag !== device.etag)
      return response(412, 'Device changed; reload first');

    const current = readDeviceConfiguration(
      device,
      supportsGps
    );

    const update: ConfigurationEntity & {
      partitionKey: string;
      rowKey: string;
      updatedAt: string;
    } = {
      partitionKey: 'DEVICE',
      rowKey: serial,
      updatedAt: new Date().toISOString()
    };

    let changed = false;

    if (
      body.desiredPowerState !== undefined &&
      body.desiredPowerState !== current.desiredPowerState
    ) {
      update.desiredPowerState =
        body.desiredPowerState as string;

      changed = true;
    }

    if (
      body.telemetryIntervalSeconds !== undefined &&
      body.telemetryIntervalSeconds !== current.telemetryIntervalSeconds
    ) {
      update.telemetryIntervalSeconds =
        body.telemetryIntervalSeconds as number;

      changed = true;
    }

    if (
      body.powerOffCheckIntervalSeconds !== undefined &&
      body.powerOffCheckIntervalSeconds !== current.powerOffCheckIntervalSeconds
    ) {
      update.powerOffCheckIntervalSeconds =
        body.powerOffCheckIntervalSeconds as number;

      changed = true;
    }

    if (
      body.gpsEnabled !== undefined &&
      body.gpsEnabled !== current.gpsEnabled
    ) {
      update.gpsEnabled = body.gpsEnabled as boolean;

      changed = true;
    }

    // Do not increment the revision for an unchanged configuration.
    if (!changed) {
      return {
        status: 200,
        headers: { 'Cache-Control': 'no-store' },
        jsonBody: {
          ...current,
          etag: device.etag
        }
      };
    }

    update.configurationRevision = current.revision + 1;

    try {
      await table.updateEntity(
        update,
        'Merge',
        { etag }
      );
    } catch (error) {
      if (errorStatus(error) === 412)
        return response(412, 'Device changed; reload first');

      if (errorStatus(error) === 404)
        return response(404, 'Device no longer exists');

      throw error;
    }

    const saved = await table.getEntity<Device>(
      'DEVICE',
      serial
    );

    return {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
      jsonBody: {
        ...readDeviceConfiguration(saved, supportsGps),
        etag: saved.etag
      }
    };

  } catch (error) {
    context.error(
      'Unable to update device power settings',
      error
    );

    return response(500, 'Unable to update power settings');
  }
}

app.http('devicePowerSettingsUpdate', {
  methods: ['PATCH'],
  authLevel: 'anonymous',
  route: 'devices/{serialNumber}/power-settings',
  handler: powerSettingsUpdate
});