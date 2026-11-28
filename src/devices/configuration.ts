import type { DeviceConfiguration } from '../protocol/types';

export type ConfigurationEntity = {
  configurationRevision?: number;
  desiredPowerState?: string;
  telemetryIntervalSeconds?: number;
  powerOffCheckIntervalSeconds?: number;
  gpsEnabled?: boolean;
  profileSettingsJson?: string;
};

export function readDeviceConfiguration(
  entity: ConfigurationEntity,
  supportsGps: boolean
): DeviceConfiguration {
  let profileSettings: DeviceConfiguration['profileSettings'] = {};

  if (entity.profileSettingsJson) {
    const parsed = JSON.parse(entity.profileSettingsJson);

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Invalid stored device profile settings');
    }

    profileSettings = parsed;
  }

  return {
    revision: entity.configurationRevision ?? 1,
    desiredPowerState:
      entity.desiredPowerState === 'OFF' ? 'OFF' : 'ON',
    telemetryIntervalSeconds:
      entity.telemetryIntervalSeconds ?? 30,
    powerOffCheckIntervalSeconds:
      entity.powerOffCheckIntervalSeconds ?? 300,
    ...(supportsGps
      ? { gpsEnabled: entity.gpsEnabled ?? true }
      : {}),
    profileSettings
  };
}

export function validateConfigurationPatch(
  body: Record<string, unknown>,
  supportsGps: boolean
): string | null {
  const allowed = [
    'desiredPowerState',
    'telemetryIntervalSeconds',
    'powerOffCheckIntervalSeconds',
    'gpsEnabled'
  ];

  const keys = Object.keys(body);

  if (keys.length === 0) {
    return 'No settings supplied';
  }

  for (const key of keys) {
    if (!allowed.includes(key)) {
      return `Unsupported configuration setting: ${key}`;
    }
  }

  if (
    body.desiredPowerState !== undefined &&
    body.desiredPowerState !== 'ON' &&
    body.desiredPowerState !== 'OFF'
  ) {
    return 'desiredPowerState must be ON or OFF';
  }

  if (
    body.telemetryIntervalSeconds !== undefined &&
    (
      !Number.isInteger(body.telemetryIntervalSeconds) ||
      Number(body.telemetryIntervalSeconds) < 15 ||
      Number(body.telemetryIntervalSeconds) > 86400
    )
  ) {
    return 'telemetryIntervalSeconds must be 15–86400';
  }

  if (
    body.powerOffCheckIntervalSeconds !== undefined &&
    (
      !Number.isInteger(body.powerOffCheckIntervalSeconds) ||
      Number(body.powerOffCheckIntervalSeconds) < 60 ||
      Number(body.powerOffCheckIntervalSeconds) > 86400
    )
  ) {
    return 'powerOffCheckIntervalSeconds must be 60–86400';
  }

  if (body.gpsEnabled !== undefined) {
    if (!supportsGps) {
      return 'Device does not support GPS';
    }

    if (typeof body.gpsEnabled !== 'boolean') {
      return 'gpsEnabled must be a boolean';
    }
  }

  return null;
}