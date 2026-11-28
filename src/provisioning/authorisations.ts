
import { TableClient } from "@azure/data-tables";
import { errorStatus } from "../access";
import { validateSerialNumber } from "../protocol/validation";

const TABLE_NAME = "SentinelDeviceProvisioning";
const PARTITION = "AUTHORISATION";

export interface EnrollmentAuthorisation {
    serialNumber: string;
    status: "Active" | "Revoked";
    authorisedAt: string;
    authorisedBy: string;
    expiresAt: string;
    notes: string;
    updatedAt: string;
    revokedAt?: string;
    revokedBy?: string;
}

function getTable(connection: string): TableClient {
    return TableClient.fromConnectionString(
        connection,
        TABLE_NAME
    );
}

export async function getAuthorisation(
    connection: string,
    serialNumber: string
) {
    const serial = validateSerialNumber(serialNumber);

    try {
        return await getTable(connection)
            .getEntity<EnrollmentAuthorisation>(
                PARTITION,
                serial
            );
    } catch (error) {
        if (errorStatus(error) === 404) {
            return null;
        }

        throw error;
    }
}

export function isAuthorisationActive(
    authorisation: EnrollmentAuthorisation | null,
    now = Date.now()
): boolean {
    if (
        !authorisation ||
        authorisation.status !== "Active"
    ) {
        return false;
    }

    const expiresAt = Date.parse(
        authorisation.expiresAt
    );

    return (
        Number.isFinite(expiresAt) &&
        expiresAt > now
    );
}

export async function isEnrollmentAuthorised(
    connection: string,
    serialNumber: string
): Promise<boolean> {
    const authorisation = await getAuthorisation(
        connection,
        serialNumber
    );

    return isAuthorisationActive(authorisation);
}

export async function authoriseEnrollment(
    connection: string,
    serialNumber: string,
    userId: string,
    expiresAt: string,
    notes = ""
): Promise<EnrollmentAuthorisation> {
    const serial = validateSerialNumber(serialNumber);

    const expiry = Date.parse(expiresAt);

    if (
        !Number.isFinite(expiry) ||
        expiry <= Date.now()
    ) {
        throw new Error(
            "Authorisation expiry must be in the future"
        );
    }

    if (
        typeof notes !== "string" ||
        notes.length > 1000
    ) {
        throw new Error("Invalid authorisation notes");
    }

    const table = getTable(connection);
    const existing = await getAuthorisation(
        connection,
        serial
    );

    const now = new Date().toISOString();

    const authorisation: EnrollmentAuthorisation = {
        serialNumber: serial,
        status: "Active",
        authorisedAt: now,
        authorisedBy: userId,
        expiresAt: new Date(expiry).toISOString(),
        notes: notes.trim(),
        updatedAt: now
    };

    const entity = {
        partitionKey: PARTITION,
        rowKey: serial,
        ...authorisation
    };

    if (existing) {
        await table.updateEntity(
            entity,
            "Replace",
            { etag: existing.etag }
        );
    } else {
        await table.createEntity(entity);
    }

    return authorisation;
}

export async function revokeEnrollment(
    connection: string,
    serialNumber: string,
    userId: string
): Promise<boolean> {
    const serial = validateSerialNumber(serialNumber);

    const existing = await getAuthorisation(
        connection,
        serial
    );

    if (!existing) {
        return false;
    }

    if (existing.status === "Revoked") {
        return true;
    }

    const now = new Date().toISOString();

    await getTable(connection).updateEntity(
        {
            partitionKey: PARTITION,
            rowKey: serial,
            status: "Revoked",
            revokedAt: now,
            revokedBy: userId,
            updatedAt: now
        },
        "Merge",
        { etag: existing.etag }
    );

    return true;
}

export async function listAuthorisations(
    connection: string,
    cursor?: string
) {
    const table = getTable(connection);

    const page = await table
        .listEntities<EnrollmentAuthorisation>({
            queryOptions: {
                filter: "PartitionKey eq 'AUTHORISATION'"
            }
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
        serialNumber: entity.serialNumber,
        status: entity.status,
        effectiveStatus:
            entity.status === "Revoked"
                ? "Revoked"
                : isAuthorisationActive(entity)
                    ? "Active"
                    : "Expired",
        authorisedAt: entity.authorisedAt,
        authorisedBy: entity.authorisedBy,
        expiresAt: entity.expiresAt,
        notes: entity.notes,
        updatedAt: entity.updatedAt,
        revokedAt: entity.revokedAt ?? null,
        revokedBy: entity.revokedBy ?? null
    }));

    return {
        items,
        nextCursor:
            page.value.continuationToken ?? null
    };
}
