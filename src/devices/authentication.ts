import type { HttpRequest } from '@azure/functions';
import { TableClient } from '@azure/data-tables';
import { createHash, timingSafeEqual } from 'node:crypto';

import { errorStatus, validCustomerId } from '../access';
import type { ConfigurationEntity } from './configuration';
import { validateDeviceManifest } from '../protocol/validation';

const SERIAL = /^[A-Za-z0-9._-]{1,100}$/;
const HARDWARE_SERIAL = /^[0-9A-F]{12}$/;

export type AuthenticatedDevice = ConfigurationEntity & {
  deviceId: string;
  serialNumber?: string;
  deviceType: string;
  displayName: string;
  status: string;
  customerId: string;

  deviceKeyHash?: string;
  fingerprint?: string;
  manifestJson?: string;
  protocolVersion?: number;
  provisioningStatus?: string;
  allocationStatus?: string;
  deploymentStatus?: string;
  lifecycleStatus?: string;
  capabilitiesJson?: string;
  isSimulated?: boolean;

  currentDeploymentId?: string;
  deploymentRevision?: number;
  lastSeenAt?: string;
};

type ProvisionedIdentity = {
  deviceId: string;
  fingerprint: string;
  status: string;
  issuanceUntil?: string;
};

export type DeviceAuthenticationResult =
  | {
      status: 200;
      connection: string;
      serialNumber: string;
      device: AuthenticatedDevice & {
        partitionKey: string;
        rowKey: string;
        etag: string;
      };
      legacy: boolean;
    }
  | {
      status: 400 | 401 | 403;
      error: string;
    };

export async function authenticateDevice(
  request: HttpRequest
): Promise<DeviceAuthenticationResult> {

  const serial = (
    request.params.serialNumber ?? ''
  ).toUpperCase();

  if (!SERIAL.test(serial)) {
    return {
      status: 400,
      error: 'Invalid device serial number'
    };
  }

  const key =
    request.headers.get('x-sentinel-device-key') ?? '';

  if (!key || key.length > 200) {
    return {
      status: 401,
      error: 'Device credential required'
    };
  }

  const connection =
    process.env.SENTINEL_STORAGE_CONNECTION;

  if (!connection) {
    throw new Error('Storage not configured');
  }

  const devices = TableClient.fromConnectionString(
    connection,
    'SentinelDevices'
  );

  let device;

  try {
    device = await devices.getEntity<AuthenticatedDevice>(
      'DEVICE',
      serial
    );
  } catch (error) {
    if (errorStatus(error) === 404) {
      return {
        status: 401,
        error: 'Invalid device credential'
      };
    }

    throw error;
  }

  const saved = device.deviceKeyHash ?? '';

  if (
    !/^[0-9a-f]{64}$/.test(saved) ||
    !timingSafeEqual(
      Buffer.from(saved, 'hex'),
      createHash('sha256').update(key).digest()
    )
  ) {
    return {
      status: 401,
      error: 'Invalid device credential'
    };
  }

  // Temporary compatibility for the existing physical device.
  const legacy =
    serial === '0000001' &&
    !device.manifestJson &&
    device.provisioningStatus === undefined;

  if (!legacy) {

    if (!HARDWARE_SERIAL.test(serial)) {
      return {
        status: 403,
        error: 'Invalid hardware identity'
      };
    }

    if (
      device.provisioningStatus !== 'Confirmed' ||
      device.lifecycleStatus !== 'Active'
    ) {
      return {
        status: 403,
        error: 'Device is not confirmed and active'
      };
    }

    if (!/^[0-9a-f]{64}$/.test(device.fingerprint ?? '')) {
      return {
        status: 403,
        error: 'Device identity is incomplete'
      };
    }

    // Validate the actual stored Protocol v1 manifest.
    try {
      const manifest = validateDeviceManifest(
        JSON.parse(device.manifestJson ?? '')
      );

      if (
        manifest.protocolVersion !== 1 ||
        manifest.deviceType !== device.deviceType
      ) {
        return {
          status: 403,
          error: 'Device manifest does not match registry'
        };
      }

    } catch {
      return {
        status: 403,
        error: 'Invalid device manifest'
      };
    }

    // Provisioning is authoritative for credential lifecycle.
    const provisioning = TableClient.fromConnectionString(
      connection,
      'SentinelDeviceProvisioning'
    );

    let identity;

    try {
      identity = await provisioning.getEntity<ProvisionedIdentity>(
        'DEVICE',
        serial
      );
    } catch (error) {
      if (errorStatus(error) === 404) {
        return {
          status: 403,
          error: 'Provisioned identity not found'
        };
      }

      throw error;
    }

    if (
      identity.status !== 'Confirmed' ||
      identity.deviceId !== device.deviceId ||
      identity.fingerprint !== device.fingerprint ||
      Date.parse(identity.issuanceUntil ?? '') > Date.now()
    ) {
      return {
        status: 403,
        error: 'Device credential is not active'
      };
    }
    // Existing provisioned devices may not yet have
    // a deployment revision. Treat missing as zero.

    const deploymentRevision =
      device.deploymentRevision ?? 0;

    if (
      !Number.isSafeInteger(deploymentRevision) ||
      deploymentRevision < 0
    ) {
      return {
        status: 403,
        error: 'Invalid deployment revision'
      };
    }

    device.deploymentRevision = deploymentRevision;
    const validAllocation =
      (
        device.allocationStatus === 'Inventory' &&
        !device.customerId
      ) ||
      (
        device.allocationStatus === 'Allocated' &&
        validCustomerId(device.customerId)
      );

    if (!validAllocation) {
      return {
        status: 403,
        error: 'Invalid device allocation'
      };
    }
  }

  // Preserve existing suspension and retirement restrictions.
  const validStatus =
    (
      device.status === 'Inventory' &&
      !device.customerId
    ) ||
    (
      device.status === 'Assigned' &&
      validCustomerId(device.customerId)
    );

  if (!validStatus) {
    return {
      status: 403,
      error: 'Device lifecycle status does not permit communication'
    };
  }

  return {
    status: 200,
    connection,
    serialNumber: serial,
    device,
    legacy
  };
}