
import { TableClient } from "@azure/data-tables";
import { randomUUID } from "node:crypto";

import {
    validateSerialNumber,
    validateFingerprint
} from "../protocol/validation";

const TABLE_NAME = "SentinelDeviceProvisioning";
const PARTITION = "AUDIT";

export type ProvisioningAuditAction =
    | "ENROLMENT_AUTHORISED"
    | "ENROLMENT_REVOKED"
    | "CANDIDATE_APPROVED"
    | "CANDIDATE_REJECTED"
    | "CANDIDATE_RESTORED"
    | "DEVICE_PROVISIONED"
    | "CREDENTIAL_ROTATED"
    | "CREDENTIAL_REVOKED";

export interface ProvisioningAuditEvent {
    action: ProvisioningAuditAction;
    serialNumber: string;
    fingerprint?: string;
    actorType: "User" | "Device" | "System";
    actorId: string;
    previousStatus?: string;
    newStatus?: string;
    reason?: string;
    correlationId?: string;
}

export interface ProvisioningAuditRecord
    extends ProvisioningAuditEvent {
    eventId: string;
    occurredAt: string;
}

function getTable(connection: string): TableClient {
    return TableClient.fromConnectionString(
        connection,
        TABLE_NAME
    );
}

export async function writeProvisioningAudit(
    connection: string,
    event: ProvisioningAuditEvent
): Promise<ProvisioningAuditRecord> {

    const serialNumber = validateSerialNumber(
        event.serialNumber
    );

    if (event.fingerprint !== undefined) {
        validateFingerprint(event.fingerprint);
    }

    if (
        typeof event.actorId !== "string" ||
        !event.actorId.trim() ||
        event.actorId.length > 256
    ) {
        throw new Error("Invalid audit actor");
    }

    if (
        event.reason !== undefined &&
        (
            typeof event.reason !== "string" ||
            event.reason.length > 1000
        )
    ) {
        throw new Error("Invalid audit reason");
    }

    const eventId = randomUUID();
    const occurredAt = new Date().toISOString();

    // Reverse timestamp for newest-first ordering.
    const reverseTimestamp = String(
        Number.MAX_SAFE_INTEGER - Date.now()
    ).padStart(16, "0");

    const record: ProvisioningAuditRecord = {
        eventId,
        occurredAt,
        action: event.action,
        serialNumber,
        fingerprint: event.fingerprint ?? "",
        actorType: event.actorType,
        actorId: event.actorId,
        previousStatus: event.previousStatus ?? "",
        newStatus: event.newStatus ?? "",
        reason: event.reason ?? "",
        correlationId: event.correlationId ?? ""
    };

    await getTable(connection).createEntity({
        partitionKey: PARTITION,
        rowKey: `${reverseTimestamp}_${eventId}`,
        ...record
    });

    return record;
}

export async function listProvisioningAudit(
    connection: string,
    serialNumber?: string,
    cursor?: string
) {
    let filter = "PartitionKey eq 'AUDIT'";

    if (serialNumber !== undefined) {
        const serial = validateSerialNumber(
            serialNumber
        );

        filter += ` and serialNumber eq '${serial}'`;
    }

    const page = await getTable(connection)
        .listEntities<ProvisioningAuditRecord>({
            queryOptions: { filter }
        })
        .byPage({
            maxPageSize: 100,
            continuationToken: cursor
        })
        .next();

    if (page.done) {
        return {
            items: [],
            nextCursor: null
        };
    }

    const items = page.value.map(entity => ({
        eventId: entity.eventId,
        occurredAt: entity.occurredAt,
        action: entity.action,
        serialNumber: entity.serialNumber,
        fingerprint: entity.fingerprint || null,
        actorType: entity.actorType,
        actorId: entity.actorId,
        previousStatus: entity.previousStatus || null,
        newStatus: entity.newStatus || null,
        reason: entity.reason || null,
        correlationId: entity.correlationId || null
    }));

    return {
        items,
        nextCursor:
            page.value.continuationToken ?? null
    };
}
