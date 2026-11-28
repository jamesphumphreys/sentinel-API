import type {
  CommandStatus,
  DeviceEventType
} from '../protocol/types';

const TERMINAL_STATUSES: ReadonlySet<CommandStatus> =
  new Set([
    'Confirmed',
    'Failed',
    'Rejected',
    'Expired',
    'Cancelled'
  ]);

const TRANSITIONS: Record<
  CommandStatus,
  readonly CommandStatus[]
> = {
  Queued: [
    'Delivered',
    'Expired',
    'Cancelled'
  ],

  Delivered: [
    'Accepted',
    'Applied',
    'Failed',
    'Rejected',
    'Expired',
    'Cancelled'
  ],

  Accepted: [
    'Applied',
    'Failed',
    'Rejected',
    'Expired',
    'Cancelled'
  ],

  Applied: [
    'Confirmed',
    'Failed'
  ],

  Confirmed: [],
  Failed: [],
  Rejected: [],
  Expired: [],
  Cancelled: []
};

const EVENT_STATUSES: Partial<
  Record<DeviceEventType, CommandStatus>
> = {
  COMMAND_ACCEPTED: 'Accepted',
  COMMAND_APPLIED: 'Applied',
  COMMAND_CONFIRMED: 'Confirmed',
  COMMAND_FAILED: 'Failed',
  COMMAND_REJECTED: 'Rejected',
  COMMAND_CANCELLED: 'Cancelled'
};

export function isCommandStatus(
  value: unknown
): value is CommandStatus {

  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(
      TRANSITIONS,
      value
    )
  );
}

export function isTerminalCommandStatus(
  status: CommandStatus
): boolean {

  return TERMINAL_STATUSES.has(status);
}

export function canTransitionCommand(
  current: CommandStatus,
  next: CommandStatus
): boolean {

  if (!isCommandStatus(current) ||
      !isCommandStatus(next)) {
    return false;
  }

  // Repeating an existing status is idempotent.
  if (current === next) {
    return true;
  }

  return TRANSITIONS[current].includes(next);
}

export function commandStatusForEvent(
  type: DeviceEventType
): CommandStatus | undefined {

  return EVENT_STATUSES[type];
}