
import {
    DeviceType,
    DeviceAction,
    OutputValue,
    PROTOCOL_LIMITS
} from "./types";

export type SensorDataType =
    | "number"
    | "boolean"
    | "string";

export interface SensorDefinition {
    label: string;
    dataType: SensorDataType;
    unit?: string;
    minimum?: number;
    maximum?: number;
    integer?: boolean;
}

export interface OutputDefinition {
    label: string;
    mode: "Timed" | "Persistent";
    allowedStates: readonly OutputValue[];
    defaultState: OutputValue | null;
    feedbackSupported: boolean;
    maximumDurationSeconds?: number;
    localRearmRequired?: boolean;
}

export interface ActionDefinition {
    requiredFeatures: readonly string[];
    requiredInputs?: readonly string[];
    requiredOutputs?: readonly string[];
    expirySeconds?: number;
    localInterlockRequired: boolean;
    confirmationRequired: boolean;
}

export interface DeviceProfile {
    deviceType: DeviceType;
    displayName: string;
    profileVersion: number;
    features: readonly string[];
    inputs: Readonly<Record<string, SensorDefinition>>;
    outputs: Readonly<Record<string, OutputDefinition>>;
    actions: Readonly<
        Partial<Record<DeviceAction, ActionDefinition>>
    >;
}

const COMMON_FEATURES = [
    "remoteRestart",
    "batteryMonitoring",
    "solarMonitoring",
    "powerManagement"
] as const;

const RESTART_ACTION: ActionDefinition = {
    requiredFeatures: ["remoteRestart"],
    localInterlockRequired: false,
    confirmationRequired: true
};

export const DEVICE_PROFILES: Readonly<
    Record<DeviceType, DeviceProfile>
> = {
    BayMonitor: {
        deviceType: "BayMonitor",
        displayName: "Bay Monitor",
        profileVersion: 1,

        features: [
            ...COMMON_FEATURES,
            "gps",
            "identify"
        ],

        inputs: {
            waterDetected: {
                label: "Water detected",
                dataType: "boolean"
            }
        },

        outputs: {
            siren: {
                label: "Identification siren",
                mode: "Timed",
                allowedStates: [true, false],
                defaultState: false,
                feedbackSupported: false,
                maximumDurationSeconds:
                    PROTOCOL_LIMITS.identifyMaximumSeconds
            }
        },

        actions: {
            DEVICE_RESTART: RESTART_ACTION,

            DEVICE_IDENTIFY: {
                requiredFeatures: ["identify"],
                requiredOutputs: ["siren"],
                expirySeconds:
                    PROTOCOL_LIMITS.identifyExpirySeconds,
                localInterlockRequired: false,
                confirmationRequired: false
            },

            DEVICE_IDENTIFY_CANCEL: {
                requiredFeatures: ["identify"],
                requiredOutputs: ["siren"],
                expirySeconds:
                    PROTOCOL_LIMITS.identifyExpirySeconds,
                localInterlockRequired: false,
                confirmationRequired: false
            }
        }
    },

    DamMonitor: {
        deviceType: "DamMonitor",
        displayName: "Dam Monitor",
        profileVersion: 1,

        features: [
            ...COMMON_FEATURES,
            "gps"
        ],

        inputs: {
            waterLevel: {
                label: "Water level",
                dataType: "number",
                unit: "mm"
            }
        },

        outputs: {},

        actions: {
            DEVICE_RESTART: RESTART_ACTION
        }
    },

    PumpMonitor: {
        deviceType: "PumpMonitor",
        displayName: "Pump Monitor",
        profileVersion: 1,

        features: [
            ...COMMON_FEATURES,
            "gps"
        ],

        inputs: {
            engineRunning: {
                label: "Engine running",
                dataType: "boolean"
            },

            fuelLevel: {
                label: "Fuel level",
                dataType: "number",
                unit: "%",
                minimum: 0,
                maximum: 100
            },

            fuelValveClosed: {
                label: "Fuel valve closed",
                dataType: "boolean"
            }
        },

        outputs: {
            fuelValve: {
                label: "Fuel shutoff valve",
                mode: "Persistent",
                allowedStates: ["Open", "Closed"],
                defaultState: null,
                feedbackSupported: true,
                localRearmRequired: true
            }
        },

        actions: {
            DEVICE_RESTART: {
                ...RESTART_ACTION,
                localInterlockRequired: true
            },

            PUMP_STOP: {
                requiredFeatures: [],
                requiredInputs: ["engineRunning"],
                requiredOutputs: ["fuelValve"],
                localInterlockRequired: true,
                confirmationRequired: true
            }
        }
    },

    FenceMonitor: {
        deviceType: "FenceMonitor",
        displayName: "Fence Monitor",
        profileVersion: 1,

        features: [
            ...COMMON_FEATURES,
            "gps"
        ],

        inputs: {
            fenceVoltage: {
                label: "Fence voltage",
                dataType: "number",
                unit: "V",
                minimum: 0
            }
        },

        outputs: {},

        actions: {
            DEVICE_RESTART: RESTART_ACTION
        }
    }
};

export function isDeviceType(
    value: unknown
): value is DeviceType {
    return (
        typeof value === "string" &&
        Object.prototype.hasOwnProperty.call(
            DEVICE_PROFILES,
            value
        )
    );
}

export function getDeviceProfile(
    deviceType: DeviceType
): DeviceProfile {
    if (!isDeviceType(deviceType)) {
        throw new Error(
            `Unsupported device type: ${deviceType}`
        );
    }

    return DEVICE_PROFILES[deviceType];
}
