import { TableClient } from '@azure/data-tables';

import { errorStatus } from '../access';

import type {
  DeviceAuthenticationResult
} from './authentication';

import type { CommandEntity } from './commandEntity';

import type {
  DeviceCommand
} from '../protocol/types';

import {
  validateDeviceManifest,
  validateCommand,
  validateUuid
} from '../protocol/validation';

import { toDeviceCommand } from './commandEntity';
import { commandMatchesDevice } from './commandTarget';

type Authenticated = Extract<
  DeviceAuthenticationResult,
  { status: 200 }
>;

const MAX_COMMANDS_PER_CHECKIN = 10;

export async function deliverDeviceCommands(
  auth: Authenticated,
  bootId: string
): Promise<DeviceCommand[]> {

  if (auth.legacy) {
    throw new Error(
      'Legacy device cannot use Protocol v1 command delivery'
    );
  }

  validateUuid(bootId, 'bootId');

  const {
    connection,
    serialNumber,
    device
  } = auth;

  const manifest = validateDeviceManifest(
    JSON.parse(device.manifestJson || '{}')
  );

  const commands = TableClient.fromConnectionString(
    connection,
    'SentinelDeviceCommands'
  );

  const candidates: CommandEntity[] = [];

  for await (
    const command of commands.listEntities<CommandEntity>({
      queryOptions: {
        filter: `PartitionKey eq '${serialNumber}'`
      }
    })
  ) {

    if (
      command.status !== 'Queued' &&
      command.status !== 'Delivered'
    ) {
      continue;
    }

    if (!commandMatchesDevice(
      command,
      serialNumber,
      device
    )) {
      continue;
    }

    candidates.push(command);
  }

  // Oldest commands are considered first.

  candidates.sort(
    (a, b) =>
      a.requestedAt.localeCompare(b.requestedAt)
  );

  const delivered: DeviceCommand[] = [];

  for (const candidate of candidates) {

    if (
      delivered.length >= MAX_COMMANDS_PER_CHECKIN
    ) {
      break;
    }

    for (let attempt = 0; attempt < 5; attempt++) {

      let command;

      try {

        command = await commands.getEntity<CommandEntity>(
          serialNumber,
          candidate.rowKey
        );

      } catch (error) {

        if (errorStatus(error) === 404) {
          break;
        }

        throw error;
      }

      if (!commandMatchesDevice(
        command,
        serialNumber,
        device
      )) {
        break;
      }

      if (
        command.status !== 'Queued' &&
        command.status !== 'Delivered'
      ) {
        break;
      }

      const now = Date.now();
      const expiry = Date.parse(command.expiresAt);

      if (!Number.isFinite(expiry)) {
        throw new Error(
          `Invalid command expiry: ${command.rowKey}`
        );
      }

      // Only commands never offered to a device
      // can safely be marked expired here.
      //
      // Previously delivered commands may have
      // been executed without acknowledgement.

      if (expiry <= now) {

        if (command.status === 'Delivered') {
          break;
        }

        try {

          await commands.updateEntity(
            {
              partitionKey: serialNumber,
              rowKey: command.rowKey,
              status: 'Expired',
              expiredAt: new Date(now).toISOString()
            },
            'Merge',
            { etag: command.etag }
          );

          break;

        } catch (error) {

          if (errorStatus(error) === 412) {
            continue;
          }

          throw error;
        }
      }

      // Only restart is enabled until the other
      // action-specific workflows are implemented.

      if (command.type !== 'DEVICE_RESTART') {
        break;
      }

      const envelope = validateCommand(
        manifest.deviceType,
        manifest.capabilities,
        toDeviceCommand(command),
        now
      );

      if (command.status === 'Delivered') {

        // Do not re-offer a restart after the
        // device has already changed boot session.

        if (
          command.bootIdBefore?.toLowerCase() !==
          bootId.toLowerCase()
        ) {
          break;
        }

        delivered.push(envelope);
        break;
      }

      try {

        await commands.updateEntity(
          {
            partitionKey: serialNumber,
            rowKey: command.rowKey,

            status: 'Delivered',
            deliveredAt: new Date(now).toISOString(),
            bootIdBefore: bootId.toLowerCase()
          },
          'Merge',
          { etag: command.etag }
        );

        delivered.push(envelope);
        break;

      } catch (error) {

        if (errorStatus(error) === 412) {
          continue;
        }

        throw error;
      }
    }
  }

  return delivered;
}