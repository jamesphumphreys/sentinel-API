import { TableClient } from '@azure/data-tables';

import { errorStatus } from '../access';
import type { StoredEvent } from './events';
import { processCommandEvent } from './commandProcessor';

export async function processStoredEvent(
  connection: string,
  serialNumber: string,
  eventId: string
): Promise<boolean> {

  const events = TableClient.fromConnectionString(
    connection,
    'SentinelDeviceEvents'
  );

  const rowKey = eventId.toLowerCase();

  for (let attempt = 0; attempt < 5; attempt++) {

    const event = await events.getEntity<StoredEvent>(
      serialNumber,
      rowKey
    );

    if (event.protocolVersion !== 1) {
      throw new Error(
        'Legacy event cannot use Protocol v1 processor'
      );
    }

    // Previously completed events can be
    // acknowledged without processing again.

    if (
      event.processingStatus === 'Processed' ||
      event.processingStatus === 'Ignored'
    ) {
      return true;
    }

    if (event.processingStatus !== 'Pending') {
      throw new Error('Invalid event processing status');
    }

    // Non-command events are retained as historical
    // records until dedicated handlers are introduced.

    const result = event.commandId
      ? await processCommandEvent(
          connection,
          serialNumber,
          rowKey,
          event
        )
      : {
          outcome: 'Applied' as const,
          reason: 'Event recorded in device history'
        };

    // Deferred events remain pending and must
    // not be acknowledged to the device.

    if (result.outcome === 'Deferred') {
      return false;
    }

    const processingStatus =
      result.outcome === 'Ignored'
        ? 'Ignored'
        : 'Processed';

    try {

      await events.updateEntity(
        {
          partitionKey: serialNumber,
          rowKey,

          processingStatus,
          processingOutcome: result.outcome,
          processingReason: result.reason,
          processedAt: new Date().toISOString()
        },
        'Merge',
        { etag: event.etag }
      );

      return true;

    } catch (error) {

      if (errorStatus(error) === 412) {
        continue;
      }

      throw error;
    }
  }

  throw new Error(
    'Event processing exceeded concurrency retry limit'
  );
}

export async function processStoredEvents(
  connection: string,
  serialNumber: string,
  eventIds: string[]
): Promise<string[]> {

  const acknowledged: string[] = [];

  for (const eventId of eventIds) {

    const completed = await processStoredEvent(
      connection,
      serialNumber,
      eventId
    );

    if (completed) {
      acknowledged.push(eventId);
    }
  }

  return acknowledged;
}