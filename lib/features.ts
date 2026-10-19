import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';
import type { Feature } from '@tak-ps/etl';
import type { Device, DeviceClass, DeviceState, Project } from './dji-api.js';
import { GroundedModes, deviceClass, gimbal, laser, modeName, validPosition } from './dji-api.js';

/**
 * Device state => CoT Features
 */

/**
 * Known properties of the GeoJSON Feature `.properties.metadata` object
 */
export const OutputSchema = Type.Object({
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

export type Tracked = {
    device_class: DeviceClass;
    device: Static<typeof Device>;
    gateway?: Static<typeof Device>;
    project: Static<typeof Project>;
};

export const CoTType: Record<DeviceClass, string> = {
    drone: 'a-f-A-M-H-Q',
    dock: 'a-f-G-I-B-A',
    controller: 'a-f-G-U-C-V-U-R'
};

// Sensor Point of Interest
export const LaserCoTType = 'b-m-p-s-p-i';

// Range/FoV are not published so a representative FoV is used
export const SensorFoV = 45;
export const SensorRange = 100;

export function humanize(value: string): string {
    return value.split('_').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

export function compass(degrees: number): number {
    return ((degrees % 360) + 360) % 360;
}

/**
 * CoT Features for a device - the device itself and, while the Laser Range
 * Finder is measuring, its target. Empty when the device has no position
 */
export function stateToFeatures(
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

    if (device_class === 'drone') {
        if (state.horizontal_speed !== undefined) feat.properties.speed = state.horizontal_speed;
        if (state.attitude_head !== undefined) feat.properties.course = compass(state.attitude_head);

        const payload = gimbal(state);
        if (airborne && payload) {
            feat.properties.sensor = {
                azimuth: compass(payload.yaw),
                elevation: payload.pitch,
                fov: SensorFoV,
                range: target?.distance ?? SensorRange
            };
        }
    }

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

    return features;
}

/**
 * Devices only seen on the telemetry stream are classified by the shape of their OSD
 */
export function inferTracked(sn: string, state: Static<typeof DeviceState>, project?: Static<typeof Project>): Tracked {
    const keys = new Set(Object.keys(state));

    let device_class: DeviceClass = 'controller';
    if (['attitude_head', 'cameras', 'home_distance', 'total_flight_sorties'].some((key) => keys.has(key))) {
        device_class = 'drone';
    } else if (['drone_in_dock', 'network_state', 'sub_device', 'cover_state'].some((key) => keys.has(key))) {
        device_class = 'dock';
    }

    return { device_class, device: { sn }, project: project || { uuid: '' } };
}
