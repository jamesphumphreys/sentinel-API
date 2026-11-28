import {
    CapabilityManifest,
    DeviceHealth,
    DeviceEvent,
    ManagementCheckin,
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

// Management message validation

function rejectUnknown(data: Record<string, unknown>, allowed: string[], field: string): void {
    for (const key of Object.keys(data)) {
        if (!allowed.includes(key)) fail(`${field}.${key}`, "Unknown field");
    }
}

export function validateDeviceHealth(value: unknown): DeviceHealth {
    const data = requireRecord(value, "health");
    const ranges: Record<string, [number, number]> = {
        uptimeSeconds: [0, Number.MAX_SAFE_INTEGER],
        batteryVoltageMv: [0, 60000], solarVoltageMv: [0, 100000],
        latitude: [-90, 90], longitude: [-180, 180], altitude: [-1000, 30000],
        csq: [0, 31], rssi: [-150, 0], rsrp: [-160, 0], rsrq: [-40, 0],
        gnssElapsedSeconds: [0, Number.MAX_SAFE_INTEGER]
    };
    const strings: Record<string, number> = {
        networkTechnology: 30, networkBand: 40, operatorCode: 6,
        operatorName: 100, gnssFixType: 40
    };
    rejectUnknown(data, [...Object.keys(ranges), ...Object.keys(strings)], "health");
    for (const [key, item] of Object.entries(data)) {
        if (item === null) continue;
        const field = `health.${key}`;
        if (hasOwn(ranges, key)) {
            const [min, max] = ranges[key];
            if (typeof item !== "number" || !Number.isFinite(item) || item < min || item > max)
                fail(field, "Invalid measurement");
            if (["uptimeSeconds", "batteryVoltageMv", "solarVoltageMv", "csq", "gnssElapsedSeconds"].includes(key))
                requireInteger(item, field, min, max);
        } else {
            const text = requireString(item, field, strings[key]);
            if (key === "operatorCode" && !/^\d{5,6}$/.test(text)) fail(field, "Invalid operator code");
        }
    }
    if ((typeof data.latitude === "number") !== (typeof data.longitude === "number"))
        fail("health", "Supply both GPS coordinates or neither");
    return data as DeviceHealth;
}

export function validateDeviceEvent(value: unknown): DeviceEvent {
    const data = requireRecord(value, "event");
    rejectUnknown(data, ["eventId", "type", "commandId", "occurredAt", "details"], "event");
    validateUuid(data.eventId, "event.eventId");
    const types = ["BOOT", "COMMAND_ACCEPTED", "COMMAND_APPLIED", "COMMAND_CONFIRMED",
        "COMMAND_FAILED", "COMMAND_REJECTED", "COMMAND_CANCELLED", "CONFIGURATION_APPLIED",
        "CONFIGURATION_REJECTED", "IDENTIFY_STARTED", "IDENTIFY_COMPLETED", "IDENTIFY_CANCELLED",
        "OUTPUT_STATE_CHANGED", "SENSOR_FAULT", "POWER_STATE_CHANGED"];
    const type = requireString(data.type, "event.type", 64);
    if (!types.includes(type)) fail("event.type", "Unknown event type");
    if (data.commandId !== undefined || type.startsWith("COMMAND_") || type.startsWith("IDENTIFY_"))
        validateUuid(data.commandId, "event.commandId");
    if (data.occurredAt !== null) requireTimestamp(data.occurredAt, "event.occurredAt");
    const details = requireRecord(data.details, "event.details");
    if (Object.keys(details).length > 32) fail("event.details", "Too many detail fields");
    for (const [key, item] of Object.entries(details)) {
        if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) fail("event.details", "Invalid detail name");
        if (item === null || typeof item === "boolean") continue;
        if (typeof item === "number" && Number.isFinite(item)) continue;
        if (typeof item === "string" && item.length <= 256) continue;
        fail(`event.details.${key}`, "Invalid detail value");
    }
    return data as unknown as DeviceEvent;
}

export function validateManagementCheckin(value: unknown): ManagementCheckin {
    const data = requireRecord(value, "checkin");
    rejectUnknown(data, ["protocolVersion", "messageId", "bootId", "sequence", "firmwareVersion",
        "resetReason", "wakeReason", "powerMode", "appliedConfigurationRevision",
        "capabilityProfileRevision", "health", "events"], "checkin");
    validateMessageEnvelope(data);
    requireString(data.firmwareVersion, "firmwareVersion");
    for (const field of ["resetReason", "wakeReason"]) {
        if (data[field] !== null) requireString(data[field], field);
    }
    if (!["Active", "Standby", "BatteryLockout", "TimedOff", "Unknown"].some(mode => mode === data.powerMode))
        fail("powerMode", "Invalid power mode");
    requireInteger(data.appliedConfigurationRevision, "appliedConfigurationRevision", 0, Number.MAX_SAFE_INTEGER);
    requireInteger(data.capabilityProfileRevision, "capabilityProfileRevision", 1, Number.MAX_SAFE_INTEGER);
    validateDeviceHealth(data.health);
    if (!Array.isArray(data.events) || data.events.length > PROTOCOL_LIMITS.maxEventsPerBatch)
        fail("events", "Invalid event batch");
    const ids = new Set<string>();
    for (const item of data.events) {
        const event = validateDeviceEvent(item);
        const id = event.eventId.toLowerCase();
        if (ids.has(id)) fail("events", "Duplicate event ID in batch");
        ids.add(id);
    }
    return data as unknown as ManagementCheckin;
}
