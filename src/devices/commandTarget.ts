import type { CommandEntity } from './commandEntity';
import type { StoredEvent } from './events';
import type { AuthenticatedDevice } from './authentication';

export function commandMatchesDevice(
  command: CommandEntity,
  serialNumber: string,
  device: AuthenticatedDevice
): boolean {

  return (
    command.protocolVersion === 1 &&
    command.partitionKey === serialNumber &&
    command.deviceId === device.deviceId &&
    !!device.fingerprint &&
    command.fingerprint === device.fingerprint &&
    command.customerId === device.customerId &&
    Number.isSafeInteger(command.deploymentRevision) &&
    command.deploymentRevision >= 0 &&
    command.deploymentRevision ===
      (device.deploymentRevision ?? 0)
  );
}

export function commandMatchesEvent(
  command: CommandEntity,
  serialNumber: string,
  event: StoredEvent
): boolean {

  return (
    command.protocolVersion === 1 &&
    event.protocolVersion === 1 &&
    command.partitionKey === serialNumber &&
    command.rowKey === event.commandId &&
    command.deviceId === event.deviceId &&
    !!event.fingerprint &&
    command.fingerprint === event.fingerprint &&
    command.customerId === event.customerId &&
    Number.isSafeInteger(command.deploymentRevision) &&
    command.deploymentRevision >= 0 &&
    command.deploymentRevision ===
      event.deploymentRevision
  );
}