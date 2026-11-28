
import {
    CapabilityManifest,
    DeviceAction,
    DeviceCommand,
    DeviceLifecycle,
    DeviceManifest,
    DeviceType,
    PROTOCOL_VERSION,
    PROTOCOL_LIMITS
} from "./types";

import {
    getDeviceProfile,
    isDeviceType,
    SensorDefinition
} from "./profiles";

export class ProtocolValidationError extends Error {
    constructor(
        public readonly field: string,
        message: string
    ) {
        super(`${field}: ${message}`);
        this.name = "ProtocolValidationError";
    }
}

function fail(field: string, message: string): never {
    throw new ProtocolValidationError(field, message);
}

function isRecord(
    value: unknown
): value is Record<string, unknown> {
    return (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value)
    );
}

function hasOwn(object: object, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(object, key);
}

function requireRecord(
    value: unknown,
    field: string
): Record<string, unknown> {
    if (!isRecord(value)) {
        fail(field, "Expected an object");
    }

    return value;
}

function requireString(
    value: unknown,
    field: string,
    maxLength = 128
): string {
    if (
        typeof value !== "string" ||
        value.trim().length === 0 ||
        value.length > maxLength
    ) {
        fail(field, "Invalid string");
    }

    return value;
}

function requireInteger(
    value: unknown,
    field: string,
    minimum: number,
    maximum: number
): number {
    if (
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < minimum ||
        value > maximum
    ) {
        fail(
            field,
            `Expected an integer between ${minimum} and ${maximum}`
        );
    }

    return value;
}

function requireStringArray(
    value: unknown,
    field: string
): string[] {
    if (!Array.isArray(value) || value.length > 64) {
        fail(field, "Invalid capability array");
    }

    const result = value.map((item, index) =>
        requireString(item, `${field}[${index}]`, 64)
    );

    if (new Set(result).size !== result.length) {
        fail(field, "Duplicate capabilities");
    }

    return result;
}

function requireTimestamp(
    value: unknown,
    field: string
): number {
    const text = requireString(value, field, 40);

    if (
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/
            .test(text)
    ) {
        fail(field, "Expected a UTC timestamp");
    }

    const timestamp = Date.parse(text);

    if (!Number.isFinite(timestamp)) {
        fail(field, "Invalid timestamp");
    }

    return timestamp;
}

// Identity

export function validateSerialNumber(
    value: unknown
): string {
    if (
        typeof value !== "string" ||
        !/^[0-9A-F]{12}$/.test(value)
    ) {
        fail(
            "serialNumber",
            "Expected 12 uppercase hexadecimal characters"
        );
    }

    return value;
}

export function validateFingerprint(
    value: unknown
): string {
    if (
        typeof value !== "string" ||
        !/^[0-9a-f]{64}$/.test(value)
    ) {
        fail(
            "fingerprint",
            "Expected a lowercase SHA-256 fingerprint"
        );
    }

    return value;
}

export function validateUuid(
    value: unknown,
    field = "id"
): string {
    if (
        typeof value !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
            .test(value)
    ) {
        fail(field, "Invalid UUID");
    }

    return value;
}

export function validateProtocolVersion(
    value: unknown
): typeof PROTOCOL_VERSION {
    if (value !== PROTOCOL_VERSION) {
        fail(
            "protocolVersion",
            "Unsupported protocol version"
        );
    }

    return PROTOCOL_VERSION;
}

// Capability validation

export function validateCapabilities(
    deviceType: DeviceType,
    value: unknown
): CapabilityManifest {
    const profile = getDeviceProfile(deviceType);
    const data = requireRecord(value, "capabilities");

    if (data.profileVersion !== profile.profileVersion) {
        fail(
            "capabilities.profileVersion",
            "Unsupported device profile version"
        );
    }

    const features = requireStringArray(
        data.features,
        "capabilities.features"
    );

    const inputs = requireStringArray(
        data.inputs,
        "capabilities.inputs"
    );

    const outputs = requireStringArray(
        data.outputs,
        "capabilities.outputs"
    );

    const actions = requireStringArray(
        data.actions,
        "capabilities.actions"
    );

    for (const feature of features) {
        if (!profile.features.includes(feature)) {
            fail("capabilities.features", `Unsupported feature: ${feature}`);
        }
    }

    for (const input of inputs) {
        if (!hasOwn(profile.inputs, input)) {
            fail("capabilities.inputs", `Unsupported input: ${input}`);
        }
    }

    for (const output of outputs) {
        if (!hasOwn(profile.outputs, output)) {
            fail("capabilities.outputs", `Unsupported output: ${output}`);
        }
    }

    for (const action of actions) {
        if (!hasOwn(profile.actions, action)) {
            fail("capabilities.actions", `Unsupported action: ${action}`);
        }

        const definition =
            profile.actions[action as DeviceAction];

        if (!definition) {
            fail("capabilities.actions", `Unsupported action: ${action}`);
        }

        for (const feature of definition.requiredFeatures) {
            if (!features.includes(feature)) {
                fail("capabilities.actions", `${action} requires ${feature}`);
            }
        }

        for (const input of definition.requiredInputs ?? []) {
            if (!inputs.includes(input)) {
                fail("capabilities.actions", `${action} requires input ${input}`);
            }
        }

        for (const output of definition.requiredOutputs ?? []) {
            if (!outputs.includes(output)) {
                fail("capabilities.actions", `${action} requires output ${output}`);
            }
        }
    }

    return {
        profileVersion: profile.profileVersion,
        features,
        inputs,
        outputs,
        actions: actions as DeviceAction[]
    };
}

export function validateDeviceManifest(
    value: unknown
): DeviceManifest {
    const data = requireRecord(value, "manifest");

    const protocolVersion = validateProtocolVersion(
        data.protocolVersion
    );

    if (!isDeviceType(data.deviceType)) {
        fail("deviceType", "Unsupported device type");
    }

    return {
        protocolVersion,
        deviceType: data.deviceType,

        firmwareVersion: requireString(
            data.firmwareVersion,
            "firmwareVersion"
        ),

        hardwareModel: requireString(
            data.hardwareModel,
            "hardwareModel"
        ),

        hardwareRevision: requireString(
            data.hardwareRevision,
            "hardwareRevision"
        ),

        capabilities: validateCapabilities(
            data.deviceType,
            data.capabilities
        )
    };
}

// Common message envelope

export function validateMessageEnvelope(
    value: unknown
): void {
    const data = requireRecord(value, "message");

    validateProtocolVersion(data.protocolVersion);
    validateUuid(data.messageId, "messageId");
    validateUuid(data.bootId, "bootId");

    requireInteger(
        data.sequence,
        "sequence",
        0,
        Number.MAX_SAFE_INTEGER
    );
}

// Sensor validation

export function validateSensorValue(
    value: unknown,
    definition: SensorDefinition,
    field: string
): void {
    // Null represents an unavailable measurement.
    if (value === null) {
        return;
    }

    if (typeof value !== definition.dataType) {
        fail(field, `Expected ${definition.dataType}`);
    }

    if (typeof value === "number") {
        if (!Number.isFinite(value)) {
            fail(field, "Measurement must be finite");
        }

        if (
            definition.integer &&
            !Number.isSafeInteger(value)
        ) {
            fail(field, "Expected an integer");
        }

        if (
            definition.minimum !== undefined &&
            value < definition.minimum
        ) {
            fail(field, "Measurement below minimum");
        }

        if (
            definition.maximum !== undefined &&
            value > definition.maximum
        ) {
            fail(field, "Measurement above maximum");
        }
    }

    if (
        typeof value === "string" &&
        value.length > 256
    ) {
        fail(field, "Measurement string too long");
    }
}

export function validateInputs(
    deviceType: DeviceType,
    capabilities: CapabilityManifest,
    value: unknown
): void {
    const approved = validateCapabilities(
        deviceType,
        capabilities
    );

    const profile = getDeviceProfile(deviceType);
    const inputs = requireRecord(value, "inputs");

    for (const [key, measurement] of Object.entries(inputs)) {
        if (
            !hasOwn(profile.inputs, key) ||
            !approved.inputs.includes(key)
        ) {
            fail(`inputs.${key}`, "Input not authorised");
        }

        validateSensorValue(
            measurement,
            profile.inputs[key],
            `inputs.${key}`
        );
    }
}

// Physical output state validation

export function validateOutputs(
    deviceType: DeviceType,
    capabilities: CapabilityManifest,
    value: unknown
): void {
    const approved = validateCapabilities(
        deviceType,
        capabilities
    );

    const profile = getDeviceProfile(deviceType);
    const outputs = requireRecord(value, "outputs");

    for (const [key, value] of Object.entries(outputs)) {
        if (
            !hasOwn(profile.outputs, key) ||
            !approved.outputs.includes(key)
        ) {
            fail(`outputs.${key}`, "Output not authorised");
        }

        const definition = profile.outputs[key];

        const state = requireRecord(
            value,
            `outputs.${key}`
        );

        for (const field of [
            "commandedState",
            "observedState"
        ]) {
            const reported = state[field];

            if (
                reported !== null &&
                !definition.allowedStates.some(
                    allowed => allowed === reported
                )
            ) {
                fail(
                    `outputs.${key}.${field}`,
                    "Invalid output state"
                );
            }
        }

        if (
            !definition.feedbackSupported &&
            state.observedState !== null
        ) {
            fail(
                `outputs.${key}.observedState`,
                "Physical feedback is not supported"
            );
        }
    }
}

// Lifecycle validation

export function validateLifecycle(
    value: unknown
): DeviceLifecycle {
    const data = requireRecord(value, "lifecycle");

    const provisioning = [
        "Pending", "Approved", "Confirmed", "Rejected"
    ];

    const allocation = ["Inventory", "Allocated"];
    const deployment = ["Undeployed", "Deployed"];
    const lifecycle = ["Active", "Retired"];

    if (!provisioning.some(v => v === data.provisioningStatus)) {
        fail("provisioningStatus", "Invalid status");
    }

    if (!allocation.some(v => v === data.allocationStatus)) {
        fail("allocationStatus", "Invalid status");
    }

    if (!deployment.some(v => v === data.deploymentStatus)) {
        fail("deploymentStatus", "Invalid status");
    }

    if (!lifecycle.some(v => v === data.lifecycleStatus)) {
        fail("lifecycleStatus", "Invalid status");
    }

    if (
        data.allocationStatus === "Allocated" &&
        data.provisioningStatus !== "Confirmed"
    ) {
        fail("allocationStatus", "Device is not provisioned");
    }

    if (
        data.deploymentStatus === "Deployed" &&
        data.allocationStatus !== "Allocated"
    ) {
        fail("deploymentStatus", "Device is not allocated");
    }

    if (
        data.lifecycleStatus === "Retired" &&
        (
            data.allocationStatus !== "Inventory" ||
            data.deploymentStatus !== "Undeployed"
        )
    ) {
        fail(
            "lifecycleStatus",
            "Retired devices cannot be allocated or deployed"
        );
    }

    return data as unknown as DeviceLifecycle;
}

// Command validation

export function validateCommand(
    deviceType: DeviceType,
    capabilities: CapabilityManifest,
    value: unknown,
    now = Date.now()
): DeviceCommand {
    const approved = validateCapabilities(
        deviceType,
        capabilities
    );

    const profile = getDeviceProfile(deviceType);
    const data = requireRecord(value, "command");

    validateUuid(data.commandId, "commandId");

    const type = requireString(
        data.type,
        "command.type"
    ) as DeviceAction;

    if (
        !hasOwn(profile.actions, type) ||
        !approved.actions.includes(type)
    ) {
        fail("command.type", "Action not authorised");
    }

    const definition = profile.actions[type];

    if (!definition) {
        fail("command.type", "Unsupported action");
    }

    const target = requireRecord(
        data.target,
        "command.target"
    );

    validateSerialNumber(target.serialNumber);
    validateFingerprint(target.fingerprint);

    requireInteger(
        target.deploymentRevision,
        "target.deploymentRevision",
        0,
        Number.MAX_SAFE_INTEGER
    );

    const issuedAt = requireTimestamp(
        data.issuedAt,
        "issuedAt"
    );

    const expiresAt = requireTimestamp(
        data.expiresAt,
        "expiresAt"
    );

    if (issuedAt > now) {
        fail("issuedAt", "Command has not been issued yet");
    }

    if (expiresAt <= issuedAt || expiresAt <= now) {
        fail("expiresAt", "Command expired or invalid");
    }

    if (
        definition.expirySeconds !== undefined &&
        expiresAt - issuedAt >
            definition.expirySeconds * 1000
    ) {
        fail("expiresAt", "Command lifetime exceeds limit");
    }

    const parameters = requireRecord(
        data.parameters,
        "parameters"
    );

    if (type === "DEVICE_IDENTIFY") {
        for (const key of Object.keys(parameters)) {
            if (key !== "durationSeconds") {
                fail(`parameters.${key}`, "Unknown parameter");
            }
        }

        const durationSeconds = requireInteger(
            parameters.durationSeconds === undefined
                ? PROTOCOL_LIMITS.identifyDefaultSeconds
                : parameters.durationSeconds,
            "parameters.durationSeconds",
            1,
            PROTOCOL_LIMITS.identifyMaximumSeconds
        );

        return {
            ...data,
            parameters: { durationSeconds }
        } as unknown as DeviceCommand;
    }

    if (Object.keys(parameters).length !== 0) {
        fail("parameters", "Unexpected command parameters");
    }

    return data as unknown as DeviceCommand;
}
