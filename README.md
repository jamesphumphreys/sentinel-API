# Sentinel API

Backend services for the Sentinel agricultural monitoring
and remote device management platform.

The API provides the interface between Sentinel devices,
Azure storage and the Sentinel Web management portal.

## Technology stack

- TypeScript
- Node.js
- Azure Functions v4 programming model
- Azure Table Storage
- Azure Identity
- JOSE token validation
- Web Push

## Development environment

Recorded development tools:

- Node.js 26.13.0
- npm 11.20.0
- Azure Functions Core Tools 4.15.2
- Azure CLI
- Visual Studio Code

The deployed Azure Node.js runtime should be verified separately.

## Local development

Install dependencies:

    npm.cmd ci

Build:

    npm.cmd run build

Start the local Azure Functions host:

    npm.cmd start

Watch TypeScript changes:

    npm.cmd run watch

## Configuration

Local configuration is maintained in local.settings.json,
which must not be committed to Git.

| Variable | Purpose |
|---|---|
| SENTINEL_STORAGE_CONNECTION | Azure storage connection |
| SENTINEL_API_AUDIENCE | Authentication token audience |
| SENTINEL_MAPS_CLIENT_ID | Azure Maps identity |
| SENTINEL_ENROLLMENT_ENABLED | Device enrolment control |
| SENTINEL_ENROLLMENT_ALLOWLIST | Permitted device enrolments |
| SENTINEL_VAPID_PUBLIC_KEY | Web push public key |
| SENTINEL_VAPID_PRIVATE_KEY | Web push private signing key |
| SENTINEL_VAPID_SUBJECT | Web push contact identity |

Azure Functions host settings may also be required for local execution.

## Azure environment

- Resource group: rg-sentinel-dev
- Function App: sentinel-api-dev01
- Frontend: sentinel-web-dev01

Deployment procedures are to be documented separately.

## Functional areas

- Device provisioning and enrolment
- Device authentication
- Telemetry ingestion and retrieval
- Device power and reporting configuration
- Remote device commands
- Farm and bay management
- Device deployment
- Customer and user management
- Mapping
- Monitoring
- Push notifications

## Testing

A BayMonitor simulation script is available at:

    scripts/Simulate-BayMonitor.ps1

Automated tests have not yet been implemented.

## Related repositories

- https://github.com/jamesphumphreys/sentinel-web
- https://github.com/jamesphumphreys/sentinel-baymonitor

## Security

Device credentials, storage connection strings, private keys
and local configuration must never be committed to Git.

## Project status

Under active development.
