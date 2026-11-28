import { TableClient } from '@azure/data-tables';
import { createHash } from 'node:crypto';

import { errorStatus } from '../access';

import type {
  DeviceAuthenticationResult
} from './authentication';

import type {
  DeviceEvent
} from '../protocol/types';

import {
  validateDeviceEvent
} from '../protocol/validation';

type AuthenticatedRequest = Extract<
  DeviceAuthenticationResult,
  { status: 200 }
>;

export type StoredEvent = {
  protocolVersion: number;

  deviceId: string;
  fingerprint: string;

  customerId: string;
  deploymentId: string;
  deploymentRevision: number;

  bootId: string;

  type: string;
  commandId: string;

  eventHash: string;
  eventJson: string;

  processingStatus: string;
  processingOutcome?: string;
  processingReason?: string;
  processedAt?: string;

  receivedAt: string;
};

export interface EventPersistenceResult {
  eventId: string;
  newlyStored: boolean;
  processingStatus: string;
}

export class EventConflictError extends Error {
  constructor(
    public readonly eventId: string
  ) {
    super(`Conflicting event content: ${eventId}`);
    this.name = 'EventConflictError';
  }
}

// Produce a deterministic representation of the event.
// JSON property ordering must not affect deduplication.

function canonicalEvent(event: DeviceEvent): string {

  const details = Object.fromEntries(
    Object.entries(event.details)
      .sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0
      )
  );

  return JSON.stringify({
    eventId: event.eventId.toLowerCase(),
    type: event.type,
    commandId: event.commandId?.toLowerCase() ?? null,
    occurredAt: event.occurredAt === null
      ? null
      : new Date(event.occurredAt).toISOString(),
    details
  });
}

export async function persistDeviceEvent(
  auth: AuthenticatedRequest,
  event: DeviceEvent,
  bootId: string
): Promise<EventPersistenceResult> {

  if (auth.legacy) {
    throw new Error(
      'Legacy events require legacy event handler'
    );
  }

  validateDeviceEvent(event);

  const {
    connection,
    serialNumber,
    device
  } = auth;

  const fingerprint = device.fingerprint;

  if (!fingerprint) {
    throw new Error('Device fingerprint is missing');
  }

  const eventJson = canonicalEvent(event);

  const eventHash = createHash('sha256')
    .update(eventJson, 'utf8')
    .digest('hex');

  const eventId = event.eventId.toLowerCase();

  const events = TableClient.fromConnectionString(
    connection,
    'SentinelDeviceEvents'
  );

  const entity = {
    partitionKey: serialNumber,
    rowKey: eventId,

    protocolVersion: 1,
    bootId: bootId.toLowerCase(),

    deviceId: device.deviceId,
    fingerprint,

    customerId: device.customerId,
    deploymentId: device.currentDeploymentId ?? '',
    deploymentRevision: device.deploymentRevision ?? 0,

    type: event.type,
    at: event.occurredAt ?? '',
    commandId: event.commandId?.toLowerCase() ?? '',

    detailsJson: JSON.stringify(event.details),

    eventJson,
    eventHash,

    processingStatus: 'Pending',

    receivedAt: new Date().toISOString()
  };

  try {

    await events.createEntity(entity);

    return {
      eventId: event.eventId,
      newlyStored: true,
      processingStatus: 'Pending'
    };

  } catch (error) {

    // A conflict may indicate a legitimate retry.
    // Never overwrite an existing event.

    if (errorStatus(error) !== 409) {
      throw error;
    }
  }

  const existing = await events.getEntity<StoredEvent>(
    serialNumber,
    eventId
  );

  // Confirm that the existing event belongs to the same
  // provisioned identity and contains identical content.

  if (
    existing.protocolVersion !== 1 ||
    existing.deviceId !== device.deviceId ||
    existing.fingerprint !== fingerprint ||
    existing.eventHash !== eventHash ||
    existing.eventJson !== eventJson
  ) {
    throw new EventConflictError(eventId);
  }

  return {
    eventId: event.eventId,
    newlyStored: false,
    processingStatus: existing.processingStatus
  };
}

export async function persistDeviceEvents(
  auth: AuthenticatedRequest,
  events: DeviceEvent[],
  bootId: string
): Promise<EventPersistenceResult[]> {

  const results: EventPersistenceResult[] = [];

  for (const event of events) {

    const result = await persistDeviceEvent(
      auth,
      event,
      bootId
    );

    results.push(result);
  }

  return results;
}