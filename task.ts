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
    'POLL_INTERVAL': Type.Integer({
        default: 10,
        description: 'Seconds between location updates while an aircraft is airborne - Set to 0 to poll once per scheduled invocation'
    }),
    'POLL_DURATION': Type.Integer({
        default: 50,
        description: 'Maximum number of seconds to keep polling per scheduled invocation - should be less than both the Layer Timeout and the schedule interval'
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
    serial: Type.String({ description: 'Device Serial Number' }),
    device_class: Type.String({ description: 'drone, dock or controller' }),
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
    firmware_version: Type.Optional(Type.String({ description: 'Firmware Version' }))
});

const Project = Type.Object({
    uuid: Type.String(),
    name: Type.Optional(Type.String())
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
const DeviceState = Type.Object({
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

function gimbal(state: Static<typeof DeviceState>): { yaw: number, pitch: number } | undefined {
    for (const [key, value] of Object.entries(state)) {
        if (!/^\d+-\d+-\d+$/.test(key) || !value || typeof value !== 'object') continue;

        const payload = value as Record<string, unknown>;
        if (typeof payload.gimbal_yaw !== 'number') continue;

        return {
            yaw: payload.gimbal_yaw,
            pitch: typeof payload.gimbal_pitch === 'number' ? payload.gimbal_pitch : 0
        };
    }

    return undefined;
}

function stateToFeature(
    tracked: Tracked,
    state: Static<typeof DeviceState>
): Static<typeof Feature.InputFeature> | null {
    const { device, device_class, gateway, project } = tracked;

    if (state.latitude === undefined || state.longitude === undefined) return null;
    // Devices without a position fix report 0,0
    if (state.latitude === 0 && state.longitude === 0) return null;
    if (Math.abs(state.latitude) > 90 || Math.abs(state.longitude) > 180) return null;

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
        firmware_version: state.firmware_version
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
            coordinates: [state.longitude, state.latitude, state.height ?? 0]
        }
    };

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
                range: 100
            };
        }
    }

    return feat;
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
        const url = new URL(`${env.DJI_API_URL.replace(/\/+$/, '')}/openapi/${env.DJI_API_VERSION}${path}`);

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

    async devices(env: Static<typeof InputSchema>, projects: Static<typeof Project>[]): Promise<Tracked[]> {
        const tracked: Map<string, Tracked> = new Map();

        for (const project of projects) {
            let pairs: Static<typeof DevicePair>[];
            try {
                const data = await this.dji(env, '/project/device', Type.Object({
                    list: Type.Optional(Type.Array(DevicePair))
                }, { additionalProperties: true }), project.uuid);

                pairs = data.list || [];
            } catch (err) {
                console.error(`not ok - project ${project.name || project.uuid}:`, err instanceof Error ? err.message : err);
                continue;
            }

            for (const pair of pairs) {
                if (pair.gateway) {
                    const device_class = deviceClass(pair.gateway, 'dock');

                    if (
                        (device_class === 'dock' && env.INCLUDE_DOCKS)
                        || (device_class === 'controller' && env.INCLUDE_CONTROLLERS)
                    ) {
                        tracked.set(pair.gateway.sn, { device_class, device: pair.gateway, project });
                    }
                }

                if (pair.drone) {
                    tracked.set(pair.drone.sn, {
                        device_class: 'drone',
                        device: pair.drone,
                        gateway: pair.gateway,
                        project
                    });
                }
            }
        }

        return Array.from(tracked.values()).filter((entry) => {
            return env.INCLUDE_OFFLINE || entry.device.device_online_status;
        });
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

                    const feat = data.device_state ? stateToFeature(entry, data.device_state) : null;

                    if (feat) {
                        features.push(feat);
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
        const layer = await this.fetchLayer();

        const projects = await this.projects(env);
        console.log(`ok - found ${projects.length} projects`);

        let tracked = await this.devices(env, projects);
        console.log(`ok - found ${tracked.length} devices`);

        if (!tracked.length) return;

        // Leave enough of the Lambda timeout budget to flush the final submission
        const deadline = Date.now() + Math.min(env.POLL_DURATION, Math.max(0, (layer.timeout || 60) - 15)) * 1000;

        for (;;) {
            const started = Date.now();

            const features = await this.features(env, tracked);

            if (features.length) {
                const fc: Static<typeof Feature.InputFeatureCollection> = {
                    type: 'FeatureCollection',
                    features
                };

                if (env.DEBUG) console.log(JSON.stringify(fc));

                await this.submit(fc);
            }

            const airborne = features.some((feat) => {
                return (feat.properties.metadata as Static<typeof OutputSchema>).airborne;
            });

            if (env.POLL_INTERVAL <= 0 || !airborne) break;

            const wait = Math.max(0, env.POLL_INTERVAL * 1000 - (Date.now() - started));
            if (Date.now() + wait >= deadline) break;

            await new Promise((resolve) => setTimeout(resolve, wait));

            // Docks do not move so are only submitted once per invocation
            tracked = tracked.filter((entry) => entry.device_class !== 'dock');
        }
    }
}

await local(await Task.init(import.meta.url), import.meta.url);
export async function handler(event: Event = {}) {
    return await internal(new Task(import.meta.url), event);
}
