import crypto from 'node:crypto';
import type { Static, TSchema } from '@sinclair/typebox';
import { Type } from '@sinclair/typebox';
import type { Event } from '@tak-ps/etl';
import ETL, { SchemaType, handler as internal, local, fetch, Feature, DataFlowType, InvocationType } from '@tak-ps/etl';

/**
 * The Input Schema contains the environment object that will be requested via the CloudTAK UI
 * It should be a valid TypeBox object - https://github.com/sinclairzx81/typebox
 */
const InputSchema = Type.Object({
    'DJI_ORG_KEY': Type.String({
        description: 'FlightHub 2 Organization Key - My Organization > Organization Settings > FlightHub Sync (OpenAPI) > Organization Key'
    }),
    'DJI_API_URL': Type.String({
        default: 'https://es-flight-api-us.djigate.com',
        description: 'FlightHub 2 OpenAPI Base URL - Region specific, an Organization Key is only accepted by the region that issued it'
    }),
    'DJI_API_VERSION': Type.String({
        default: 'v2.0',
        enum: ['v2.0', 'v0.1'],
        description: 'FlightHub 2 OpenAPI Version - v0.1 is the path prefix of the OpenAPI V1.0 documentation'
    }),
    'DJI_PROJECTS': Type.Array(Type.Object({
        ProjectUUID: Type.String({ description: 'FlightHub 2 Project UUID' })
    }, {
        description: 'Limit to specific FlightHub 2 Projects - If empty all Projects in the Organization are used',
        display: 'table'
    }), {
        default: []
    }),
    'INCLUDE_DOCKS': Type.Boolean({
        default: true,
        description: 'Submit DJI Dock locations'
    }),
    'INCLUDE_CONTROLLERS': Type.Boolean({
        default: true,
        description: 'Submit Remote Controller (Pilot) locations'
    }),
    'INCLUDE_OFFLINE': Type.Boolean({
        default: false,
        description: 'Request the last known state of devices that FlightHub 2 reports as offline'
    }),
    'INCLUDE_PINS': Type.Boolean({
        default: true,
        description: 'Submit the map pins, lines & polygons of each Project - including those dropped on a Remote Controller'
    }),
    'PINS_DISTRIBUTED_ONLY': Type.Boolean({
        default: false,
        description: 'Only submit pins from element groups that are distributed to Remote Controllers (App Shared & dji_app), skipping the Default group'
    }),
    'DJI_WEBSOCKET': Type.Boolean({
        default: true,
        description: 'After the Thing Model snapshot, hold the FlightHub 2 web socket open and submit live telemetry as it arrives'
    }),
    'STREAM_DURATION': Type.Integer({
        default: 50,
        minimum: 1,
        description: 'Seconds to stream live telemetry per invocation - keep below the Layer timeout and the schedule interval'
    }),
    'STREAM_INTERVAL': Type.Integer({
        default: 2,
        minimum: 1,
        description: 'Seconds between live telemetry submissions'
    }),
    'DEBUG': Type.Boolean({
        default: false,
        description: 'Print results in logs'
    })
});

/**
 * The Output Schema contains the known properties that will be returned on the
 * GeoJSON Feature in the .properties.metdata object
 */
const OutputSchema = Type.Object({
    serial: Type.Optional(Type.String({ description: 'Device Serial Number' })),
    device_class: Type.String({ description: 'drone, dock, controller, laser or pin' }),
    model: Type.Optional(Type.String({ description: 'Device Model - ie M3TD' })),
    model_key: Type.Optional(Type.String({ description: 'DJI Device Enum: domain-type-sub_type' })),
    project: Type.Optional(Type.String({ description: 'FlightHub 2 Project Name' })),
    project_uuid: Type.String({ description: 'FlightHub 2 Project UUID' }),
    gateway_serial: Type.Optional(Type.String({ description: 'Serial Number of the Dock or Remote Controller the aircraft is paired with' })),
    online: Type.Optional(Type.Boolean({ description: 'Device Online Status' })),
    status: Type.Optional(Type.String({ description: 'Device Status - ie wayline_flight' })),
    airborne: Type.Optional(Type.Boolean({ description: 'Aircraft Status indicates that the aircraft is in flight' })),
    battery: Type.Optional(Type.Number({ description: 'Battery percentage (0-100)' })),
    remain_flight_time: Type.Optional(Type.Number({ description: 'Remaining flight time in seconds' })),
    height: Type.Optional(Type.Number({ description: 'Height above the ellipsoid in meters' })),
    elevation: Type.Optional(Type.Number({ description: 'Height above the takeoff point in meters' })),
    horizontal_speed: Type.Optional(Type.Number({ description: 'Horizontal speed in m/s' })),
    vertical_speed: Type.Optional(Type.Number({ description: 'Vertical speed in m/s' })),
    home_distance: Type.Optional(Type.Number({ description: 'Distance from the Home Point in meters' })),
    gps_satellites: Type.Optional(Type.Number({ description: 'Number of GPS satellites' })),
    rtk_satellites: Type.Optional(Type.Number({ description: 'Number of RTK satellites' })),
    drone_in_dock: Type.Optional(Type.Boolean({ description: 'Dock reports that the aircraft is inside' })),
    firmware_version: Type.Optional(Type.String({ description: 'Firmware Version' })),
    laser_latitude: Type.Optional(Type.Number({ description: 'Laser Range Finder target latitude' })),
    laser_longitude: Type.Optional(Type.Number({ description: 'Laser Range Finder target longitude' })),
    laser_altitude: Type.Optional(Type.Number({ description: 'Laser Range Finder target altitude in meters' })),
    laser_distance: Type.Optional(Type.Number({ description: 'Laser Range Finder distance in meters' })),
    laser_state: Type.Optional(Type.String({ description: 'Laser Range Finder state - normal, too_close, too_far or no_signal' })),
    live: Type.Optional(Type.Boolean({ description: 'Position came from the live telemetry stream rather than the Thing Model' })),
    element_id: Type.Optional(Type.String({ description: 'FlightHub 2 map element UUID' })),
    element_type: Type.Optional(Type.String({ description: 'point, line or polygon' })),
    group: Type.Optional(Type.String({ description: 'Map element group name' })),
    group_type: Type.Optional(Type.String({ description: 'default, app_shared, custom or the numeric group type' })),
    author: Type.Optional(Type.String({ description: 'FlightHub 2 user that created the element' })),
    color: Type.Optional(Type.String({ description: 'Element colour as a hex string' })),
    created: Type.Optional(Type.String({ description: 'Element creation time' })),
    updated: Type.Optional(Type.String({ description: 'Element last update time' }))
});

const MapElement = Type.Object({
    id: Type.String(),
    name: Type.Optional(Type.String()),
    desc: Type.Optional(Type.String()),
    status: Type.Optional(Type.Union([Type.Integer(), Type.String()])),
    display: Type.Optional(Type.Union([Type.Integer(), Type.String()])),
    create_time: Type.Optional(Type.Number()),
    update_time: Type.Optional(Type.Number()),
    resource: Type.Optional(Type.Object({
        type: Type.Optional(Type.Union([Type.Integer(), Type.String()])),
        user_name: Type.Optional(Type.String()),
        user_id: Type.Optional(Type.String()),
        remark: Type.Optional(Type.String()),
        content: Type.Optional(Type.Object({
            properties: Type.Optional(Type.Object({
                color: Type.Optional(Type.String()),
                clampToGround: Type.Optional(Type.Boolean())
            }, { additionalProperties: true })),
            geometry: Type.Optional(Type.Object({
                type: Type.Optional(Type.String()),
                coordinates: Type.Optional(Type.Unknown())
            }, { additionalProperties: true }))
        }, { additionalProperties: true }))
    }, { additionalProperties: true }))
}, { additionalProperties: true });

const MapElementGroup = Type.Object({
    id: Type.String(),
    name: Type.Optional(Type.String()),
    type: Type.Optional(Type.Union([Type.Integer(), Type.String()])),
    is_distributed: Type.Optional(Type.Boolean()),
    elements: Type.Optional(Type.Array(MapElement))
}, { additionalProperties: true });

const GroupTypes: Record<string, string> = {
    '0': 'custom',
    '1': 'default',
    '2': 'app_shared'
};

const Project = Type.Object({
    uuid: Type.String(),
    name: Type.Optional(Type.String()),
    org_uuid: Type.Optional(Type.String())
}, { additionalProperties: true });

const Device = Type.Object({
    sn: Type.String(),
    callsign: Type.Optional(Type.String()),
    device_model: Type.Optional(Type.Object({
        key: Type.Optional(Type.String()),
        domain: Type.Optional(Type.String()),
        name: Type.Optional(Type.String()),
        class: Type.Optional(Type.String())
    }, { additionalProperties: true })),
    device_online_status: Type.Optional(Type.Boolean()),
    mode_code: Type.Optional(Type.Union([Type.Integer(), Type.String()]))
}, { additionalProperties: true });

const DevicePair = Type.Object({
    gateway: Type.Optional(Device),
    drone: Type.Optional(Device)
}, { additionalProperties: true });

/**
 * Subset of the Thing Model shared by Aircraft, Docks & Remote Controllers
 * The payload gimbals are keyed by payload index so unknown properties are retained
 */
const Camera = Type.Object({
    payload_index: Type.Optional(Type.String()),
    gimbal_yaw: Type.Optional(Type.Number()),
    gimbal_pitch: Type.Optional(Type.Number()),
    measure_target_latitude: Type.Optional(Type.Number()),
    measure_target_longitude: Type.Optional(Type.Number()),
    measure_target_altitude: Type.Optional(Type.Number()),
    measure_target_distance: Type.Optional(Type.Number()),
    measure_target_error_state: Type.Optional(Type.Union([Type.Integer(), Type.String()]))
}, { additionalProperties: true });

const DeviceState = Type.Object({
    cameras: Type.Optional(Type.Array(Camera)),
    latitude: Type.Optional(Type.Number()),
    longitude: Type.Optional(Type.Number()),
    height: Type.Optional(Type.Number()),
    elevation: Type.Optional(Type.Number()),
    attitude_head: Type.Optional(Type.Number()),
    horizontal_speed: Type.Optional(Type.Number()),
    vertical_speed: Type.Optional(Type.Number()),
    home_distance: Type.Optional(Type.Number()),
    mode_code: Type.Optional(Type.Union([Type.Integer(), Type.String()])),
    capacity_percent: Type.Optional(Type.Number()),
    battery: Type.Optional(Type.Object({
        capacity_percent: Type.Optional(Type.Number()),
        remain_flight_time: Type.Optional(Type.Number())
    }, { additionalProperties: true })),
    position_state: Type.Optional(Type.Object({
        gps_number: Type.Optional(Type.Number()),
        rtk_number: Type.Optional(Type.Number())
    }, { additionalProperties: true })),
    drone_in_dock: Type.Optional(Type.Union([Type.Integer(), Type.String()])),
    firmware_version: Type.Optional(Type.String())
}, { additionalProperties: Type.Unknown() });

const DeviceStateResponse = Type.Object({
    device_state: Type.Optional(DeviceState)
}, { additionalProperties: true });

type DeviceClass = 'drone' | 'dock' | 'controller';

type Tracked = {
    device_class: DeviceClass;
    device: Static<typeof Device>;
    gateway?: Static<typeof Device>;
    project: Static<typeof Project>;
};

const CoTType: Record<DeviceClass, string> = {
    drone: 'a-f-A-M-H-Q',
    dock: 'a-f-G-I-B-A',
    controller: 'a-f-G-U-C-V-U-R'
};

// Sensor Point of Interest
const LaserCoTType = 'b-m-p-s-p-i';

const LaserStates = ['normal', 'too_close', 'too_far', 'no_signal'];

// The device lists report mode_code as an integer while the Thing Model reports the named value
const DroneModes = [
    'standby', 'takeoff_preparation', 'takeoff_preparation_completed', 'manual_flight',
    'automatic_takeoff', 'wayline_flight', 'panoramic_photography', 'intelligent_tracking',
    'adsb_avoidance', 'auto_returning_to_home', 'automatic_landing', 'forced_landing',
    'three_blade_landing', 'upgrading', 'not_connected', 'apas', 'virtual_stick_state',
    'live_flight_controls', 'airborne_rtk_fixing_mode', 'dock_address_selecting', 'poi'
];

const DockModes = [
    'idle', 'on_site_debugging', 'remote_debugging', 'firmware_upgrade_in_progress',
    'in_operation', 'to_be_calibrated'
];

const GroundedModes = new Set([
    'standby', 'takeoff_preparation', 'takeoff_preparation_completed',
    'upgrading', 'not_connected', 'dock_address_selecting'
]);

function modeName(device_class: DeviceClass, code?: string | number): string | undefined {
    if (code === undefined || code === '') return undefined;
    if (device_class === 'controller') return undefined;

    const index = Number(code);
    if (Number.isNaN(index)) return String(code);

    return (device_class === 'drone' ? DroneModes : DockModes)[index] || String(code);
}

function humanize(value: string): string {
    return value.split('_').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

/**
 * DJI Device Enums are composed as domain-type-sub_type where the domain is
 * 0: Aircraft, 1: Payload, 2: Remote Controller, 3: Dock
 */
function deviceClass(device: Static<typeof Device>, fallback: DeviceClass): DeviceClass {
    const domain = device.device_model?.domain ?? device.device_model?.key?.split('-')[0];

    if (domain === '0') return 'drone';
    if (domain === '2') return 'controller';
    if (domain === '3') return 'dock';

    return fallback;
}

// FlightHub 2 returns null in place of empty collections & unset values
function stripNulls(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.filter((entry) => entry !== null).map(stripNulls);
    } else if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(value)) {
            if (entry !== null) out[key] = stripNulls(entry);
        }
        return out;
    }

    return value;
}

function compass(degrees: number): number {
    return ((degrees % 360) + 360) % 360;
}

function validPosition(latitude?: number, longitude?: number): boolean {
    if (latitude === undefined || longitude === undefined) return false;
    // Devices without a position fix report 0,0
    if (latitude === 0 && longitude === 0) return false;
    return Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;
}

/**
 * Payload telemetry is published both as a `cameras` array and as objects keyed by
 * payload index (`88-0-0`) - the gimbal & Laser Range Finder are only in the latter
 */
function payloads(state: Static<typeof DeviceState>): Static<typeof Camera>[] {
    const found: Static<typeof Camera>[] = [];

    for (const [key, value] of Object.entries(state)) {
        if (!/^\d+-\d+-\d+$/.test(key) || !value || typeof value !== 'object' || Array.isArray(value)) continue;
        found.push(value as Static<typeof Camera>);
    }

    return found.concat(state.cameras || []);
}

function laser(state: Static<typeof DeviceState>): {
    latitude: number,
    longitude: number,
    altitude?: number,
    distance?: number,
    state: string
} | undefined {
    for (const camera of payloads(state)) {
        if (!validPosition(camera.measure_target_latitude, camera.measure_target_longitude)) continue;

        const code = camera.measure_target_error_state;
        const index = Number(code ?? 0);
        const status = Number.isNaN(index)
            ? String(code).toLowerCase()
            : LaserStates[index] || String(code);

        if (status !== 'normal') continue;

        return {
            latitude: camera.measure_target_latitude as number,
            longitude: camera.measure_target_longitude as number,
            altitude: camera.measure_target_altitude,
            distance: camera.measure_target_distance,
            state: status
        };
    }

    return undefined;
}

function gimbal(state: Static<typeof DeviceState>): { yaw: number, pitch: number } | undefined {
    for (const camera of payloads(state)) {
        if (typeof camera.gimbal_yaw !== 'number') continue;

        return {
            yaw: camera.gimbal_yaw,
            pitch: typeof camera.gimbal_pitch === 'number' ? camera.gimbal_pitch : 0
        };
    }

    return undefined;
}

function stateToFeatures(
    tracked: Tracked,
    state: Static<typeof DeviceState>,
    live = false
): Static<typeof Feature.InputFeature>[] {
    const { device, device_class, gateway, project } = tracked;

    if (!validPosition(state.latitude, state.longitude)) return [];

    const model = device.device_model?.name;
    const status = modeName(device_class, state.mode_code ?? device.mode_code);
    const airborne = device_class === 'drone' && status !== undefined
        ? !GroundedModes.has(status)
        : undefined;
    const battery = state.battery?.capacity_percent ?? state.capacity_percent;

    let callsign = device.callsign;
    if (!callsign && device_class === 'drone' && gateway?.callsign) {
        callsign = `${gateway.callsign} ${model || 'UAS'}`;
    } else if (!callsign) {
        callsign = `${model || 'DJI'} ${device.sn}`;
    }

    const remarks = [];
    if (model) remarks.push(`Model: ${model}`);
    remarks.push(`Serial: ${device.sn}`);
    if (status) remarks.push(`Status: ${humanize(status)}`);
    if (battery !== undefined) remarks.push(`Battery: ${Math.round(battery)}%`);
    if (device_class === 'drone' && state.elevation !== undefined) {
        remarks.push(`Height Above Takeoff: ${Math.round(state.elevation)}m`);
    }
    if (gateway) {
        remarks.push(`${deviceClass(gateway, 'dock') === 'dock' ? 'Dock' : 'Controller'}: ${gateway.callsign || gateway.sn}`);
    }
    if (project.name) remarks.push(`Project: ${project.name}`);

    const target = device_class === 'drone' ? laser(state) : undefined;
    if (target?.distance !== undefined) remarks.push(`Laser Range: ${Math.round(target.distance)}m`);

    const metadata: Static<typeof OutputSchema> = {
        serial: device.sn,
        device_class,
        model,
        model_key: device.device_model?.key,
        project: project.name,
        project_uuid: project.uuid,
        gateway_serial: gateway?.sn,
        online: device.device_online_status,
        status,
        airborne,
        battery,
        remain_flight_time: state.battery?.remain_flight_time,
        height: state.height,
        elevation: state.elevation,
        horizontal_speed: state.horizontal_speed,
        vertical_speed: state.vertical_speed,
        home_distance: state.home_distance,
        gps_satellites: state.position_state?.gps_number,
        rtk_satellites: state.position_state?.rtk_number,
        drone_in_dock: state.drone_in_dock !== undefined
            ? ['inside', '1'].includes(String(state.drone_in_dock))
            : undefined,
        firmware_version: state.firmware_version,
        laser_latitude: target?.latitude,
        laser_longitude: target?.longitude,
        laser_altitude: target?.altitude,
        laser_distance: target?.distance,
        laser_state: target?.state,
        live: live || undefined
    };

    const feat: Static<typeof Feature.InputFeature> = {
        id: `dji-${device.sn}`,
        type: 'Feature',
        properties: {
            type: CoTType[device_class],
            callsign,
            remarks: remarks.join('\n'),
            metadata
        },
        geometry: {
            type: 'Point',
            coordinates: [state.longitude as number, state.latitude as number, state.height ?? 0]
        }
    };

    const features = [feat];

    if (target) {
        features.push({
            id: `dji-${device.sn}-rng`,
            type: 'Feature',
            properties: {
                type: LaserCoTType,
                callsign: `${callsign} RNG`,
                remarks: [
                    `Laser Range Finder target of ${callsign}`,
                    target.distance !== undefined ? `Distance: ${Math.round(target.distance)}m` : undefined,
                    project.name ? `Project: ${project.name}` : undefined
                ].filter(Boolean).join('\n'),
                metadata: {
                    serial: device.sn,
                    device_class: 'laser',
                    model,
                    project: project.name,
                    project_uuid: project.uuid,
                    laser_latitude: target.latitude,
                    laser_longitude: target.longitude,
                    laser_altitude: target.altitude,
                    laser_distance: target.distance,
                    laser_state: target.state,
                    live: live || undefined
                } satisfies Static<typeof OutputSchema>
            },
            geometry: {
                type: 'Point',
                coordinates: [target.longitude, target.latitude, target.altitude ?? 0]
            }
        });
    }

    if (device_class === 'drone') {
        if (state.horizontal_speed !== undefined) feat.properties.speed = state.horizontal_speed;
        if (state.attitude_head !== undefined) feat.properties.course = compass(state.attitude_head);

        // Range/FoV are not published so representative constants are used
        const payload = gimbal(state);
        if (airborne && payload) {
            feat.properties.sensor = {
                azimuth: compass(payload.yaw),
                elevation: payload.pitch,
                fov: 45,
                range: target?.distance ?? 100
            };
        }
    }

    return features;
}

type Position = [number, number] | [number, number, number];

function isPosition(value: unknown): value is Position {
    return Array.isArray(value)
        && (value.length === 2 || value.length === 3)
        && value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
        && validPosition(value[1], value[0]);
}

/**
 * Pilot 2 polygons have been seen both as a bare ring & as a GeoJSON ring list
 */
function elementGeometry(type: string | undefined, coordinates: unknown): Static<typeof Feature.InputFeature>['geometry'] | null {
    if (type === 'Point') {
        return isPosition(coordinates) ? { type: 'Point', coordinates } : null;
    } else if (type === 'LineString') {
        if (!Array.isArray(coordinates) || coordinates.length < 2 || !coordinates.every(isPosition)) return null;
        return { type: 'LineString', coordinates };
    } else if (type === 'Polygon') {
        if (!Array.isArray(coordinates) || !coordinates.length) return null;

        const rings = isPosition(coordinates[0]) ? [coordinates] : coordinates;
        if (!rings.every((ring) => Array.isArray(ring) && ring.length >= 3 && ring.every(isPosition))) return null;

        const closed = (rings as Position[][]).map((ring) => {
            const first = ring[0];
            const last = ring[ring.length - 1];
            return first[0] === last[0] && first[1] === last[1] ? ring : [...ring, first];
        });

        return { type: 'Polygon', coordinates: closed };
    }

    return null;
}

function elementToFeature(
    element: Static<typeof MapElement>,
    group: Static<typeof MapElementGroup>,
    project: Static<typeof Project>
): Static<typeof Feature.InputFeature> | null {
    const content = element.resource?.content;
    const geometry = elementGeometry(content?.geometry?.type, content?.geometry?.coordinates);
    if (!geometry) return null;

    const element_type = geometry.type === 'Point' ? 'point' : geometry.type === 'LineString' ? 'line' : 'polygon';
    const color = content?.properties?.color;
    const author = element.resource?.user_name;
    const callsign = element.name || `DJI ${element_type} ${element.id.slice(0, 8)}`;

    const remarks = [];
    if (element.desc) remarks.push(element.desc);
    if (element.resource?.remark) remarks.push(element.resource.remark);
    if (author) remarks.push(`Created by: ${author}`);
    if (group.name) remarks.push(`Layer: ${group.name}`);
    if (project.name) remarks.push(`Project: ${project.name}`);

    const metadata: Static<typeof OutputSchema> = {
        device_class: 'pin',
        element_id: element.id,
        element_type,
        group: group.name,
        group_type: group.type !== undefined ? GroupTypes[String(group.type)] || String(group.type) : undefined,
        author,
        color,
        project: project.name,
        project_uuid: project.uuid,
        created: element.create_time ? new Date(element.create_time).toISOString() : undefined,
        updated: element.update_time ? new Date(element.update_time).toISOString() : undefined
    };

    const feat: Static<typeof Feature.InputFeature> = {
        id: `dji-pin-${element.id}`,
        type: 'Feature',
        properties: {
            type: geometry.type === 'Point' ? 'u-d-p' : 'u-d-f',
            callsign,
            remarks: remarks.join('\n'),
            metadata
        },
        geometry
    };

    if (color) {
        if (geometry.type === 'Point') {
            feat.properties['marker-color'] = color;
        } else {
            feat.properties.stroke = color;
            feat.properties['stroke-width'] = 3;

            if (geometry.type === 'Polygon') {
                feat.properties.fill = color;
                feat.properties['fill-opacity'] = 0.2;
            }
        }
    }

    return feat;
}

/**
 * Devices only seen on the telemetry stream are classified by the shape of their OSD
 */
function inferTracked(sn: string, state: Static<typeof DeviceState>, project?: Static<typeof Project>): Tracked {
    const keys = new Set(Object.keys(state));

    let device_class: DeviceClass = 'controller';
    if (['attitude_head', 'cameras', 'home_distance', 'total_flight_sorties'].some((key) => keys.has(key))) {
        device_class = 'drone';
    } else if (['drone_in_dock', 'network_state', 'sub_device', 'cover_state'].some((key) => keys.has(key))) {
        device_class = 'dock';
    }

    return { device_class, device: { sn }, project: project || { uuid: '' } };
}

export default class Task extends ETL {
    static name = 'etl-dji-flight-hub'
    static flow = [ DataFlowType.Incoming ];
    static invocation = [ InvocationType.Schedule ];
    static invocationDefaults = {
        schedule: { enabled: true, cron: 'rate(1 minute)' }
    };

    async schema(
        type: SchemaType = SchemaType.Input,
        flow: DataFlowType = DataFlowType.Incoming
    ): Promise<TSchema> {
        if (flow === DataFlowType.Incoming) {
            if (type === SchemaType.Input) {
                return InputSchema;
            } else {
                return OutputSchema;
            }
        } else {
            return Type.Object({});
        }
    }

    /**
     * Perform an authenticated request against the FlightHub 2 OpenAPI,
     * unwrapping the standard `{ code, message, data }` response envelope
     */
    async dji<T extends TSchema>(
        env: Static<typeof InputSchema>,
        path: string,
        schema: T,
        project?: string
    ): Promise<Static<T>> {
        // Paths outside the OpenAPI prefix are used verbatim - ie the Cloud API map element routes
        const prefix = path.startsWith('/map/') ? '' : `/openapi/${env.DJI_API_VERSION}`;
        const url = new URL(`${env.DJI_API_URL.replace(/\/+$/, '')}${prefix}${path}`);

        const headers: Record<string, string> = {
            'X-User-Token': env.DJI_ORG_KEY,
            'X-Request-Id': crypto.randomUUID(),
            'X-Language': 'en',
            'Accept': 'application/json'
        };

        if (project) headers['X-Project-Uuid'] = project;

        const res = await fetch(url, {
            method: 'GET',
            headers,
            // Local development escape hatch - node-safeurl blocks private hostnames by default
            safeUrlAllow: process.env.DJI_UNSAFE_URLS ? [url.origin] : undefined
        });

        const text = await res.text();

        let envelope: { code?: unknown, message?: unknown, data?: unknown };
        try {
            envelope = JSON.parse(text);
        } catch {
            throw new Error(`FlightHub GET ${path} failed (${res.status}): ${text.slice(0, 200)}`);
        }

        // Business errors are most often returned as a 200 with a non-zero code
        if (!res.ok || envelope.code !== 0) {
            throw new Error(`FlightHub GET ${path} failed (${res.status}): ${envelope.code} ${envelope.message}`);
        }

        return this.type(schema, stripNulls(envelope.data ?? {}));
    }

    /**
     * Map pins, lines & polygons of each Project - Pilot 2 synchronises the elements
     * drawn on a Remote Controller into the App Shared group of the Project
     */
    async pins(
        env: Static<typeof InputSchema>,
        projects: Static<typeof Project>[]
    ): Promise<Static<typeof Feature.InputFeature>[]> {
        const features: Static<typeof Feature.InputFeature>[] = [];

        for (const project of projects) {
            try {
                const query = env.PINS_DISTRIBUTED_ONLY ? '?is_distributed=true' : '';
                const data = await this.dji(
                    env,
                    `/map/api/v1/workspaces/${encodeURIComponent(project.uuid)}/element-groups${query}`,
                    Type.Union([Type.Array(MapElementGroup), Type.Object({}, { additionalProperties: true })]),
                    project.uuid
                );

                for (const group of Array.isArray(data) ? data : []) {
                    for (const element of group.elements || []) {
                        const feat = elementToFeature(element, group, project);

                        if (feat) {
                            features.push(feat);
                        } else if (env.DEBUG) {
                            console.log(`ok - element ${element.id} has no usable geometry`);
                        }
                    }
                }
            } catch (err) {
                console.error(`not ok - pins for project ${project.name || project.uuid}:`, err instanceof Error ? err.message : err);
            }
        }

        return features;
    }

    async projects(env: Static<typeof InputSchema>): Promise<Static<typeof Project>[]> {
        const projects: Map<string, Static<typeof Project>> = new Map();

        const page_size = 100;
        for (let page = 1; page <= 100; page++) {
            const data = await this.dji(env, `/project?page=${page}&page_size=${page_size}`, Type.Object({
                list: Type.Optional(Type.Array(Project))
            }, { additionalProperties: true }));

            const list = (data.list || []).filter((project) => !projects.has(project.uuid));
            for (const project of list) projects.set(project.uuid, project);

            // A page without unseen projects also guards against pagination being ignored
            if (!list.length || (data.list || []).length < page_size) break;
        }

        const limit = new Set(env.DJI_PROJECTS.map((project) => project.ProjectUUID.trim()));
        if (!limit.size) return Array.from(projects.values());

        return Array.from(limit).map((uuid) => {
            return projects.get(uuid) || { uuid };
        });
    }

    /**
     * Resolve the Project a device belongs to - the Organization scope device
     * list does not include it and the Thing Model is only served under that Project
     */
    async project(
        env: Static<typeof InputSchema>,
        sn: string,
        projects: Static<typeof Project>[]
    ): Promise<Static<typeof Project> | undefined> {
        for (const project of projects) {
            try {
                await this.dji(env, `/project/device/${encodeURIComponent(sn)}`, Type.Object({}, { additionalProperties: true }), project.uuid);
                return project;
            } catch {
                continue;
            }
        }

        return undefined;
    }

    async devices(env: Static<typeof InputSchema>, projects: Static<typeof Project>[]): Promise<Tracked[]> {
        const tracked: Map<string, Tracked> = new Map();
        const seen: Set<string> = new Set();

        const DeviceList = Type.Object({
            list: Type.Optional(Type.Array(DevicePair))
        }, { additionalProperties: true });

        const track = (pair: Static<typeof DevicePair>, project: Static<typeof Project>) => {
            let gateway = pair.gateway;

            // Aircraft flown from a Remote Controller are listed in the gateway slot
            if (gateway && deviceClass(gateway, 'dock') === 'drone') {
                if (!seen.has(gateway.sn)) {
                    seen.add(gateway.sn);
                    tracked.set(gateway.sn, { device_class: 'drone', device: gateway, project });
                }
                gateway = undefined;
            } else if (gateway && !seen.has(gateway.sn)) {
                seen.add(gateway.sn);
                const device_class = deviceClass(gateway, 'dock');

                if (
                    (device_class === 'dock' && env.INCLUDE_DOCKS)
                    || (device_class === 'controller' && env.INCLUDE_CONTROLLERS)
                ) {
                    tracked.set(gateway.sn, { device_class, device: gateway, project });
                }
            }

            if (pair.drone && !seen.has(pair.drone.sn)) {
                seen.add(pair.drone.sn);
                tracked.set(pair.drone.sn, {
                    device_class: 'drone',
                    device: pair.drone,
                    gateway,
                    project
                });
            }
        };

        for (const project of projects) {
            try {
                const data = await this.dji(env, '/project/device', DeviceList, project.uuid);
                for (const pair of data.list || []) track(pair, project);
            } catch (err) {
                console.error(`not ok - project ${project.name || project.uuid}:`, err instanceof Error ? err.message : err);
            }
        }

        // The Project device list omits aircraft that are not paired with a Dock
        // so the Organization device list is also consulted
        const pending: Static<typeof DevicePair>[] = [];
        for (const device_model_class of ['drone', 'airport']) {
            try {
                const data = await this.dji(env, `/device?device_model_class=${device_model_class}`, DeviceList);

                for (const pair of data.list || []) {
                    const sn = pair.gateway?.sn || pair.drone?.sn;
                    if (!sn || seen.has(sn)) continue;

                    seen.add(sn);
                    pending.push(pair);
                }
            } catch (err) {
                console.error(`not ok - organization ${device_model_class} devices:`, err instanceof Error ? err.message : err);
            }
        }

        for (const pair of pending) {
            const sn = String(pair.gateway?.sn || pair.drone?.sn);
            const project = await this.project(env, sn, projects);

            if (project) {
                if (pair.gateway) seen.delete(pair.gateway.sn);
                if (pair.drone) seen.delete(pair.drone.sn);
                track(pair, project);
            } else if (env.DEBUG) {
                console.log(`ok - ${sn} is not in a tracked project`);
            }
        }

        return Array.from(tracked.values());
    }

    included(env: Static<typeof InputSchema>, entry: Tracked): boolean {
        if (entry.device_class === 'dock' && !env.INCLUDE_DOCKS) return false;
        if (entry.device_class === 'controller' && !env.INCLUDE_CONTROLLERS) return false;
        return true;
    }

    organization(env: Static<typeof InputSchema>, projects: Static<typeof Project>[]): string {
        try {
            const claims = JSON.parse(Buffer.from(env.DJI_ORG_KEY.split('.')[1], 'base64url').toString());
            if (typeof claims.organization_uuid === 'string' && claims.organization_uuid) return claims.organization_uuid;
        } catch {
            // Not a JWT
        }

        for (const project of projects) {
            if (project.org_uuid) return project.org_uuid;
        }

        throw new Error('Unable to determine the FlightHub Organization UUID');
    }

    /**
     * Subscribe to the FlightHub 2 web socket used by its own UI and submit
     * Cloud API OSD telemetry as it arrives until the stream duration elapses
     */
    async stream(
        env: Static<typeof InputSchema>,
        projects: Static<typeof Project>[],
        known: Map<string, Tracked>
    ): Promise<void> {
        const url = new URL('/duplex/web', env.DJI_API_URL);
        url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
        url.searchParams.set('x-user-token', env.DJI_ORG_KEY);

        const organization = this.organization(env, projects);
        const byProject = new Map(projects.map((project) => [project.uuid, project]));

        const latest: Map<string, Static<typeof DeviceState>> = new Map();
        const projectOf: Map<string, Static<typeof Project>> = new Map();
        const dirty: Set<string> = new Set();
        let received = 0;
        let flushing = false;

        const ws = new WebSocket(url);

        const send = (message: Record<string, unknown>) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
        };

        const flush = async () => {
            if (flushing || !dirty.size) return;
            flushing = true;

            try {
                const features: Static<typeof Feature.InputFeature>[] = [];

                for (const sn of dirty) {
                    const state = latest.get(sn);
                    if (!state) continue;

                    const tracked = known.get(sn) || inferTracked(sn, state, projectOf.get(sn));
                    if (!this.included(env, tracked)) continue;

                    features.push(...stateToFeatures(tracked, state, true));
                }

                dirty.clear();

                if (features.length) {
                    const fc: Static<typeof Feature.InputFeatureCollection> = { type: 'FeatureCollection', features };
                    if (env.DEBUG) console.log(JSON.stringify(fc));
                    await this.submit(fc);
                }
            } catch (err) {
                console.error('not ok - stream submit:', err instanceof Error ? err.message : err);
            } finally {
                flushing = false;
            }
        };

        await new Promise<void>((resolve) => {
            const timers: NodeJS.Timeout[] = [];
            let finished = false;

            const finish = () => {
                if (finished) return;
                finished = true;
                for (const timer of timers) clearInterval(timer);
                clearTimeout(deadline);
                try { ws.close(); } catch { /* already closed */ }
                resolve();
            };

            const deadline = setTimeout(finish, env.STREAM_DURATION * 1000);

            ws.addEventListener('open', () => {
                send({
                    biz_code: 'biz_scope',
                    version: '1.0',
                    timestamp: Date.now(),
                    msg_trace_id: crypto.randomUUID(),
                    data: {
                        codes: ['device_osd', 'device_state', 'device_online', 'device_offline', 'device_update_topo'],
                        project: '',
                        organization
                    }
                });

                timers.push(setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send('ping'); }, 15000));
                timers.push(setInterval(() => { flush(); }, env.STREAM_INTERVAL * 1000));
            });

            ws.addEventListener('message', (event) => {
                let message: {
                    biz_code?: unknown,
                    msg_trace_id?: unknown,
                    need_reply?: unknown,
                    to?: unknown,
                    data?: { sn?: unknown, host?: unknown }
                };

                try {
                    message = JSON.parse(String(event.data));
                } catch {
                    return;
                }

                if (message.need_reply && message.msg_trace_id) {
                    send({ biz_code: 'ack_reply', timestamp: Date.now(), data: { msg_trace_id: message.msg_trace_id } });
                }

                if (message.biz_code !== 'device_osd' || typeof message.data?.sn !== 'string' || !message.data.host) return;

                received++;

                const sn = message.data.sn;

                try {
                    const host = stripNulls(message.data.host) as Record<string, unknown>;
                    latest.set(sn, this.type(DeviceState, { ...(latest.get(sn) || {}), ...host }));
                } catch (err) {
                    if (env.DEBUG) console.log(`ok - ${sn} telemetry rejected: ${err instanceof Error ? err.message : err}`);
                    return;
                }

                for (const uuid of Array.isArray(message.to) ? message.to : []) {
                    const project = byProject.get(String(uuid));
                    if (project) projectOf.set(sn, project);
                }

                dirty.add(sn);
            });

            ws.addEventListener('error', () => {
                console.error('not ok - websocket error');
            });

            ws.addEventListener('close', (event) => {
                console.log(`ok - websocket closed (${event.code}) after ${received} telemetry messages`);
                finish();
            });
        });

        await flush();
    }

    async features(
        env: Static<typeof InputSchema>,
        tracked: Tracked[]
    ): Promise<Static<typeof Feature.InputFeature>[]> {
        const features: Static<typeof Feature.InputFeature>[] = [];

        const concurrency = 5;
        for (let i = 0; i < tracked.length; i += concurrency) {
            await Promise.all(tracked.slice(i, i + concurrency).map(async (entry) => {
                try {
                    const data = await this.dji(
                        env,
                        `/device/${encodeURIComponent(entry.device.sn)}/state`,
                        DeviceStateResponse,
                        entry.project.uuid
                    );

                    const feats = data.device_state ? stateToFeatures(entry, data.device_state) : [];

                    if (feats.length) {
                        features.push(...feats);
                    } else if (env.DEBUG) {
                        console.log(`ok - ${entry.device.sn} did not report a location`);
                    }
                } catch (err) {
                    console.error(`not ok - device ${entry.device.sn}:`, err instanceof Error ? err.message : err);
                }
            }));
        }

        return features;
    }

    async control(): Promise<void> {
        const env = await this.env(InputSchema);

        const projects = await this.projects(env);
        console.log(`ok - found ${projects.length} projects`);

        const devices = await this.devices(env, projects);
        const tracked = devices.filter((entry) => env.INCLUDE_OFFLINE || entry.device.device_online_status);
        console.log(`ok - found ${devices.length} devices (${tracked.length} polled)`);

        const features = await this.features(env, tracked);

        if (env.INCLUDE_PINS) {
            const pins = await this.pins(env, projects);
            console.log(`ok - found ${pins.length} map elements`);
            features.push(...pins);
        }

        if (features.length) {
            const fc: Static<typeof Feature.InputFeatureCollection> = {
                type: 'FeatureCollection',
                features
            };

            if (env.DEBUG) console.log(JSON.stringify(fc));

            await this.submit(fc);
        }

        if (env.DJI_WEBSOCKET) {
            await this.stream(env, projects, new Map(devices.map((entry) => [entry.device.sn, entry])));
        }
    }
}

await local(await Task.init(import.meta.url), import.meta.url);
export async function handler(event: Event = {}) {
    return await internal(new Task(import.meta.url), event);
}
