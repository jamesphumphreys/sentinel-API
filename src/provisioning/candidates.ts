
import { TableClient } from "@azure/data-tables";
import { errorStatus } from "../access";

import {
    DeviceManifest
} from "../protocol/types";

import {
    validateSerialNumber,
    validateFingerprint,
    validateDeviceManifest
} from "../protocol/validation";

const TABLE_NAME = "SentinelDeviceProvisioning";
const PARTITION = "CANDIDATE";

export type CandidateStatus =
    | "Pending"
    | "Approved"
    | "Rejected"
    | "Confirmed";

export interface ProvisioningCandidate {
    serialNumber: string;
    fingerprint: string;
    publicKey: string;
    status: CandidateStatus;
    firmwareVersion: string;
    manifestJson?: string;
    createdAt: string;
    verifiedAt: string;
    lastSeenAt?: string;
    updatedAt?: string;
    rejectedAt?: string;
    rejectedBy?: string;
    rejectionReason?: string;
    restoredAt?: string;
    restoredBy?: string;
    approvedAt?: string;
    approvedBy?: string;
    displayName?: string;
}

export interface VerifiedCandidate {
    serialNumber: string;
    fingerprint: string;
    publicKey: string;
    manifest: DeviceManifest;
}

export class CandidateConflictError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "CandidateConflictError";
    }
}

function getTable(connection: string): TableClient {
    return TableClient.fromConnectionString(
        connection,
        TABLE_NAME
    );
}

function getRowKey(
    serialNumber: string,
    fingerprint: string
): string {
    const serial = validateSerialNumber(serialNumber);
    const hash = validateFingerprint(fingerprint);

    return `C_${serial}_${hash}`;
}

export async function getCandidate(
    connection: string,
    serialNumber: string,
    fingerprint: string
) {
    const rowKey = getRowKey(
        serialNumber,
        fingerprint
    );

    try {
        return await getTable(connection)
            .getEntity<ProvisioningCandidate>(
                PARTITION,
                rowKey
            );
    } catch (error) {
        if (errorStatus(error) === 404) {
            return null;
        }

        throw error;
    }
}

// Only call after successful cryptographic verification.

export async function recordVerifiedCandidate(
    connection: string,
    candidate: VerifiedCandidate
): Promise<CandidateStatus> {

    const rowKey = getRowKey(
        candidate.serialNumber,
        candidate.fingerprint
    );

    const manifest = validateDeviceManifest(
        candidate.manifest
    );

    const table = getTable(connection);

    for (let attempt = 0; attempt < 3; attempt++) {
        const existing = await getCandidate(
            connection,
            candidate.serialNumber,
            candidate.fingerprint
        );

        const now = new Date().toISOString();

        if (existing) {
            if (existing.publicKey !== candidate.publicKey) {
                throw new CandidateConflictError(
                    "Candidate public key mismatch"
                );
            }

            // Never overwrite an administrative decision.
            if (existing.status !== "Pending") {
                return existing.status;
            }

            try {
                await table.updateEntity(
                    {
                        partitionKey: PARTITION,
                        rowKey,
                        firmwareVersion:
                            manifest.firmwareVersion,
                        manifestJson:
                            JSON.stringify(manifest),
                        verifiedAt: now,
                        lastSeenAt: now,
                        updatedAt: now
                    },
                    "Merge",
                    { etag: existing.etag }
                );

                return "Pending";
            } catch (error) {
                if (errorStatus(error) === 412) {
                    continue;
                }

                throw error;
            }
        }

        try {
            await table.createEntity({
                partitionKey: PARTITION,
                rowKey,
                serialNumber: candidate.serialNumber,
                fingerprint: candidate.fingerprint,
                publicKey: candidate.publicKey,
                status: "Pending",
                firmwareVersion: manifest.firmwareVersion,
                manifestJson: JSON.stringify(manifest),
                createdAt: now,
                verifiedAt: now,
                lastSeenAt: now,
                updatedAt: now
            });

            return "Pending";
        } catch (error) {
            if (errorStatus(error) === 409) {
                continue;
            }

            throw error;
        }
    }

    throw new CandidateConflictError(
        "Candidate was modified concurrently"
    );
}

// Administrative rejection and restoration.

async function changeCandidateStatus(
    connection: string,
    serialNumber: string,
    fingerprint: string,
    expectedStatus: CandidateStatus,
    newStatus: CandidateStatus,
    properties: Record<string, string>
): Promise<void> {

    const existing = await getCandidate(
        connection,
        serialNumber,
        fingerprint
    );

    if (!existing) {
        throw new CandidateConflictError(
            "Provisioning candidate not found"
        );
    }

    if (existing.status !== expectedStatus) {
        throw new CandidateConflictError(
            `Cannot change candidate from ` +
            `${existing.status} to ${newStatus}`
        );
    }

    try {
        await getTable(connection).updateEntity(
            {
                ...properties,
                partitionKey: PARTITION,
                rowKey: getRowKey(
                    serialNumber,
                    fingerprint
                ),
                status: newStatus,
                updatedAt: new Date().toISOString()
            },
            "Merge",
            { etag: existing.etag }
        );
    } catch (error) {
        if (errorStatus(error) === 412) {
            throw new CandidateConflictError(
                "Candidate changed; refresh and try again"
            );
        }

        throw error;
    }
}

export async function rejectCandidate(
    connection: string,
    serialNumber: string,
    fingerprint: string,
    userId: string,
    reason = ""
): Promise<void> {

    if (
        typeof reason !== "string" ||
        reason.length > 1000
    ) {
        throw new Error("Invalid rejection reason");
    }

    await changeCandidateStatus(
        connection,
        serialNumber,
        fingerprint,
        "Pending",
        "Rejected",
        {
            rejectedAt: new Date().toISOString(),
            rejectedBy: userId,
            rejectionReason: reason.trim()
        }
    );
}

export async function restoreCandidate(
    connection: string,
    serialNumber: string,
    fingerprint: string,
    userId: string
): Promise<void> {

    await changeCandidateStatus(
        connection,
        serialNumber,
        fingerprint,
        "Rejected",
        "Pending",
        {
            restoredAt: new Date().toISOString(),
            restoredBy: userId
        }
    );
}

// Administrative candidate listing.

export async function listCandidates(
    connection: string,
    status?: CandidateStatus,
    cursor?: string
) {
    let filter = "PartitionKey eq 'CANDIDATE'";

    if (status !== undefined) {
        const allowed = [
            "Pending",
            "Approved",
            "Rejected",
            "Confirmed"
        ];

        if (!allowed.includes(status)) {
            throw new Error("Invalid candidate status");
        }

        filter += ` and status eq '${status}'`;
    }

    const page = await getTable(connection)
        .listEntities<ProvisioningCandidate>({
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

    const items = page.value.map(entity => {
        let manifest: DeviceManifest | null = null;

        if (entity.manifestJson) {
            manifest = validateDeviceManifest(
                JSON.parse(entity.manifestJson)
            );
        }

        return {
            serialNumber: entity.serialNumber,
            fingerprint: entity.fingerprint,
            status: entity.status,
            firmwareVersion: entity.firmwareVersion,
            manifest,
            identityVerified: true,
            createdAt: entity.createdAt,
            verifiedAt: entity.verifiedAt,
            lastSeenAt:
                entity.lastSeenAt ?? entity.verifiedAt,
            updatedAt:
                entity.updatedAt ?? entity.verifiedAt,
            displayName: entity.displayName ?? null,
            rejectedAt: entity.rejectedAt ?? null,
            rejectedBy: entity.rejectedBy ?? null,
            rejectionReason:
                entity.rejectionReason ?? null,
            restoredAt: entity.restoredAt ?? null,
            restoredBy: entity.restoredBy ?? null,
            approvedAt: entity.approvedAt ?? null,
            approvedBy: entity.approvedBy ?? null
        };
    });

    return {
        items,
        nextCursor:
            page.value.continuationToken ?? null
    };
}
