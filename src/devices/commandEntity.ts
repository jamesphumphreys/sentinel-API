import type {
  DeviceAction,
  DeviceCommand,
  CommandStatus
} from '../protocol/types';

export interface CommandEntity {
  partitionKey: string;
  rowKey: string;

  protocolVersion: number;

  deviceId: string;
  fingerprint: string;
  customerId: string;
  deploymentRevision: number;

  type: DeviceAction;
  status: CommandStatus;
  parametersJson: string;

  requestedBy: string;
  requestedAt: string;
  expiresAt: string;

  deliveredAt?: string;
  acceptedAt?: string;
  appliedAt?: string;
  confirmedAt?: string;
  failedAt?: string;
  rejectedAt?: string;
  expiredAt?: string;
  cancelledAt?: string;

  bootIdBefore?: string;
  bootIdAfter?: string;

  lastEventId?: string;
  lastEventAt?: string;
  failureReason?: string;
}

export function toDeviceCommand(
  entity: CommandEntity
): DeviceCommand {

  return {
    commandId: entity.rowKey,
    type: entity.type,
    issuedAt: entity.requestedAt,
    expiresAt: entity.expiresAt,

    target: {
      serialNumber: entity.partitionKey,
      fingerprint: entity.fingerprint,
      deploymentRevision: entity.deploymentRevision
    },

    parameters: JSON.parse(entity.parametersJson)

  } as DeviceCommand;
}

export function presentCommand(
  entity: CommandEntity
) {

  return {
    commandId: entity.rowKey,
    serialNumber: entity.partitionKey,

    protocolVersion: entity.protocolVersion,

    type: entity.type,
    status: entity.status,

    parameters: JSON.parse(
      entity.parametersJson || '{}'
    ),

    requestedBy: entity.requestedBy,
    requestedAt: entity.requestedAt,
    expiresAt: entity.expiresAt,

    deliveredAt: entity.deliveredAt ?? null,
    acceptedAt: entity.acceptedAt ?? null,
    appliedAt: entity.appliedAt ?? null,
    confirmedAt: entity.confirmedAt ?? null,
    failedAt: entity.failedAt ?? null,
    rejectedAt: entity.rejectedAt ?? null,
    expiredAt: entity.expiredAt ?? null,
    cancelledAt: entity.cancelledAt ?? null,

    bootIdBefore: entity.bootIdBefore ?? null,
    bootIdAfter: entity.bootIdAfter ?? null,

    lastEventId: entity.lastEventId ?? null,
    lastEventAt: entity.lastEventAt ?? null,
    failureReason: entity.failureReason ?? null
  };
}