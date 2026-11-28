import { TableClient } from '@azure/data-tables';

import { errorStatus } from '../access';

import type { CommandEntity } from './commandEntity';
import type { StoredEvent } from './events';

import type {
  CommandStatus,
  DeviceEventType
} from '../protocol/types';

import { commandMatchesEvent } from './commandTarget';

import {
  isCommandStatus,
  isTerminalCommandStatus,
  canTransitionCommand,
  commandStatusForEvent
} from './commandTransitions';

export interface CommandProcessingResult {
  outcome: 'Applied' | 'Ignored' | 'AlreadyApplied' | 'Deferred';
  reason: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STATUS_TIMESTAMPS: Partial<
  Record<CommandStatus, string>
> = {
  Accepted: 'acceptedAt',
  Applied: 'appliedAt',
  Confirmed: 'confirmedAt',
  Failed: 'failedAt',
  Rejected: 'rejectedAt',
  Cancelled: 'cancelledAt'
};

function normaliseBootId(
  value: unknown
): string | undefined {

  if (
    typeof value !== 'string' ||
    !UUID_PATTERN.test(value)
  ) {
    return undefined;
  }

  return value.toLowerCase();
}

function verifyRestartBoot(
  command: CommandEntity,
  event: StoredEvent
): {
  bootId?: string;
  reason?: string;
} {

  if (command.type !== 'DEVICE_RESTART') {
    return {
      reason: 'BOOT event does not reference a restart command'
    };
  }

  const payload = JSON.parse(event.eventJson);

  const originalBootId = normaliseBootId(
    command.bootIdBefore
  );

  const previousBootId = normaliseBootId(
    payload.details?.previousBootId
  );

  const newBootId = normaliseBootId(
    payload.details?.bootId
  );

  if (
    !originalBootId ||
    !previousBootId ||
    !newBootId
  ) {
    return {
      reason: 'Required restart boot identifiers are missing or invalid'
    };
  }

  if (previousBootId !== originalBootId) {
    return {
      reason: 'Previous boot does not match command delivery boot'
    };
  }

  if (newBootId === originalBootId) {
    return {
      reason: 'Device boot identifier has not changed'
    };
  }

  return {
    bootId: newBootId
  };
}

export async function processCommandEvent(
  connection: string,
  serialNumber: string,
  eventId: string,
  event: StoredEvent
): Promise<CommandProcessingResult> {

  if (!event.commandId) {
    return {
      outcome: 'Ignored',
      reason: 'Event has no associated command'
    };
  }

  const commands = TableClient.fromConnectionString(
    connection,
    'SentinelDeviceCommands'
  );

  for (let attempt = 0; attempt < 5; attempt++) {

    let command;

    try {

      command = await commands.getEntity<CommandEntity>(
        serialNumber,
        event.commandId
      );

    } catch (error) {

      if (errorStatus(error) === 404) {
        return {
          outcome: 'Ignored',
          reason: 'Associated command does not exist'
        };
      }

      throw error;
    }

    if (!commandMatchesEvent(
      command,
      serialNumber,
      event
    )) {
      return {
        outcome: 'Ignored',
        reason: 'Command target does not match event identity'
      };
    }

    if (!isCommandStatus(command.status)) {
      throw new Error('Invalid stored command status');
    }

    if (command.lastEventId === eventId) {
      return {
        outcome: 'AlreadyApplied',
        reason: 'Event has already updated this command'
      };
    }

    let nextStatus: CommandStatus | undefined =
      commandStatusForEvent(
        event.type as DeviceEventType
      );

    let confirmedBootId: string | undefined;

    // Restart confirmation requires a correlated
    // BOOT event with a verified boot transition.

    if (event.type === 'BOOT') {

      const verification = verifyRestartBoot(
        command,
        event
      );

      if (!verification.bootId) {
        return {
          outcome: 'Ignored',
          reason: verification.reason ||
            'Restart verification failed'
        };
      }

      confirmedBootId = verification.bootId;

      if (command.status === 'Confirmed') {

        if (
          normaliseBootId(command.bootIdAfter) ===
          confirmedBootId
        ) {
          return {
            outcome: 'AlreadyApplied',
            reason: 'Restart has already been confirmed'
          };
        }

        return {
          outcome: 'Ignored',
          reason: 'Restart already confirmed against another boot'
        };
      }

      if (isTerminalCommandStatus(command.status)) {
        return {
          outcome: 'Ignored',
          reason: 'Command is already in a terminal state'
        };
      }

      if (command.status !== 'Applied') {
        return {
          outcome: 'Deferred',
          reason: 'Awaiting restart application event'
        };
      }

      nextStatus = 'Confirmed';

    } else if (nextStatus === 'Confirmed') {

      // Generic confirmation cannot confirm
      // a restart or an unverified physical action.

      if (command.type === 'DEVICE_RESTART') {
        return {
          outcome: 'Ignored',
          reason: 'Restart requires a correlated BOOT event'
        };
      }

      if (isTerminalCommandStatus(command.status)) {
        return {
          outcome: 'Ignored',
          reason: 'Command is already in a terminal state'
        };
      }

      return {
        outcome: 'Deferred',
        reason: 'Action-specific confirmation required'
      };
    }

    if (!nextStatus) {
      return {
        outcome: 'Ignored',
        reason: 'Event does not change command status'
      };
    }

    if (command.status === nextStatus) {
      return {
        outcome: 'AlreadyApplied',
        reason: 'Command already has the reported status'
      };
    }

    if (!canTransitionCommand(
      command.status,
      nextStatus
    )) {

      if (command.status === 'Queued') {
        return {
          outcome: 'Deferred',
          reason: 'Required command transition not yet recorded'
        };
      }

      return {
        outcome: 'Ignored',
        reason:
          `Invalid transition from ${command.status} to ${nextStatus}`
      };
    }

    const now = new Date().toISOString();

    const update: Record<string, string> = {
      partitionKey: serialNumber,
      rowKey: command.rowKey,

      status: nextStatus,

      lastEventId: eventId,
      lastEventAt: now
    };

    const timestampField =
      STATUS_TIMESTAMPS[nextStatus];

    if (timestampField) {
      update[timestampField] = now;
    }

    if (confirmedBootId) {
      update.bootIdAfter = confirmedBootId;
    }

    try {

      await commands.updateEntity(
        {
          ...update,
          partitionKey: serialNumber,
          rowKey: command.rowKey
        },
        'Merge',
        { etag: command.etag }
      );

      return {
        outcome: 'Applied',
        reason: `Command transitioned to ${nextStatus}`
      };

    } catch (error) {

      if (errorStatus(error) === 412) {
        continue;
      }

      throw error;
    }
  }

  throw new Error(
    'Command update exceeded concurrency retry limit'
  );
}