
const test = require("node:test");
const assert = require("node:assert/strict");

const {
    PROTOCOL_VERSION,
    PROTOCOL_LIMITS
} = require("../dist/src/protocol/types.js");

const {
    DEVICE_PROFILES,
    getDeviceProfile,
    isDeviceType
} = require("../dist/src/protocol/profiles.js");

const {
    validateSerialNumber,
    validateFingerprint,
    validateDeviceManifest,
    validateCapabilities,
    validateMessageEnvelope,
    validateInputs,
    validateOutputs,
    validateLifecycle,
    validateCommand
} = require("../dist/src/protocol/validation.js");

const { randomUUID } = require("node:crypto");

const SERIAL = "020000000001";
const FINGERPRINT = "a".repeat(64);

const NOW = Date.parse("2026-11-28T08:00:00Z");

// Test fixtures

function bayCapabilities(withSiren = true) {
    return {
        profileVersion: 1,
        features: [
            "remoteRestart",
            "batteryMonitoring",
            "gps",
            ...(withSiren ? ["identify"] : [])
        ],
        inputs: ["waterDetected"],
        outputs: withSiren ? ["siren"] : [],
        actions: [
            "DEVICE_RESTART",
            ...(withSiren
                ? ["DEVICE_IDENTIFY", "DEVICE_IDENTIFY_CANCEL"]
                : [])
        ]
    };
}

function pumpCapabilities() {
    return {
        profileVersion: 1,
        features: [
            "remoteRestart",
            "batteryMonitoring",
            "solarMonitoring"
        ],
        inputs: [
            "engineRunning",
            "fuelLevel",
            "fuelValveClosed"
        ],
        outputs: ["fuelValve"],
        actions: ["DEVICE_RESTART", "PUMP_STOP"]
    };
}

function manifest(overrides = {}) {
    return {
        protocolVersion: PROTOCOL_VERSION,
        firmwareVersion: "simulator-0.1.0",
        hardwareModel: "Sentinel Simulator",
        hardwareRevision: "1",
        deviceType: "BayMonitor",
        capabilities: bayCapabilities(),
        ...overrides
    };
}

function command(type, parameters = {}, overrides = {}) {
    return {
        commandId: randomUUID(),
        type,
        issuedAt: new Date(NOW).toISOString(),
        expiresAt: new Date(NOW + 30000).toISOString(),
        target: {
            serialNumber: SERIAL,
            fingerprint: FINGERPRINT,
            deploymentRevision: 1
        },
        parameters,
        ...overrides
    };
}

function lifecycle(overrides = {}) {
    return {
        provisioningStatus: "Confirmed",
        allocationStatus: "Inventory",
        deploymentStatus: "Undeployed",
        lifecycleStatus: "Active",
        ...overrides
    };
}

// Identity

test("Accept valid hardware serial", () => {
    assert.equal(validateSerialNumber(SERIAL), SERIAL);
});

test("Reject legacy serial", () => {
    assert.throws(() => validateSerialNumber("0000001"));
});

test("Reject lowercase hardware serial", () => {
    assert.throws(() => validateSerialNumber("1c8f571f4d1c"));
});

test("Reject non-hexadecimal hardware serial", () => {
    assert.throws(() => validateSerialNumber("ZZ0000000001"));
});

test("Accept valid SHA-256 fingerprint", () => {
    assert.equal(
        validateFingerprint(FINGERPRINT),
        FINGERPRINT
    );
});

test("Reject invalid fingerprint", () => {
    assert.throws(() => validateFingerprint("abc123"));
});

// Device profiles

test("All four device profiles exist", () => {
    assert.equal(Object.keys(DEVICE_PROFILES).length, 4);

    for (const type of [
        "BayMonitor",
        "DamMonitor",
        "PumpMonitor",
        "FenceMonitor"
    ]) {
        assert.equal(getDeviceProfile(type).deviceType, type);
    }
});

test("Reject unsupported device type", () => {
    assert.equal(isDeviceType("UnknownMonitor"), false);
    assert.equal(isDeviceType("__proto__"), false);
    assert.throws(() => getDeviceProfile("UnknownMonitor"));
});

test("Accept valid BayMonitor manifest", () => {
    const result = validateDeviceManifest(manifest());

    assert.equal(result.deviceType, "BayMonitor");
    assert.equal(result.protocolVersion, 1);
});

test("Reject unsupported protocol version", () => {
    assert.throws(() =>
        validateDeviceManifest(
            manifest({ protocolVersion: 99 })
        )
    );
});

test("Reject unsupported profile version", () => {
    const capabilities = bayCapabilities();
    capabilities.profileVersion = 99;

    assert.throws(() =>
        validateCapabilities("BayMonitor", capabilities)
    );
});

test("Accept BayMonitor without siren", () => {
    assert.doesNotThrow(() =>
        validateCapabilities(
            "BayMonitor",
            bayCapabilities(false)
        )
    );
});

test("Reject BayMonitor declaring a fuel valve", () => {
    const capabilities = bayCapabilities();
    capabilities.outputs.push("fuelValve");

    assert.throws(() =>
        validateCapabilities("BayMonitor", capabilities)
    );
});

test("Reject identification action without siren", () => {
    const capabilities = bayCapabilities();
    capabilities.outputs = [];

    assert.throws(() =>
        validateCapabilities("BayMonitor", capabilities)
    );
});

test("Reject duplicate capabilities", () => {
    const capabilities = bayCapabilities();
    capabilities.features.push("gps");

    assert.throws(() =>
        validateCapabilities("BayMonitor", capabilities)
    );
});

test("Accept PumpMonitor capabilities", () => {
    assert.doesNotThrow(() =>
        validateCapabilities(
            "PumpMonitor",
            pumpCapabilities()
        )
    );
});

test("Reject pump stop without engine feedback", () => {
    const capabilities = pumpCapabilities();

    capabilities.inputs = capabilities.inputs.filter(
        input => input !== "engineRunning"
    );

    assert.throws(() =>
        validateCapabilities("PumpMonitor", capabilities)
    );
});

// Message envelope

test("Accept valid message envelope", () => {
    assert.doesNotThrow(() =>
        validateMessageEnvelope({
            protocolVersion: 1,
            messageId: randomUUID(),
            bootId: randomUUID(),
            sequence: 0
        })
    );
});

test("Reject negative message sequence", () => {
    assert.throws(() =>
        validateMessageEnvelope({
            protocolVersion: 1,
            messageId: randomUUID(),
            bootId: randomUUID(),
            sequence: -1
        })
    );
});

// Sensor inputs

test("Accept valid pump measurements", () => {
    assert.doesNotThrow(() =>
        validateInputs(
            "PumpMonitor",
            pumpCapabilities(),
            {
                engineRunning: true,
                fuelLevel: 75,
                fuelValveClosed: false
            }
        )
    );
});

test("Accept unavailable measurement", () => {
    assert.doesNotThrow(() =>
        validateInputs(
            "PumpMonitor",
            pumpCapabilities(),
            { fuelLevel: null }
        )
    );
});

test("Reject fuel level above 100 percent", () => {
    assert.throws(() =>
        validateInputs(
            "PumpMonitor",
            pumpCapabilities(),
            { fuelLevel: 150 }
        )
    );
});

test("Reject negative fuel level", () => {
    assert.throws(() =>
        validateInputs(
            "PumpMonitor",
            pumpCapabilities(),
            { fuelLevel: -1 }
        )
    );
});

test("Reject incorrect sensor data type", () => {
    assert.throws(() =>
        validateInputs(
            "PumpMonitor",
            pumpCapabilities(),
            { engineRunning: "yes" }
        )
    );
});

test("Reject non-finite measurement", () => {
    assert.throws(() =>
        validateInputs(
            "PumpMonitor",
            pumpCapabilities(),
            { fuelLevel: Infinity }
        )
    );
});

test("Reject unauthorised sensor", () => {
    assert.throws(() =>
        validateInputs(
            "BayMonitor",
            bayCapabilities(),
            { fuelLevel: 50 }
        )
    );
});

// Physical outputs

test("Accept commanded siren state", () => {
    assert.doesNotThrow(() =>
        validateOutputs(
            "BayMonitor",
            bayCapabilities(),
            {
                siren: {
                    commandedState: true,
                    observedState: null
                }
            }
        )
    );
});

test("Reject unsupported siren feedback", () => {
    assert.throws(() =>
        validateOutputs(
            "BayMonitor",
            bayCapabilities(),
            {
                siren: {
                    commandedState: true,
                    observedState: true
                }
            }
        )
    );
});

test("Reject undeclared physical output", () => {
    assert.throws(() =>
        validateOutputs(
            "BayMonitor",
            bayCapabilities(false),
            {
                siren: {
                    commandedState: true,
                    observedState: null
                }
            }
        )
    );
});

test("Accept pump valve state and feedback", () => {
    assert.doesNotThrow(() =>
        validateOutputs(
            "PumpMonitor",
            pumpCapabilities(),
            {
                fuelValve: {
                    commandedState: "Closed",
                    observedState: "Open"
                }
            }
        )
    );
});

// Device lifecycle

test("Accept confirmed device in inventory", () => {
    assert.doesNotThrow(() =>
        validateLifecycle(lifecycle())
    );
});

test("Accept allocated but undeployed device", () => {
    assert.doesNotThrow(() =>
        validateLifecycle(
            lifecycle({ allocationStatus: "Allocated" })
        )
    );
});

test("Accept deployed device", () => {
    assert.doesNotThrow(() =>
        validateLifecycle(
            lifecycle({
                allocationStatus: "Allocated",
                deploymentStatus: "Deployed"
            })
        )
    );
});

test("Reject allocation before provisioning confirmation", () => {
    assert.throws(() =>
        validateLifecycle(
            lifecycle({
                provisioningStatus: "Approved",
                allocationStatus: "Allocated"
            })
        )
    );
});

test("Reject deployment without allocation", () => {
    assert.throws(() =>
        validateLifecycle(
            lifecycle({ deploymentStatus: "Deployed" })
        )
    );
});

test("Reject allocated retired device", () => {
    assert.throws(() =>
        validateLifecycle(
            lifecycle({
                allocationStatus: "Allocated",
                lifecycleStatus: "Retired"
            })
        )
    );
});

// Commands

test("Accept remote restart", () => {
    assert.doesNotThrow(() =>
        validateCommand(
            "BayMonitor",
            bayCapabilities(),
            command("DEVICE_RESTART"),
            NOW
        )
    );
});

test("Apply default identification duration", () => {
    const result = validateCommand(
        "BayMonitor",
        bayCapabilities(),
        command("DEVICE_IDENTIFY"),
        NOW
    );

    assert.equal(
        result.parameters.durationSeconds,
        PROTOCOL_LIMITS.identifyDefaultSeconds
    );
});

test("Accept maximum identification duration", () => {
    assert.doesNotThrow(() =>
        validateCommand(
            "BayMonitor",
            bayCapabilities(),
            command("DEVICE_IDENTIFY", {
                durationSeconds: 60
            }),
            NOW
        )
    );
});

test("Reject excessive identification duration", () => {
    assert.throws(() =>
        validateCommand(
            "BayMonitor",
            bayCapabilities(),
            command("DEVICE_IDENTIFY", {
                durationSeconds: 300
            }),
            NOW
        )
    );
});

test("Reject identification without siren capability", () => {
    assert.throws(() =>
        validateCommand(
            "BayMonitor",
            bayCapabilities(false),
            command("DEVICE_IDENTIFY"),
            NOW
        )
    );
});

test("Accept identification cancellation", () => {
    assert.doesNotThrow(() =>
        validateCommand(
            "BayMonitor",
            bayCapabilities(),
            command("DEVICE_IDENTIFY_CANCEL"),
            NOW
        )
    );
});

test("Reject expired command", () => {
    assert.throws(() =>
        validateCommand(
            "BayMonitor",
            bayCapabilities(),
            command("DEVICE_IDENTIFY", {}, {
                issuedAt: new Date(NOW - 60000).toISOString(),
                expiresAt: new Date(NOW - 30000).toISOString()
            }),
            NOW
        )
    );
});

test("Reject excessive command lifetime", () => {
    assert.throws(() =>
        validateCommand(
            "BayMonitor",
            bayCapabilities(),
            command("DEVICE_IDENTIFY", {}, {
                expiresAt: new Date(NOW + 60000).toISOString()
            }),
            NOW
        )
    );
});

test("Accept pump stop command", () => {
    assert.doesNotThrow(() =>
        validateCommand(
            "PumpMonitor",
            pumpCapabilities(),
            command("PUMP_STOP"),
            NOW
        )
    );
});

test("Reject remote pump start", () => {
    assert.throws(() =>
        validateCommand(
            "PumpMonitor",
            pumpCapabilities(),
            command("PUMP_START"),
            NOW
        )
    );
});

test("Reject arbitrary output control", () => {
    assert.throws(() =>
        validateCommand(
            "PumpMonitor",
            pumpCapabilities(),
            command("SET_OUTPUT", {
                output: "fuelValve",
                state: "Open"
            }),
            NOW
        )
    );
});

test("Reject unexpected command parameters", () => {
    assert.throws(() =>
        validateCommand(
            "PumpMonitor",
            pumpCapabilities(),
            command("PUMP_STOP", {
                reopenAfterSeconds: 60
            }),
            NOW
        )
    );
});
