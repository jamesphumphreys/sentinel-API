const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const {
    validateDeviceHealth,
    validateDeviceEvent,
    validateManagementCheckin,
    ProtocolValidationError
} = require('../dist/src/protocol/validation.js');

function event(overrides = {}) {
    return {
        eventId: randomUUID(),
        type: 'BOOT',
        occurredAt: null,
        details: {},
        ...overrides
    };
}

function checkin(overrides = {}) {
    return {
        protocolVersion: 1,
        messageId: randomUUID(),
        bootId: randomUUID(),
        sequence: 0,
        firmwareVersion: 'simulator-0.2.0',
        resetReason: 'PowerOn',
        wakeReason: null,
        powerMode: 'Active',
        appliedConfigurationRevision: 1,
        capabilityProfileRevision: 1,
        health: {
            uptimeSeconds: 30,
            batteryVoltageMv: 4190,
            solarVoltageMv: 280,
            rsrp: -100
        },
        events: [],
        ...overrides
    };
}

// Device health

test('Accept valid device health', () => {
    assert.doesNotThrow(() =>
        validateDeviceHealth(checkin().health)
    );
});

test('Accept empty device health', () => {
    assert.doesNotThrow(() =>
        validateDeviceHealth({})
    );
});

test('Accept unavailable health measurements', () => {
    assert.doesNotThrow(() =>
        validateDeviceHealth({
            batteryVoltageMv: null,
            solarVoltageMv: null,
            latitude: null,
            longitude: null
        })
    );
});

test('Accept 12V and 24V battery systems', () => {
    for (const voltage of [12800, 25600]) {
        assert.doesNotThrow(() =>
            validateDeviceHealth({
                batteryVoltageMv: voltage
            })
        );
    }
});

test('Reject negative battery voltage', () => {
    assert.throws(() =>
        validateDeviceHealth({
            batteryVoltageMv: -100
        }),
        ProtocolValidationError
    );
});

test('Reject non-finite health measurement', () => {
    assert.throws(() =>
        validateDeviceHealth({ rsrp: Infinity }),
        ProtocolValidationError
    );
});

test('Reject incorrect health measurement type', () => {
    assert.throws(() =>
        validateDeviceHealth({
            batteryVoltageMv: '4190'
        }),
        ProtocolValidationError
    );
});

test('Accept valid GPS coordinates', () => {
    assert.doesNotThrow(() =>
        validateDeviceHealth({
            latitude: -37.5,
            longitude: 145.1
        })
    );
});

test('Reject incomplete GPS coordinates', () => {
    assert.throws(() =>
        validateDeviceHealth({
            latitude: -37.5
        }),
        ProtocolValidationError
    );
});

test('Reject invalid latitude', () => {
    assert.throws(() =>
        validateDeviceHealth({
            latitude: 91,
            longitude: 145
        }),
        ProtocolValidationError
    );
});

test('Reject unknown health field', () => {
    assert.throws(() =>
        validateDeviceHealth({
            unexpectedMeasurement: 123
        }),
        ProtocolValidationError
    );
});

test('Accept valid mobile operator code', () => {
    assert.doesNotThrow(() =>
        validateDeviceHealth({
            operatorCode: '50502'
        })
    );
});

test('Reject invalid mobile operator code', () => {
    assert.throws(() =>
        validateDeviceHealth({
            operatorCode: 'OPTUS'
        }),
        ProtocolValidationError
    );
});

// Device events

test('Accept boot event', () => {
    assert.doesNotThrow(() =>
        validateDeviceEvent(event())
    );
});

test('Accept command acknowledgement event', () => {
    assert.doesNotThrow(() =>
        validateDeviceEvent(event({
            type: 'COMMAND_APPLIED',
            commandId: randomUUID()
        }))
    );
});

test('Reject command event without command ID', () => {
    assert.throws(() =>
        validateDeviceEvent(event({
            type: 'COMMAND_APPLIED'
        })),
        ProtocolValidationError
    );
});

test('Reject invalid event ID', () => {
    assert.throws(() =>
        validateDeviceEvent(event({
            eventId: 'invalid'
        })),
        ProtocolValidationError
    );
});

test('Reject unknown event type', () => {
    assert.throws(() =>
        validateDeviceEvent(event({
            type: 'UNKNOWN_EVENT'
        })),
        ProtocolValidationError
    );
});

test('Accept scalar event details', () => {
    assert.doesNotThrow(() =>
        validateDeviceEvent(event({
            details: {
                reason: 'PowerOn',
                voltage: 4190,
                recovered: true,
                previousState: null
            }
        }))
    );
});

test('Reject nested event details', () => {
    assert.throws(() =>
        validateDeviceEvent(event({
            details: {
                nested: { value: 1 }
            }
        })),
        ProtocolValidationError
    );
});

test('Accept event with UTC timestamp', () => {
    assert.doesNotThrow(() =>
        validateDeviceEvent(event({
            occurredAt: '2026-11-28T09:00:00Z'
        }))
    );
});

test('Reject invalid event timestamp', () => {
    assert.throws(() =>
        validateDeviceEvent(event({
            occurredAt: 'yesterday'
        })),
        ProtocolValidationError
    );
});

// Management check-in

test('Accept valid management check-in', () => {
    assert.deepEqual(
        validateManagementCheckin(checkin({
            powerMode: 'Active'
        })).powerMode,
        'Active'
    );
});

test('Accept all defined device power modes', () => {
    for (const powerMode of [
        'Active',
        'Standby',
        'BatteryLockout',
        'TimedOff',
        'Unknown'
    ]) {
        assert.doesNotThrow(() =>
            validateManagementCheckin(
                checkin({ powerMode })
            )
        );
    }
});

test('Reject unsupported power mode', () => {
    assert.throws(() =>
        validateManagementCheckin(checkin({
            powerMode: 'Shutdown'
        })),
        ProtocolValidationError
    );
});

test('Accept device without applied configuration', () => {
    assert.doesNotThrow(() =>
        validateManagementCheckin(checkin({
            appliedConfigurationRevision: 0
        }))
    );
});

test('Reject negative configuration revision', () => {
    assert.throws(() =>
        validateManagementCheckin(checkin({
            appliedConfigurationRevision: -1
        })),
        ProtocolValidationError
    );
});

test('Reject invalid capability revision', () => {
    assert.throws(() =>
        validateManagementCheckin(checkin({
            capabilityProfileRevision: 0
        })),
        ProtocolValidationError
    );
});

test('Reject missing firmware version', () => {
    const message = checkin();
    delete message.firmwareVersion;

    assert.throws(() =>
        validateManagementCheckin(message),
        ProtocolValidationError
    );
});

test('Accept maximum event batch', () => {
    assert.doesNotThrow(() =>
        validateManagementCheckin(checkin({
            events: Array.from(
                { length: 32 },
                () => event()
            )
        }))
    );
});

test('Reject oversized event batch', () => {
    assert.throws(() =>
        validateManagementCheckin(checkin({
            events: Array.from(
                { length: 33 },
                () => event()
            )
        })),
        ProtocolValidationError
    );
});

test('Reject duplicate event IDs', () => {
    const duplicate = event();

    assert.throws(() =>
        validateManagementCheckin(checkin({
            events: [duplicate, duplicate]
        })),
        ProtocolValidationError
    );
});

test('Reject case-insensitive duplicate event IDs', () => {
    const original = event({
        eventId: 'abcdef01-1234-4567-89ab-abcdef123456'
    });

    assert.throws(() =>
        validateManagementCheckin(checkin({
            events: [
                original,
                {
                    ...original,
                    eventId: original.eventId.toUpperCase()
                }
            ]
        })),
        ProtocolValidationError
    );
});

test('Reject unknown management message field', () => {
    assert.throws(() =>
        validateManagementCheckin(checkin({
            unexpectedField: true
        })),
        ProtocolValidationError
    );
});

test('Reject unsupported management protocol version', () => {
    assert.throws(() =>
        validateManagementCheckin(checkin({
            protocolVersion: 2
        })),
        ProtocolValidationError
    );
});