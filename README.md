<h1 align='center'>ETL-DJI-FlightHub</h1>

<p align='center'>DJI FlightHub 2 UAS location tracking for CloudTAK</p>

Polls the [DJI FlightHub 2](https://fh.dji.com) OpenAPI for the location of aircraft, docks and remote
controllers and submits them to TAK as Cursor-on-Target.

## Architecture

The FlightHub 2 OpenAPI is a polled REST API. Device lists describe which devices exist and whether they
are online but do not contain coordinates - the location of a device is only published in its Thing Model
(state), which has to be requested per device. Each scheduled invocation therefore makes three kinds of
request:

| Step | Request | Purpose |
| ---- | ------- | ------- |
| 1 | `GET /openapi/{version}/project` | List the Projects in the Organization |
| 2 | `GET /openapi/{version}/project/device` | List the gateway (Dock or Remote Controller) & aircraft pairs of each Project |
| 3 | `GET /openapi/{version}/device/{device_sn}/state` | Thing Model of each online device, containing its location |

The default schedule is `rate(10 seconds)` so that a moving aircraft produces a usable track. Every
invocation makes `1 + <projects> + <online devices>` requests, so an Organization with 3 Projects and
5 online devices makes 9 requests every 10 seconds. Setting `DJI_PROJECTS` does not remove the Project
list request, as it is the source of the Project names, but does limit the device list requests.

Sub-minute schedules are run by the CloudTAK events pool rather than AWS EventBridge. Invocations are
not queued behind one another, so the schedule should be lengthened if an invocation regularly takes
longer than the schedule interval.

A failure to list the Projects fails the invocation. A failure for a single Project or device is logged
and the remaining devices are still submitted.

### Feature Mapping

| Device | CoT Type | Callsign |
| ------ | -------- | -------- |
| Aircraft | `a-f-A-M-H-Q` | Device alias, otherwise `<gateway alias> <model>` |
| Dock | `a-f-G-I-B-A` | Device alias, otherwise `<model> <serial>` |
| Remote Controller | `a-f-G-U-C-V-U-R` | Device alias, otherwise `<model> <serial>` |

| CoT | Thing Model Property | Notes |
| --- | -------------------- | ----- |
| `uid` | `sn` | Prefixed: `dji-<sn>` |
| Point | `longitude`, `latitude`, `height` | `height` is relative to the ellipsoid, matching CoT HAE. Devices reporting `0,0` have no position fix and are skipped |
| `course` | `attitude_head` | Aircraft only. Published as -180 to 180 from true north, normalized to 0 to 360 |
| `speed` | `horizontal_speed` | Aircraft only. m/s |
| `sensor` | `<payload index>.gimbal_yaw`, `gimbal_pitch` | Airborne aircraft only. FoV (45) & range (100m) are constants as neither is published |

Status, battery, height above takeoff, satellite counts and the owning Project are included in the remarks
and in the feature metadata.

## Configuration

| Field | Description |
| ----- | ----------- |
| `DJI_ORG_KEY` | Organization Key, sent as the `X-User-Token` header. FlightHub 2: My Organization > Organization Settings > FlightHub Sync (labelled OpenAPI or Cloud Interconnect in some versions) > Organization Key |
| `DJI_API_URL` | OpenAPI base URL - default `https://es-flight-api-us.djigate.com`. See [Regions](#regions) |
| `DJI_API_VERSION` | `v2.0` (default) or `v0.1`. See [API Versions](#api-versions) |
| `DJI_PROJECTS` | Optional list of Project UUIDs to limit the ETL to. If empty every Project in the Organization is used |
| `INCLUDE_DOCKS` | Submit Dock locations (default `true`) |
| `INCLUDE_CONTROLLERS` | Submit Remote Controller locations, which is the location of the pilot (default `true`) |
| `INCLUDE_OFFLINE` | Also request the state of devices reported as offline (default `false`) |
| `DEBUG` | Print submitted features in the logs |

The Organization Key is a JWT tied to the user that generated it. That user must be a member of each
Project that is to be tracked, otherwise the Project's devices cannot be listed.

### Regions

An Organization Key is only accepted by the region that issued it - a key presented to another region is
rejected as unauthorized.

| Region | Base URL |
| ------ | -------- |
| United States | `https://es-flight-api-us.djigate.com` |
| Europe | `https://es-flight-api-eu.djigate.com` |
| China | `https://es-flight-api-cn.djigate.com` |
| On-Premises | The address of the deployment - ie `http://<host>:30812` |

Private addresses are blocked by default. Set the `DJI_UNSAFE_URLS` environment variable on the task to
allow the configured `DJI_API_URL` when developing against a local or on-premises deployment.

### API Versions

DJI publishes two generations of the OpenAPI. The three requests used by this ETL have the same path,
headers and response structure in both, so the version only changes the path prefix.

| `DJI_API_VERSION` | DJI Documentation | Notes |
| ----------------- | ----------------- | ----- |
| `v2.0` | OpenAPI V2.0 (Public Cloud) | Current version |
| `v0.1` | OpenAPI V1.0 | The V1.0 documentation uses the `/openapi/v0.1` path prefix |

The On-Premises edition of OpenAPI V2.0 uses different paths for the Project list and is not supported.
On-Premises deployments should use `v0.1`.

## API Documentation

The integration was built from the following documentation.

### DJI FlightHub 2 OpenAPI V2.0 (Public Cloud)

- [API Introduction](https://fh.dji.com/user-manual/en/custom-development/open-api/public-cloud-v2.html) - FlightHub 2 User Manual
- [Interface Documentation](https://s.apifox.cn/5113ab93-b1c2-4f3c-bc06-c3656c5352fb)
- [Authentication Tutorial](https://s.apifox.cn/5113ab93-b1c2-4f3c-bc06-c3656c5352fb/8853694m0) - `X-User-Token` & `X-Project-Uuid`, where to obtain the Organization Key
- [Device Management Tutorial](https://s.apifox.cn/5113ab93-b1c2-4f3c-bc06-c3656c5352fb/8853698m0) - Project list => device list => Thing Model flow
- [Get Project List Under Organization](https://s.apifox.cn/5113ab93-b1c2-4f3c-bc06-c3656c5352fb/463944685e0) - `GET /openapi/v2.0/project`
- [Get Project Device List](https://s.apifox.cn/5113ab93-b1c2-4f3c-bc06-c3656c5352fb/463944695e0) - `GET /openapi/v2.0/project/device`, integer `mode_code` values
- [Get Thing Model](https://s.apifox.cn/5113ab93-b1c2-4f3c-bc06-c3656c5352fb/463944692e0) - `GET /openapi/v2.0/device/{device_sn}/state`, per model property definitions
- [Error Code](https://s.apifox.cn/5113ab93-b1c2-4f3c-bc06-c3656c5352fb/8853695m0)
- [Sample Source Code](https://github.com/dji-sdk/FlightHub-2-OpenAPI-V2-Demo) - DJI's device list demo. `KeyCenter.ts` documents the form of the
  Public Cloud host and `PublicCloud/DeviceList` documents that the Public Cloud Thing Model uses named enums (`mode_code: 'idle'`)

### DJI FlightHub 2 OpenAPI V1.0

- [API Introduction](https://fh.dji.com/user-manual/en/custom-development/open-api/api-introduction.html) - FlightHub 2 User Manual
- [Interface Documentation](https://apifox.com/apidoc/shared/484eaf38-faef-488e-ad9b-8edffac94406)
- [Authentication Tutorial](https://apifox.com/apidoc/shared/484eaf38-faef-488e-ad9b-8edffac94406/doc-6067870)
- [Device Management Tutorial](https://apifox.com/apidoc/shared/484eaf38-faef-488e-ad9b-8edffac94406/doc-6067877)
- [Get the list of projects under the organization](https://apifox.com/apidoc/shared/484eaf38-faef-488e-ad9b-8edffac94406/api-263045290) - `GET /openapi/v0.1/project`
- [Obtain the list of devices under the project](https://apifox.com/apidoc/shared/484eaf38-faef-488e-ad9b-8edffac94406/api-263045292) - `GET /openapi/v0.1/project/device`
- [Device Model Retrieval](https://apifox.com/apidoc/shared/484eaf38-faef-488e-ad9b-8edffac94406/api-263045310) - `GET /openapi/v0.1/device/{device_sn}/state`

### DJI Cloud API

The Thing Model returned by FlightHub 2 is the device property set defined by the DJI Cloud API, which the
OpenAPI documentation defers to for detail.

- [Product Support](https://developer.dji.com/doc/cloud-api-tutorial/en/overview/product-support.html) - Device enums (`domain-type-sub_type`)
  used to tell aircraft, docks & remote controllers apart
- [Device Properties](https://developer.dji.com/doc/cloud-api-tutorial/en/api-reference/dock-to-cloud/mqtt/dock/dock3/properties.html) - Property
  definitions, including the payload objects keyed by `{type-subtype-gimbalindex}`

### Third Party

- [dji-flighthub2-cli](https://github.com/alecad/dji-flighthub2-cli) - Unofficial client validated against a live Organization. Source of the US &
  EU base URLs, and of [observed behaviour](https://github.com/alecad/dji-flighthub2-cli/blob/main/docs/LIVE_VALIDATION.md) that DJI does not
  document: errors are returned as an HTTP 200 with a non-zero `code`, and empty lists are returned as `null`

### Verification

DJI's documentation does not state the Public Cloud base URLs or any rate limit. What has and has not been
confirmed:

- **Confirmed**: The US, EU & China hosts above answer unauthenticated requests for all three paths, on both
  `v0.1` & `v2.0`, with `{"code":200401,"message":"X-User-Token not found or empty"}`. Unknown paths return a 404
- **Not confirmed**: The ETL has not been run against an Organization with devices. Response handling follows the
  documentation above and is covered by tests against a mock of the documented responses
- **Assumed**: `gimbal_yaw` is relative to true north, as `attitude_head` is documented to be. If sensor cones are
  drawn relative to the nose of the aircraft this assumption is wrong
- **Unknown**: Rate limits. Error `210429` (Operations too frequent) exists - lengthen the Layer schedule if it is logged

## Development

DFPC provided Lambda ETLs are currently all written in [NodeJS](https://nodejs.org/en) through the use of a AWS Lambda optimized
Docker container. Documentation for the Dockerfile can be found in the [AWS Help Center](https://docs.aws.amazon.com/lambda/latest/dg/images-create.html)

```sh
npm install
```

Add a .env file in the root directory that gives the ETL script the necessary variables to communicate with a local ETL server.
When the ETL is deployed the `ETL_API` and `ETL_LAYER` variables will be provided by the Lambda Environment

```json
{
    "ETL_API": "http://localhost:5001",
    "ETL_LAYER": "19"
}
```

To run the task, ensure the local [CloudTAK](https://github.com/dfpc-coe/CloudTAK/) server is running and then run with typescript runtime
or build to JS and run natively with node

```
ts-node task.ts
```

```
npm run build
cp .env dist/
node dist/task.js
```

Tests run against a mock FlightHub 2 API and do not require credentials

```sh
npm test
```

### Deployment

Deployment into the CloudTAK environment for configuration is done via automatic releases to the DFPC AWS environment.

Github actions will build and push docker releases on every version tag which can then be automatically configured via the
CloudTAK API.

Builds are performed by the `cloudtak-etl` script provided by [`@tak-ps/etl`](https://github.com/dfpc-coe/etl-base).
It requires a `capabilities.json` document alongside the `Dockerfile` which describes the task (name, description,
compute requirements, permissions & invocation types) and is validated and embedded in the OCI Image Manifest as a
`com.cloudtak.capabilities` annotation so CloudTAK can read it directly from ECR before the task is ever deployed.
Update `capabilities.json` whenever the task's requirements change.

To build & push manually:

```sh
export AWS_REGION='us-east-1'
export AWS_ACCOUNT_ID='123456789012'
export Environment='prod' # Optional - defaults to prod

npx cloudtak-etl
```

Non-DFPC users will need to setup their own docker => ECS build system via something like Github Actions or AWS Codebuild.
