import { TableClient } from '@azure/data-tables';

import { errorStatus } from '../access';

import type {
  DeviceAuthenticationResult
} from './authentication';

import {
  readDeviceConfiguration
} from './configuration';

import {
  validateDeviceManifest,
  validateManagementCheckin
} from '../protocol/validation';

import {
  PROTOCOL_VERSION,
  type ManagementResponse
} from '../protocol/types';

import {
  persistDeviceEvents,
  EventConflictError
} from './events';

import { processStoredEvents } from './eventProcessor';

import { deliverDeviceCommands } from './commandDelivery';

type AuthenticatedRequest = Extract<
  DeviceAuthenticationResult,
  { status: 200 }
>;

export class ManagementError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'ManagementError';
  }
}

export async function processManagementCheckin(
  auth: AuthenticatedRequest,
  body: unknown
): Promise<ManagementResponse> {

  const {
    connection,
    serialNumber,
    device,
    legacy
  } = auth;

  if (legacy) {
    throw new ManagementError(
      409,
      'Legacy device requires legacy management handler'
    );
  }

  const message = validateManagementCheckin(body);

  const manifest = validateDeviceManifest(
    JSON.parse(device.manifestJson ?? '')
  );

  const capabilities = manifest.capabilities;

  if (
    message.capabilityProfileRevision !==
    capabilities.profileVersion
  ) {
    throw new ManagementError(
      409,
      'Capability profile revision does not match approved manifest'
    );
  }

  const supportsGps =
    capabilities.features.includes('gps');

  const desiredConfiguration =
    readDeviceConfiguration(device, supportsGps);

  if (
    message.appliedConfigurationRevision >
    desiredConfiguration.revision
  ) {
    throw new ManagementError(
      409,
      'Applied configuration revision exceeds desired revision'
    );
  }

  const serverTime = new Date().toISOString();

  // Determine the next expected check-in from the
  // reported operating mode and desired configuration.

  let nextCheckinSeconds =
    desiredConfiguration.telemetryIntervalSeconds;

  switch (message.powerMode) {

    case 'Standby':
    case 'TimedOff':
      nextCheckinSeconds =
        desiredConfiguration.powerOffCheckIntervalSeconds;
      break;

    case 'BatteryLockout':
      nextCheckinSeconds = 900;
      break;

    case 'Active':
    case 'Unknown':
      break;
  }

  const nextExpectedCheckinAt = new Date(
    Date.parse(serverTime) +
    nextCheckinSeconds * 1000
  ).toISOString();

  const devices = TableClient.fromConnectionString(
    connection,
    'SentinelDevices'
  );

  // Keep reported operational state separate from
  // desired configuration and approved identity.

  const update = {
    partitionKey: 'DEVICE',
    rowKey: serialNumber,

    lastSeenAt: serverTime,
    lastManagementCheckinAt: serverTime,

    firmwareVersion: message.firmwareVersion,

    reportedPowerMode: message.powerMode,

    lastResetReason: message.resetReason ?? '',
    lastWakeReason: message.wakeReason ?? '',

    appliedConfigurationRevision:
      message.appliedConfigurationRevision,

    reportedCapabilityProfileRevision:
      message.capabilityProfileRevision,

    lastManagementMessageId:
      message.messageId,

    lastManagementBootId:
      message.bootId,

    lastManagementSequence:
      message.sequence,

    managementHealthJson:
      JSON.stringify(message.health),

    nextCheckinSeconds,
    nextExpectedCheckinAt
  };

  try {

    await devices.updateEntity(
      update,
      'Merge',
      { etag: device.etag }
    );

  } catch (error) {

    if (errorStatus(error) === 412) {
      throw new ManagementError(
        409,
        'Device state changed; retry check-in'
      );
    }

    if (errorStatus(error) === 404) {
      throw new ManagementError(
        404,
        'Device no longer exists'
      );
    }

    throw error;
  }



  // Events must not be acknowledged until durably stored.
  // Command delivery will be implemented separately.

  try {
        await persistDeviceEvents(
            auth,
            message.events,
            message.bootId
            );
  } catch (error) {
    if (error instanceof EventConflictError) {
      throw new ManagementError(409, error.message);
    }

    throw error;
  }
  const acknowledgedEventIds = await processStoredEvents(
    connection,
    serialNumber,
    message.events.map(event => event.eventId)
  );

    const commands = await deliverDeviceCommands(
    auth,
    message.bootId
  );

  return {
    protocolVersion: PROTOCOL_VERSION,
    serverTime,

    acknowledgedEventIds,

    desiredConfiguration,

    commands,

    nextCheckinSeconds
  };
}