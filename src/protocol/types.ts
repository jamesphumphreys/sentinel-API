
export const PROTOCOL_VERSION = 1 as const;

export type ProtocolVersion = typeof PROTOCOL_VERSION;

export type DeviceType =
    | "BayMonitor"
    | "DamMonitor"
    | "PumpMonitor"
    | "FenceMonitor";

// Device lifecycle

export type ProvisioningStatus =
    | "Pending"
    | "Approved"
    | "Confirmed"
    | "Rejected";

export type AllocationStatus = "Inventory" | "Allocated";

export type DeploymentStatus = "Undeployed" | "Deployed";

export type LifecycleStatus = "Active" | "Retired";

export interface DeviceLifecycle {
    provisioningStatus: ProvisioningStatus;
    allocationStatus: AllocationStatus;
    deploymentStatus: DeploymentStatus;
    lifecycleStatus: LifecycleStatus;
}

// Device identity and capabilities

export interface DeviceIdentity {
    serialNumber: string;
    fingerprint: string;
}

export type DeviceAction =
    | "DEVICE_RESTART"
    | "DEVICE_IDENTIFY"
    | "DEVICE_IDENTIFY_CANCEL"
    | "PUMP_STOP";

export interface CapabilityManifest {
    profileVersion: number;
    features: string[];
    inputs: string[];
    outputs: string[];
    actions: DeviceAction[];
}

export interface DeviceManifest {
    protocolVersion: ProtocolVersion;
    firmwareVersion: string;
    hardwareModel: string;
    hardwareRevision: string;
    deviceType: DeviceType;
    capabilities: CapabilityManifest;
}

export interface ProvisioningChallengeRequest
    extends DeviceManifest {
    publicKey: string;
}

export interface ProvisioningProofRequest {
    challenge: string;
    signature: string;
    fingerprint: string;
}

// Common message envelope

export interface MessageEnvelope {
    protocolVersion: ProtocolVersion;
    messageId: string;
    bootId: string;
    sequence: number;
}

// Sensor and output values

export type SensorValue =
    | number
    | boolean
    | string
    | null;

export type OutputValue = boolean | string | number;

export interface OutputState {
    commandedState: OutputValue | null;
    observedState: OutputValue | null;
}

export interface DeviceHealth {
    uptimeSeconds?: number | null;
    batteryVoltageMv?: number | null;
    solarVoltageMv?: number | null;
    latitude?: number | null;
    longitude?: number | null;
    altitude?: number | null;
    csq?: number | null;
    rssi?: number | null;
    rsrp?: number | null;
    rsrq?: number | null;
    networkTechnology?: string | null;
    networkBand?: string | null;
    operatorCode?: string | null;
    operatorName?: string | null;
    gnssFixType?: string | null;
    gnssElapsedSeconds?: number | null;
}

export interface TelemetryMessage extends MessageEnvelope {
    sampledAt: string | null;
    health: DeviceHealth;
    inputs: Record<string, SensorValue>;
    outputs: Record<string, OutputState>;
}

// Persistent device configuration

export type DesiredPowerState = "ON" | "OFF";

export type DevicePowerMode =
    | "Active"
    | "Standby"
    | "BatteryLockout"
    | "TimedOff"
    | "Unknown";

export interface DeviceConfiguration {
    revision: number;
    desiredPowerState: DesiredPowerState;
    telemetryIntervalSeconds: number;
    powerOffCheckIntervalSeconds: number;
    gpsEnabled?: boolean;
    profileSettings: Record<string, SensorValue>;
}

// Commands

export type CommandStatus =
    | "Queued"
    | "Delivered"
    | "Accepted"
    | "Applied"
    | "Confirmed"
    | "Failed"
    | "Rejected"
    | "Expired"
    | "Cancelled";

export interface CommandParameters {
    DEVICE_RESTART: Record<string, never>;
    DEVICE_IDENTIFY: {
        durationSeconds?: number;
    };
    DEVICE_IDENTIFY_CANCEL: Record<string, never>;
    PUMP_STOP: Record<string, never>;
}

export interface CommandTarget extends DeviceIdentity {
    deploymentRevision: number;
}

export interface CommandEnvelope {
    commandId: string;
    issuedAt: string;
    expiresAt: string;
    target: CommandTarget;
}

export type DeviceCommand = {
    [Action in DeviceAction]: CommandEnvelope & {
        type: Action;
        parameters: CommandParameters[Action];
    };
}[DeviceAction];

// Device events

export type DeviceEventType =
    | "BOOT"
    | "COMMAND_ACCEPTED"
    | "COMMAND_APPLIED"
    | "COMMAND_CONFIRMED"
    | "COMMAND_FAILED"
    | "COMMAND_REJECTED"
    | "COMMAND_CANCELLED"
    | "CONFIGURATION_APPLIED"
    | "CONFIGURATION_REJECTED"
    | "IDENTIFY_STARTED"
    | "IDENTIFY_COMPLETED"
    | "IDENTIFY_CANCELLED"
    | "OUTPUT_STATE_CHANGED"
    | "SENSOR_FAULT"
    | "POWER_STATE_CHANGED";

export interface DeviceEvent {
    eventId: string;
    type: DeviceEventType;
    commandId?: string;
    occurredAt: string | null;
    details: Record<string, SensorValue>;
}

// Management check-in

export interface ManagementCheckin extends MessageEnvelope {
    firmwareVersion: string;
    resetReason: string | null;
    wakeReason: string | null;
    powerMode: DevicePowerMode;
    appliedConfigurationRevision: number;
    capabilityProfileRevision: number;
    health: DeviceHealth;
    events: DeviceEvent[];
}

export interface ManagementResponse {
    protocolVersion: ProtocolVersion;
    serverTime: string;
    acknowledgedEventIds: string[];
    desiredConfiguration: DeviceConfiguration;
    commands: DeviceCommand[];
    nextCheckinSeconds: number;
}

// Protocol limits

export const PROTOCOL_LIMITS = {
    maxRequestBytes: 16384,
    maxEventsPerBatch: 32,
    deduplicationRetentionDays: 7,
    identifyDefaultSeconds: 10,
    identifyMaximumSeconds: 60,
    identifyExpirySeconds: 30
} as const;
