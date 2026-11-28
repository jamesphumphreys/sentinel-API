# Sentinel Device Protocol v1

Status: proposed normative contract, revision 0.2. Not yet implemented or deployed.

## Identity and lifecycle

Hardware serial: 12 uppercase hexadecimal characters, immutable. Identity is serial plus SHA-256 fingerprint of P-256 SPKI DER public key. Keep existing challenge signature format `SENTINEL-PROVISION-V1\n<serial>\n<challenge>` and TLS credential header `x-sentinel-device-key`. Never log credentials. Only authorised serials may enrol; authorisations are administrator-managed, expirable and audited. A valid proof establishes possession of a key, not hardware authenticity. Device-reported metadata is untrusted until approved. Bind metadata to the challenge record and retain the approved snapshot.

Provisioning states: Pending, Approved, Confirmed, Rejected. Credential revocation is a separate security state. Allocation: Inventory or Allocated. Deployment: Undeployed or Deployed. Lifecycle: Active or Retired. Operational state is derived independently from fresh observations. Only confirmed active devices can be allocated; only allocated devices can be deployed. Undeploy before deallocation; revoke credentials on retirement. Rejection persists by fingerprint across retries; administrator restore returns candidate to Pending. A different fingerprint for an existing serial must not replace its identity automatically. Approval is conditional on the candidate revision; credential confirmation must be idempotent. Do not expose credentials in admin listings.

## Transport and envelope

HTTPS JSON under `/api/device/v1/{serialNumber}`. Retain existing provisioning/challenge, provisioning/proof, provisioning/confirm, checkin and telemetry routes. `protocolVersion: 1` is required for new firmware and simulator messages; unsupported versions are rejected explicitly. Existing firmware must be migrated in coordination with the API. Future BLE/LoRa gateways relay authenticated device messages; gateway identity is not a substitute for device identity. Define compact encoding and end-to-end authentication before introducing those transports.

Check-in and telemetry carry a UUID messageId, UUID bootId and non-negative sequence number scoped to boot. Device timestamps are UTC ISO 8601 or null if unknown; server records receivedAt. Retries reuse messageId and identical payload. Duplicate IDs with different content are conflicts. Store deduplication records durably for at least the maximum accepted retry window; proposed 7 days. Older buffered samples may be stored as history but never replace newer live state or trigger control rules. Reject unknown fields except explicitly versioned extensions. Proposed request limit 16 KiB; bounded event batches of 32. No credentials in bodies or URLs.

## Provisioning metadata and capabilities

Challenge request adds protocolVersion, firmwareVersion, hardwareModel, hardwareRevision, deviceType and capabilities. Example capability manifest:

```json
{
  "profileVersion": 1,
  "features": ["remoteRestart", "batteryMonitoring"],
  "inputs": ["fuelLevel", "engineRunning", "batteryVoltage"],
  "outputs": ["fuelValve"],
  "actions": ["PUMP_STOP"]
}
```

API owns approved profile definitions, including data types, units, ranges, supported actions and verification rules. Device declarations may narrow a profile, never expand privileges. Capability changes require review before enabling new physical actions. isSimulated is administrator-controlled, not trusted from device. Simulation must use real provisioning and authentication, and cannot control physical equipment through automation by default.

Initial proposed profiles (hardware capabilities subject to validation):

| Profile | Inputs | Physical outputs | Actions |
|---|---|---|---|
| BayMonitor | waterDetected, GPS if fitted, health | siren | DEVICE_RESTART, DEVICE_IDENTIFY, DEVICE_IDENTIFY_CANCEL |
| DamMonitor | waterLevel, health | none | DEVICE_RESTART |
| PumpMonitor | engineRunning, fuelLevel if fitted, health, valve feedback if fitted | fuelValve | PUMP_STOP, DEVICE_RESTART subject to interlock |
| FenceMonitor | fenceVoltage, health | none | DEVICE_RESTART |

Common health measurements include batteryVoltageMv, solarVoltageMv, uptimeSeconds and network diagnostics. Define waterLevel in mm relative to a configured datum; fuelLevel in percent; fenceVoltage in volts. Unknown values are null, never zero by default. GPS coordinates must occur together. Preserve existing health field names where practical.

## Telemetry example

```json
{
  "protocolVersion": 1,
  "messageId": "a20b8f02-4b14-4bd8-bbca-ec82405f62ae",
  "bootId": "bfc46030-5ac2-4ad7-b91c-8b92dfbd1794",
  "sequence": 12,
  "sampledAt": "2026-11-28T07:00:00Z",
  "health": {"uptimeSeconds": 120, "batteryVoltageMv": 12400},
  "inputs": {"fuelLevel": 62, "engineRunning": true},
  "outputs": {"fuelValve": {"commandedState": "Closed", "observedState": null}}
}
```

Input values validated against approved profile and sensor quality; stale/invalid measurements cannot drive control. Store typed common health fields and bounded JSON for profile-specific values in Azure Tables. Use stable sample identity for retry deduplication, not a fresh random row key on every retry. Separate sample time from receipt time.

## Management and configuration

Check-in includes firmware version, boot ID, sequence, reset/wake reason, current power mode, applied configuration revision, capability profile revision, and durable events. Server response includes serverTime, acknowledgedEventIds, desired configuration with monotonic revision, pending commands and nextCheckinSeconds. Configuration includes desiredPowerState, telemetryIntervalSeconds, powerOffCheckIntervalSeconds, gpsEnabled when supported, and validated profile settings. Device reports applied revision or rejection reason. Do not conflate desired power with observed power. A pump controller must reject sleep/restart if unsafe while operating; maintain local stop capability.

## Commands and events

Commands have UUID commandId, type, parameters, issuedAt, expiresAt, and target identity/deployment revision. Server validates permissions, lifecycle, profile, and target before queueing. Device validates expiry using trustworthy time, target, profile and local interlocks. Reject unsafe or unknown commands; do not execute when expiry cannot be established. Durable command ledger prevents repeated execution across reboot; after interrupted action reconcile physical state before retry. Persistent settings are not commands. Remove DEVICE_SHUTDOWN; use desiredPowerState where supported.

Command states: Queued, Delivered, Accepted, Applied, Confirmed, Failed, Rejected, Expired, Cancelled. Delivered means offered in a response, not proof of receipt. Accepted is explicit device acknowledgement. Applied means action attempted successfully at controller level. Confirmed requires action-specific evidence. Expiry prevents new execution; it does not prove an already-started action failed. Late results are retained with timestamps and uncertainty. Cancellation cannot undo physical action. Events have stable eventId, type, commandId when relevant, occurredAt, and bounded typed details. Acknowledge only after durable storage; duplicates must not repeat side effects. Existing COMMAND_APPLIED and BOOT events can support restart confirmation after migration.

## Device identification

Identification is an optional, hardware-independent capability (`identify`). BayMonitor implements it using its siren; other approved profiles may use a buzzer or flashing light. Its purpose is physical location and confirmation of device identity, not theft detection.

`DEVICE_IDENTIFY` accepts `durationSeconds` (integer, default 10, proposed maximum 60). `DEVICE_IDENTIFY_CANCEL` stops active identification. The approved profile defines the physical mechanism and maximum duration; firmware independently enforces the limit. Identification commands have a short delivery expiry (proposed 30 seconds). Delivery expiry and activation duration are separate. A retry must not extend an existing activation. Cancellation must invalidate outstanding identification requests for the same target. The output defaults off on boot and must turn off locally at timeout even without connectivity. Do not persist an active siren state across reboot. Report activation and completion or cancellation as events correlated with the command ID. Without physical feedback, controller acknowledgement does not prove audible output; a person may confirm identity separately. Restrict commands to authorised operators and audit their use.

## Pump control and automation

Expose semantic PUMP_STOP, not arbitrary GPIO or generic remote valve-open. Manual local start/rearm only. Stop must latch locally; reconnect, reboot, command expiry or configuration change must not automatically reopen fuel supply. Report commanded valve state separately from actual feedback; absent feedback is unknown. Verify engine stopped with a validated vibration/running sensor and sustained stopped interval. Sensor failure or timeout yields unverified outcome and notification, not success. Hardware fail-safe behaviour, fuel-rated components and local emergency stop require validation before physical commissioning.

Automation evaluates fresh dam measurements, threshold and hysteresis, sensor quality, same-customer authorised device relationship and deployment revision. Issue one idempotent stop per rule episode; notify on failure or stale data. No automatic restart. Cloud automation is not a safety-rated protection system; local independent protection remains necessary where overflow or equipment failure creates hazards. Test virtual devices before enabling physical outputs.

## Migration from inspected API source

- provisioning.ts: existing P-256 proof and credential flow retained; replace unconditional candidate upsert, add metadata, approval/rejection/restore and table-backed authorisation. Existing Provisioned wire status becomes Confirmed in coordinated migration. Preserve revocation/recovery controls.
- devices.ts: replace Assigned/Inventory/Retired overloaded status with separate lifecycle attributes; remove manual registration bypass; use conditional field merges rather than replacement that drops new properties.
- deployment.ts: distinguish physical deployment from configuration acknowledgement; extract common check-in and command/event handling; persist management diagnostics.
- telemetry.ts: existing flat allowlist and 6000 mV battery ceiling are BayMonitor-specific; validate against profile, introduce envelope and deduplication.
- deviceCommands.ts and devicePowerSettings.ts: profile-aware action validation, persistent power and GPS settings, explicit command outcomes.
- Web: unified registry with pending candidates, rejected filter and restore; capability-driven controls. Never show an approved candidate and registry row twice.
- Simulator: migrate current pending identity, test BayMonitor, DamMonitor and PumpMonitor with separate credentials. Firmware: migrate legacy serial and protocol after simulator validation.

## Acceptance tests before deployment

Valid/invalid proof; unauthorised serial; rejected retry and restore; concurrent approve/reject; duplicate confirmation; credential recovery/revocation; no unconfirmed allocation; no unallocated deployment; profile mismatch; unknown input/output; BayMonitor rejects PUMP_STOP; simulated-to-physical automation denied; duplicate telemetry/event/command; stale/out-of-order telemetry; expired command; reboot during stop; no automatic reopening; sensor failure; command applied but engine still running; customer isolation; concurrent settings/check-in updates. Test identification expiry, duplicate activation, cancellation, offline timeout, reboot with siren active, and unsupported identification commands. Validate real hardware separately.
