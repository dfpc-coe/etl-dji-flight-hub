<h1 align='center'>ETL-DJI-FlightHub</h1>

<p align='center'>DJI FlightHub 2 UAS location tracking for CloudTAK</p>

Polls the [DJI FlightHub 2](https://fh.dji.com) OpenAPI for the location of aircraft, docks and remote
controllers and the map pins, lines & polygons of each Project, then streams live telemetry (including
the Laser Range Finder target) from the FlightHub 2 web socket, and submits them to TAK as
Cursor-on-Target.

## Architecture

The FlightHub 2 OpenAPI is a polled REST API. Device lists describe which devices exist and whether they
are online but do not contain coordinates - the location of a device is only published in its Thing Model
(state), which has to be requested per device under the Project that owns it. Each scheduled invocation
therefore makes the following requests:

| Step | Request | Purpose |
| ---- | ------- | ------- |
| 1 | `GET /openapi/{version}/project` | List the Projects in the Organization |
| 2 | `GET /openapi/{version}/project/device` | List the Dock & aircraft pairs of each Project |
| 3 | `GET /openapi/{version}/device?device_model_class=drone` & `=airport` | List every aircraft & Dock in the Organization |
| 4 | `GET /openapi/{version}/project/device/{device_sn}` | Find the Project of each device seen only in step 3 |
| 5 | `GET /openapi/{version}/device/{device_sn}/state` | Thing Model of each online device, containing its location |
| 6 | `GET /map/api/v1/workspaces/{project_uuid}/element-groups` | Map pins, lines & polygons of each Project. See [Map Pins](#map-pins) |

Step 2 only lists Dock scene devices. Aircraft flown from a Remote Controller are omitted from it and are
only returned by the Organization scope list in step 3, where they occupy the `gateway` slot of a pair
with no `drone`. The Organization list does not say which Project a device belongs to, so step 4 probes
each Project in turn until one accepts the serial number.

Every invocation makes `3 + <projects> + <online devices>` requests plus up to `<projects>` requests for
each device that is not paired with a Dock. Setting `DJI_PROJECTS` does not remove the Project list
request, as it is the source of the Project names, but does limit the device list & Project lookup
requests.

A failure to list the Projects fails the invocation. A failure for a single Project or device is logged
and the remaining devices are still submitted.

### Map Pins

Pins, lines and polygons drawn in DJI Pilot 2 on a Remote Controller are synchronised by Pilot 2 into the
App Shared element group of the Project, and those drawn on the FlightHub 2 web map into its Default
group. FlightHub 2 serves them on the DJI Cloud API map element route, `GET
/map/api/v1/workspaces/{project_uuid}/element-groups`, on the same host as the OpenAPI and accepts the
Organization Key for it. The route returns every element group with its elements inline and takes an
optional `is_distributed=true` query, which limits it to the groups distributed to Remote Controllers
(`PINS_DISTRIBUTED_ONLY`).

| Group type | Name | Contents |
| ---------- | ---- | -------- |
| `1` | `default` | Elements drawn on the FlightHub 2 web map |
| `2` | `share` (App Shared) | Elements drawn in Pilot 2 on a Remote Controller |
| `7` | `dji_app` | Pilot 2 application layer |

| Element | CoT Type | Styling |
| ------- | -------- | ------- |
| Point | `u-d-p` | `marker-color` from the element colour |
| LineString | `u-d-f` | `stroke` from the element colour |
| Polygon | `u-d-f` | `stroke` & `fill` (20% opacity) from the element colour. Rings are closed if Pilot 2 left them open |

Elements are submitted as `dji-pin-<element id>` with the element name as callsign, the description,
author, layer and Project in the remarks, and the element's creation and last update times in the
metadata. An element that is deleted in FlightHub 2 is no longer submitted and ages out at the Layer's
stale time. Elements without a usable geometry (ie a pin at `0,0`) are skipped.

Writing TAK markers back to the pilot's map is possible through the documented OpenAPI
`POST`/`PUT`/`DELETE /openapi/v2.0/map/element` routes but is not implemented.

### Live Telemetry Stream

The Thing Model is a snapshot and omits the payload telemetry (gimbal angles, Laser Range Finder) that
only exists in the DJI Cloud API OSD stream, where it is published as an object keyed by payload index
(ie `88-0-0`) alongside the `cameras` array. The FlightHub 2 web UI receives that stream over a web
socket at `/duplex/web` on the same host as the OpenAPI, and the socket accepts the Organization Key.
This channel is not documented by DJI - it was derived from the FlightHub 2 web application and may
change without notice.

With `DJI_WEBSOCKET` enabled (the default), each invocation submits the Thing Model snapshot and then
holds the socket open for `STREAM_DURATION` seconds, submitting every device whose telemetry changed
each `STREAM_INTERVAL` seconds. The default schedule is therefore `rate(1 minute)` with a 50 second
stream, which leaves a few seconds between invocations; `STREAM_DURATION` must stay below both the
schedule interval and the Layer timeout (60 seconds for a 1 minute schedule is sufficient).

| Step | Message | Purpose |
| ---- | ------- | ------- |
| 1 | `wss://<host>/duplex/web?x-user-token=<Organization Key>` | Authenticate the socket |
| 2 | `{ "biz_code": "biz_scope", "version": "1.0", "timestamp", "msg_trace_id", "data": { "codes": [...], "project": "", "organization": "<uuid>" } }` | Subscribe to the Organization's `device_osd`, `device_state`, `device_online`, `device_offline` & `device_update_topo` messages. `organization` is mandatory, without it the server closes with code 4003 |
| 3 | `{ "biz_code": "device_osd", "to": ["<org>", "<project>"], "data": { "sn", "host": { ... } } }` | Received at ~2 Hz per online device. `host` is the Cloud API OSD object for that device |
| 4 | `ping` / `pong` | Keepalive text frames. Messages flagged `need_reply` are answered with an `ack_reply` carrying their `msg_trace_id` |

The Organization UUID is read from the `organization_uuid` claim of the Organization Key, falling back
to the `org_uuid` of the first Project. Devices that only appear on the stream (Remote Controllers are
not returned by any OpenAPI device list) are classified by the shape of their OSD and attributed to the
Project named in the message's `to` list.

The stream is a near real-time feed with no history, so a device that is offline for the whole
invocation produces nothing from it. The Thing Model snapshot still covers those devices.

### Feature Mapping

| Device | CoT Type | Callsign |
| ------ | -------- | -------- |
| Aircraft | `a-f-A-M-H-Q` | Device alias, otherwise `<gateway alias> <model>` |
| Dock | `a-f-G-I-B-A` | Device alias, otherwise `<model> <serial>` |
| Remote Controller | `a-f-G-U-C-V-U-R` | Device alias, otherwise `<model> <serial>` |
| Laser Range Finder target | `b-m-p-s-p-i` (Sensor Point of Interest) | `<aircraft callsign> RNG`, uid `dji-<serial>-rng` |

| CoT | Thing Model Property | Notes |
| --- | -------------------- | ----- |
| `uid` | `sn` | Prefixed: `dji-<sn>` |
| Point | `longitude`, `latitude`, `height` | `height` is relative to the ellipsoid, matching CoT HAE. Devices reporting `0,0` have no position fix and are skipped |
| `course` | `attitude_head` | Aircraft only. Published as -180 to 180 from true north, normalized to 0 to 360 |
| `speed` | `horizontal_speed` | Aircraft only. m/s |
| `sensor` | `<payload index>.gimbal_yaw`, `gimbal_pitch` | Airborne aircraft only. The payload object (ie `88-0-0`) is only present on the stream. FoV is a constant (45). Range is the Laser Range Finder distance when it is measuring, otherwise 100m |
| Laser target Point | `<payload index>.measure_target_longitude`, `measure_target_latitude`, `measure_target_altitude` | Stream only. Emitted while `measure_target_error_state` is normal and the target has a position. The distance is also added to the aircraft remarks & metadata. The `cameras` array is also checked for the same fields |

Status, battery, height above takeoff, satellite counts and the owning Project are included in the remarks
and in the feature metadata.

## Code Layout

| File | Contents |
| ---- | -------- |
| `task.ts` | ETL contract (input schema, invocation defaults) and the `control()` flow: discover Projects & devices, snapshot, pins, stream |
| `lib/dji-api.ts` | `DJIApi` OpenAPI client (request envelope, Projects, device lists, Thing Model, Organization UUID), the DJI data model and telemetry utilities (mode names, payload & Laser Range Finder lookup) |
| `lib/dji-api-markers.ts` | Map element groups: `markers()` fetch and `markerToFeature()` CoT mapping |
| `lib/dji-socket.ts` | `DJISocket` client for the FlightHub 2 web socket - authentication, subscription, keepalive, acknowledgements, telemetry delivery |
| `lib/features.ts` | Device state to CoT Features (`stateToFeatures()`), the output metadata schema and stream-only device classification |

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
| `INCLUDE_PINS` | Submit the map pins, lines & polygons of each Project (default `true`). See [Map Pins](#map-pins) |
| `PINS_DISTRIBUTED_ONLY` | Only submit elements from groups distributed to Remote Controllers, skipping the Default group (default `false`) |
| `DJI_WEBSOCKET` | Stream live telemetry from the FlightHub 2 web socket after the Thing Model snapshot (default `true`). See [Live Telemetry Stream](#live-telemetry-stream) |
| `STREAM_DURATION` | Seconds to hold the stream open per invocation (default `50`) |
| `STREAM_INTERVAL` | Seconds between live submissions (default `2`) |
| `DEBUG` | Print submitted features in the logs |

The Organization Key is a JWT tied to the user that generated it. That user must be a member of each
Project that is to be tracked - an Organization administrator who is not a Project member can list the
Project's devices but is refused their Thing Model with `200403 Forbidden` and a `path` of
`device-management/team-view-device`.

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
