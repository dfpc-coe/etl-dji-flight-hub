import crypto from 'node:crypto';
import { Type } from '@sinclair/typebox';
import type { Static, TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { fetch } from '@tak-ps/etl';

/**
 * FlightHub 2 OpenAPI client & the DJI data model it returns
 *
 * Every request carries the Organization Key as `X-User-Token` and, where a
 * Project scope is required, the Project UUID as `X-Project-Uuid`
 */

export const Project = Type.Object({
    uuid: Type.String(),
    name: Type.Optional(Type.String()),
    org_uuid: Type.Optional(Type.String())
}, { additionalProperties: true });

export const Device = Type.Object({
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

export const DevicePair = Type.Object({
    gateway: Type.Optional(Device),
    drone: Type.Optional(Device)
}, { additionalProperties: true });

/**
 * Payload telemetry - published as a `cameras` array in the Thing Model and
 * additionally as objects keyed by payload index (`88-0-0`) on the OSD stream
 */
export const Camera = Type.Object({
    payload_index: Type.Optional(Type.String()),
    gimbal_yaw: Type.Optional(Type.Number()),
    gimbal_pitch: Type.Optional(Type.Number()),
    measure_target_latitude: Type.Optional(Type.Number()),
    measure_target_longitude: Type.Optional(Type.Number()),
    measure_target_altitude: Type.Optional(Type.Number()),
    measure_target_distance: Type.Optional(Type.Number()),
    measure_target_error_state: Type.Optional(Type.Union([Type.Integer(), Type.String()]))
}, { additionalProperties: true });

/**
 * Subset of the Thing Model shared by Aircraft, Docks & Remote Controllers
 */
export const DeviceState = Type.Object({
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

const DeviceList = Type.Object({
    list: Type.Optional(Type.Array(DevicePair))
}, { additionalProperties: true });

const ProjectList = Type.Object({
    list: Type.Optional(Type.Array(Project))
}, { additionalProperties: true });

export type DeviceClass = 'drone' | 'dock' | 'controller';

// The device lists report mode_code as an integer while the Thing Model reports the named value
export const DroneModes = [
    'standby', 'takeoff_preparation', 'takeoff_preparation_completed', 'manual_flight',
    'automatic_takeoff', 'wayline_flight', 'panoramic_photography', 'intelligent_tracking',
    'adsb_avoidance', 'auto_returning_to_home', 'automatic_landing', 'forced_landing',
    'three_blade_landing', 'upgrading', 'not_connected', 'apas', 'virtual_stick_state',
    'live_flight_controls', 'airborne_rtk_fixing_mode', 'dock_address_selecting', 'poi'
];

export const DockModes = [
    'idle', 'on_site_debugging', 'remote_debugging', 'firmware_upgrade_in_progress',
    'in_operation', 'to_be_calibrated'
];

export const GroundedModes = new Set([
    'standby', 'takeoff_preparation', 'takeoff_preparation_completed',
    'upgrading', 'not_connected', 'dock_address_selecting'
]);

export const LaserStates = ['normal', 'too_close', 'too_far', 'no_signal'];

/**
 * Strictly type an API response, applying defaults & converting scalar types
 */
export function validate<T extends TSchema>(schema: T, body: unknown): Static<T> {
    Value.Default(schema, body);
    Value.Clean(schema, body);
    Value.Convert(schema, body);

    if (Value.Check(schema, body)) return body;

    const error = Value.Errors(schema, body).First();
    throw new Error(`Unexpected FlightHub response: ${error?.path} ${error?.message}`);
}

// FlightHub 2 returns null in place of empty collections & unset values
export function stripNulls(value: unknown): unknown {
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

/**
 * DJI Device Enums are composed as domain-type-sub_type where the domain is
 * 0: Aircraft, 1: Payload, 2: Remote Controller, 3: Dock
 */
export function deviceClass(device: Static<typeof Device>, fallback: DeviceClass): DeviceClass {
    const domain = device.device_model?.domain ?? device.device_model?.key?.split('-')[0];

    if (domain === '0') return 'drone';
    if (domain === '2') return 'controller';
    if (domain === '3') return 'dock';

    return fallback;
}

export function modeName(device_class: DeviceClass, code?: string | number): string | undefined {
    if (code === undefined || code === '') return undefined;
    if (device_class === 'controller') return undefined;

    const index = Number(code);
    if (Number.isNaN(index)) return String(code);

    return (device_class === 'drone' ? DroneModes : DockModes)[index] || String(code);
}

export function validPosition(latitude?: number, longitude?: number): boolean {
    if (latitude === undefined || longitude === undefined) return false;
    // Devices without a position fix report 0,0
    if (latitude === 0 && longitude === 0) return false;
    return Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;
}

/**
 * Payload telemetry objects in the order they should be consulted - the payload
 * index keyed objects carry the gimbal & Laser Range Finder, `cameras` only settings
 */
export function payloads(state: Static<typeof DeviceState>): Static<typeof Camera>[] {
    const found: Static<typeof Camera>[] = [];

    for (const [key, value] of Object.entries(state)) {
        if (!/^\d+-\d+-\d+$/.test(key) || !value || typeof value !== 'object' || Array.isArray(value)) continue;
        found.push(value as Static<typeof Camera>);
    }

    return found.concat(state.cameras || []);
}

export type LaserTarget = {
    latitude: number;
    longitude: number;
    altitude?: number;
    distance?: number;
    state: string;
};

export function laser(state: Static<typeof DeviceState>): LaserTarget | undefined {
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

export function gimbal(state: Static<typeof DeviceState>): { yaw: number, pitch: number } | undefined {
    for (const camera of payloads(state)) {
        if (typeof camera.gimbal_yaw !== 'number') continue;

        return {
            yaw: camera.gimbal_yaw,
            pitch: typeof camera.gimbal_pitch === 'number' ? camera.gimbal_pitch : 0
        };
    }

    return undefined;
}

export type DJIApiOptions = {
    url: string;
    version: string;
    key: string;
    unsafe?: boolean;
};

export class DJIApi {
    readonly url: string;
    readonly version: string;
    readonly key: string;
    readonly unsafe: boolean;

    constructor(opts: DJIApiOptions) {
        this.url = opts.url.replace(/\/+$/, '');
        this.version = opts.version;
        this.key = opts.key;
        this.unsafe = opts.unsafe || false;
    }

    /**
     * Perform an authenticated GET, unwrapping the standard `{ code, message, data }`
     * envelope. Paths outside the OpenAPI prefix (ie `/map/api/...`) are used verbatim
     */
    async get<T extends TSchema>(path: string, schema: T, project?: string): Promise<Static<T>> {
        const prefix = path.startsWith('/map/') ? '' : `/openapi/${this.version}`;
        const url = new URL(`${this.url}${prefix}${path}`);

        const headers: Record<string, string> = {
            'X-User-Token': this.key,
            'X-Request-Id': crypto.randomUUID(),
            'X-Language': 'en',
            'Accept': 'application/json'
        };

        if (project) headers['X-Project-Uuid'] = project;

        const res = await fetch(url, {
            method: 'GET',
            headers,
            // Local development escape hatch - node-safeurl blocks private hostnames by default
            safeUrlAllow: this.unsafe ? [url.origin] : undefined
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

        return validate(schema, stripNulls(envelope.data ?? {}));
    }

    /**
     * Every Project of the Organization
     */
    async projects(): Promise<Static<typeof Project>[]> {
        const projects: Map<string, Static<typeof Project>> = new Map();

        const page_size = 100;
        for (let page = 1; page <= 100; page++) {
            const data = await this.get(`/project?page=${page}&page_size=${page_size}`, ProjectList);

            const list = (data.list || []).filter((project) => !projects.has(project.uuid));
            for (const project of list) projects.set(project.uuid, project);

            // A page without unseen projects also guards against pagination being ignored
            if (!list.length || (data.list || []).length < page_size) break;
        }

        return Array.from(projects.values());
    }

    /**
     * Dock scene gateway & aircraft pairs of a Project - aircraft flown from a
     * Remote Controller are not included, see organizationDevices()
     */
    async projectDevices(project: string): Promise<Static<typeof DevicePair>[]> {
        const data = await this.get('/project/device', DeviceList, project);
        return data.list || [];
    }

    /**
     * Organization scope device list - aircraft flown from a Remote Controller
     * are returned in the gateway slot of a pair with no drone
     */
    async organizationDevices(device_model_class: 'drone' | 'airport'): Promise<Static<typeof DevicePair>[]> {
        const data = await this.get(`/device?device_model_class=${device_model_class}`, DeviceList);
        return data.list || [];
    }

    /**
     * Resolve the Project a device belongs to - the Organization scope device
     * list does not include it and the Thing Model is only served under that Project
     */
    async deviceProject(
        sn: string,
        projects: Static<typeof Project>[]
    ): Promise<Static<typeof Project> | undefined> {
        for (const project of projects) {
            try {
                await this.get(`/project/device/${encodeURIComponent(sn)}`, Type.Object({}, { additionalProperties: true }), project.uuid);
                return project;
            } catch {
                continue;
            }
        }

        return undefined;
    }

    /**
     * Thing Model of a device, which contains its location
     */
    async deviceState(sn: string, project: string): Promise<Static<typeof DeviceState> | undefined> {
        const data = await this.get(`/device/${encodeURIComponent(sn)}/state`, DeviceStateResponse, project);
        return data.device_state;
    }

    /**
     * Organization UUID from the Organization Key's JWT claims, falling back to the Projects
     */
    organization(projects: Static<typeof Project>[]): string {
        try {
            const claims = JSON.parse(Buffer.from(this.key.split('.')[1], 'base64url').toString());
            if (typeof claims.organization_uuid === 'string' && claims.organization_uuid) return claims.organization_uuid;
        } catch {
            // Not a JWT
        }

        for (const project of projects) {
            if (project.org_uuid) return project.org_uuid;
        }

        throw new Error('Unable to determine the FlightHub Organization UUID');
    }
}
