const test = require('node:test');
const assert = require('node:assert/strict');

const {
    isCommandStatus,
    isTerminalCommandStatus,
    canTransitionCommand,
    commandStatusForEvent
} = require('../dist/src/devices/commandTransitions.js');

const statuses = [
    'Queued',
    'Delivered',
    'Accepted',
    'Applied',
    'Confirmed',
    'Failed',
    'Rejected',
    'Expired',
    'Cancelled'
];

const terminalStatuses = [
    'Confirmed',
    'Failed',
    'Rejected',
    'Expired',
    'Cancelled'
];

test('Recognise all nine command statuses', () => {
    for (const status of statuses) {
        assert.equal(isCommandStatus(status), true);
    }
});

test('Reject invalid command statuses', () => {
    for (const status of [
        'Unknown', 'queued', null, undefined, 123, 'constructor'
    ]) {
        assert.equal(isCommandStatus(status), false);
    }
});

test('Recognise terminal command statuses', () => {
    for (const status of statuses) {
        assert.equal(
            isTerminalCommandStatus(status),
            terminalStatuses.includes(status)
        );
    }
});

test('Allow normal command lifecycle', () => {
    const lifecycle = [
        'Queued',
        'Delivered',
        'Accepted',
        'Applied',
        'Confirmed'
    ];

    for (let i = 0; i < lifecycle.length - 1; i++) {
        assert.equal(
            canTransitionCommand(
                lifecycle[i],
                lifecycle[i + 1]
            ),
            true
        );
    }
});

test('Allow direct delivery to application', () => {
    assert.equal(
        canTransitionCommand('Delivered', 'Applied'),
        true
    );
});

test('Reject application before delivery', () => {
    assert.equal(
        canTransitionCommand('Queued', 'Applied'),
        false
    );
});

test('Reject confirmation before application', () => {
    for (const status of [
        'Queued', 'Delivered', 'Accepted'
    ]) {
        assert.equal(
            canTransitionCommand(status, 'Confirmed'),
            false
        );
    }
});

test('Reject backwards command transitions', () => {
    assert.equal(
        canTransitionCommand('Applied', 'Accepted'),
        false
    );

    assert.equal(
        canTransitionCommand('Accepted', 'Delivered'),
        false
    );

    assert.equal(
        canTransitionCommand('Delivered', 'Queued'),
        false
    );
});

test('Allow repeated status idempotently', () => {
    for (const status of statuses) {
        assert.equal(
            canTransitionCommand(status, status),
            true
        );
    }
});

test('Reject changes to terminal command statuses', () => {
    for (const current of terminalStatuses) {
        for (const next of statuses) {
            assert.equal(
                canTransitionCommand(current, next),
                current === next
            );
        }
    }
});

test('Allow expiry before application', () => {
    for (const status of [
        'Queued', 'Delivered', 'Accepted'
    ]) {
        assert.equal(
            canTransitionCommand(status, 'Expired'),
            true
        );
    }
});

test('Reject expiry after application', () => {
    assert.equal(
        canTransitionCommand('Applied', 'Expired'),
        false
    );
});

test('Allow cancellation before application', () => {
    for (const status of [
        'Queued', 'Delivered', 'Accepted'
    ]) {
        assert.equal(
            canTransitionCommand(status, 'Cancelled'),
            true
        );
    }
});

test('Reject cancellation after application', () => {
    assert.equal(
        canTransitionCommand('Applied', 'Cancelled'),
        false
    );
});

test('Allow failure after delivery or application', () => {
    for (const status of [
        'Delivered', 'Accepted', 'Applied'
    ]) {
        assert.equal(
            canTransitionCommand(status, 'Failed'),
            true
        );
    }
});

test('Allow device rejection before application', () => {
    for (const status of ['Delivered', 'Accepted']) {
        assert.equal(
            canTransitionCommand(status, 'Rejected'),
            true
        );
    }
});

test('Reject invalid transition arguments', () => {
    assert.equal(
        canTransitionCommand('Unknown', 'Applied'),
        false
    );

    assert.equal(
        canTransitionCommand('Queued', 'Unknown'),
        false
    );
});

test('Map command events to command statuses', () => {
    const mappings = {
        COMMAND_ACCEPTED: 'Accepted',
        COMMAND_APPLIED: 'Applied',
        COMMAND_CONFIRMED: 'Confirmed',
        COMMAND_FAILED: 'Failed',
        COMMAND_REJECTED: 'Rejected',
        COMMAND_CANCELLED: 'Cancelled'
    };

    for (const [event, status] of Object.entries(mappings)) {
        assert.equal(
            commandStatusForEvent(event),
            status
        );
    }
});

test('Boot event does not automatically confirm restart', () => {
    assert.equal(
        commandStatusForEvent('BOOT'),
        undefined
    );
});

test('Unrelated events do not change command status', () => {
    for (const event of [
        'CONFIGURATION_APPLIED',
        'CONFIGURATION_REJECTED',
        'IDENTIFY_STARTED',
        'IDENTIFY_COMPLETED',
        'IDENTIFY_CANCELLED',
        'OUTPUT_STATE_CHANGED',
        'SENSOR_FAULT',
        'POWER_STATE_CHANGED'
    ]) {
        assert.equal(
            commandStatusForEvent(event),
            undefined
        );
    }
});
