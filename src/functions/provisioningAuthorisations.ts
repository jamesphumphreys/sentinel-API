
import {
    app,
    HttpRequest,
    HttpResponseInit,
    InvocationContext
} from "@azure/functions";

import {
    requireAccess,
    forbidden,
    errorStatus
} from "../access";

import {
    authoriseEnrollment,
    revokeEnrollment,
    listAuthorisations,
    getAuthorisation
} from "../provisioning/authorisations";

import {
    writeProvisioningAudit,
    listProvisioningAudit
} from "../provisioning/audit";

import {
    validateSerialNumber,
    ProtocolValidationError
} from "../protocol/validation";

const DEFAULT_AUTHORISATION_DAYS = 7;
const MAX_AUTHORISATION_DAYS = 90;
const DAY_MS = 86400000;

function fail(
    status: number,
    error: string
): HttpResponseInit {
    return {
        status,
        jsonBody: { error }
    };
}

type Handler = (
    request: HttpRequest,
    context: InvocationContext
) => Promise<HttpResponseInit>;

function safe(handler: Handler): Handler {
    return async (request, context) => {
        try {
            return await handler(request, context);
        } catch (error) {
            if (
                error instanceof ProtocolValidationError
            ) {
                return fail(400, error.message);
            }

            const status = errorStatus(error);

            if (status === 409 || status === 412) {
                return fail(
                    409,
                    "Record changed; refresh and try again"
                );
            }

            context.error(
                "Provisioning authorisation request failed",
                error
            );

            return fail(500, "Internal server error");
        }
    };
}

async function list(
    request: HttpRequest
): Promise<HttpResponseInit> {

    const access = await requireAccess(request);

    if (access.status !== 200) {
        return forbidden(access.status);
    }

    if (
        !access.isAdmin ||
        !access.permissions.canManageDevices
    ) {
        return forbidden(403);
    }

    const cursor =
        request.query.get("cursor") ?? undefined;

    const result = await listAuthorisations(
        access.connection,
        cursor
    );

    return {
        status: 200,
        jsonBody: result
    };
}

async function authorise(
    request: HttpRequest,
    context: InvocationContext
): Promise<HttpResponseInit> {

    const access = await requireAccess(request);

    if (access.status !== 200) {
        return forbidden(access.status);
    }

    if (
        !access.isAdmin ||
        !access.permissions.canManageDevices
    ) {
        return forbidden(403);
    }

    const serialNumber = validateSerialNumber(
        request.params.serialNumber
    );

    let body: Record<string, unknown>;

    try {
        const value = await request.json();

        if (
            typeof value !== "object" ||
            value === null ||
            Array.isArray(value)
        ) {
            return fail(400, "Expected a JSON object");
        }

        body = value as Record<string, unknown>;
    } catch {
        return fail(400, "Invalid JSON");
    }

    for (const key of Object.keys(body)) {
        if (key !== "expiresAt" && key !== "notes") {
            return fail(
                400,
                `Unknown property: ${key}`
            );
        }
    }

    const now = Date.now();

    let expiry =
        now + DEFAULT_AUTHORISATION_DAYS * DAY_MS;

    if (body.expiresAt !== undefined) {
        if (typeof body.expiresAt !== "string") {
            return fail(400, "Invalid expiry");
        }

        expiry = Date.parse(body.expiresAt);
    }

    if (
        !Number.isFinite(expiry) ||
        expiry <= now ||
        expiry > now + MAX_AUTHORISATION_DAYS * DAY_MS
    ) {
        return fail(
            400,
            "Expiry must be within the next 90 days"
        );
    }

    const notes = body.notes ?? "";

    if (
        typeof notes !== "string" ||
        notes.length > 1000
    ) {
        return fail(400, "Invalid notes");
    }

    const previous = await getAuthorisation(
        access.connection,
        serialNumber
    );

    const result = await authoriseEnrollment(
        access.connection,
        serialNumber,
        access.userId,
        new Date(expiry).toISOString(),
        notes
    );

    try {
        await writeProvisioningAudit(
            access.connection,
            {
                action: "ENROLMENT_AUTHORISED",
                serialNumber,
                actorType: "User",
                actorId: access.userId,
                previousStatus: previous?.status,
                newStatus: "Active",
                reason: notes,
                correlationId: context.invocationId
            }
        );
    } catch (error) {
        context.error(
            "Authorisation saved but audit write failed",
            error
        );

        return {
            status: 200,
            jsonBody: {
                ...result,
                auditRecorded: false,
                warning:
                    "Authorisation saved; audit recording failed"
            }
        };
    }

    return {
        status: 200,
        jsonBody: {
            ...result,
            auditRecorded: true
        }
    };
}

async function revoke(
    request: HttpRequest,
    context: InvocationContext
): Promise<HttpResponseInit> {

    const access = await requireAccess(request);

    if (access.status !== 200) {
        return forbidden(access.status);
    }

    if (
        !access.isAdmin ||
        !access.permissions.canManageDevices
    ) {
        return forbidden(403);
    }

    const serialNumber = validateSerialNumber(
        request.params.serialNumber
    );

    const previous = await getAuthorisation(
        access.connection,
        serialNumber
    );

    if (!previous) {
        return fail(404, "Authorisation not found");
    }

    if (previous.status === "Revoked") {
        return {
            status: 200,
            jsonBody: {
                serialNumber,
                status: "Revoked",
                alreadyRevoked: true
            }
        };
    }

    const revoked = await revokeEnrollment(
        access.connection,
        serialNumber,
        access.userId
    );

    if (!revoked) {
        return fail(404, "Authorisation not found");
    }

    try {
        await writeProvisioningAudit(
            access.connection,
            {
                action: "ENROLMENT_REVOKED",
                serialNumber,
                actorType: "User",
                actorId: access.userId,
                previousStatus: previous.status,
                newStatus: "Revoked",
                correlationId: context.invocationId
            }
        );
    } catch (error) {
        context.error(
            "Authorisation revoked but audit write failed",
            error
        );

        return {
            status: 200,
            jsonBody: {
                serialNumber,
                status: "Revoked",
                auditRecorded: false,
                warning:
                    "Authorisation revoked; audit recording failed"
            }
        };
    }

    return {
        status: 200,
        jsonBody: {
            serialNumber,
            status: "Revoked",
            auditRecorded: true
        }
    };
}

async function audit(
    request: HttpRequest
): Promise<HttpResponseInit> {

    const access = await requireAccess(request);

    if (access.status !== 200) {
        return forbidden(access.status);
    }

    if (
        !access.isAdmin ||
        !access.permissions.canManageDevices
    ) {
        return forbidden(403);
    }

    const serialNumber =
        request.query.get("serialNumber") ?? undefined;

    const cursor =
        request.query.get("cursor") ?? undefined;

    const result = await listProvisioningAudit(
        access.connection,
        serialNumber,
        cursor
    );

    return {
        status: 200,
        jsonBody: result
    };
}

app.http("provisioningAuthorisationsList", {
    route: "provisioning/authorisations",
    methods: ["GET"],
    authLevel: "anonymous",
    handler: safe(list)
});

app.http("provisioningAuthorisationsPut", {
    route: "provisioning/authorisations/{serialNumber}",
    methods: ["PUT"],
    authLevel: "anonymous",
    handler: safe(authorise)
});

app.http("provisioningAuthorisationsDelete", {
    route: "provisioning/authorisations/{serialNumber}",
    methods: ["DELETE"],
    authLevel: "anonymous",
    handler: safe(revoke)
});

app.http("provisioningAuditList", {
    route: "provisioning/audit",
    methods: ["GET"],
    authLevel: "anonymous",
    handler: safe(audit)
});
