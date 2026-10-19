import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';
import type { Feature } from '@tak-ps/etl';
import type { DJIApi, Project } from './dji-api.js';
import { validPosition } from './dji-api.js';

/**
 * Map pins, lines & polygons of a Project
 *
 * Pilot 2 synchronises the elements drawn on a Remote Controller into the App
 * Shared element group of the Project. FlightHub 2 serves them on the DJI Cloud
 * API map element route, which accepts the Organization Key
 */

export const MapElement = Type.Object({
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

export const MapElementGroup = Type.Object({
    id: Type.String(),
    name: Type.Optional(Type.String()),
    type: Type.Optional(Type.Union([Type.Integer(), Type.String()])),
    is_distributed: Type.Optional(Type.Boolean()),
    elements: Type.Optional(Type.Array(MapElement))
}, { additionalProperties: true });

const MapElementGroups = Type.Union([
    Type.Array(MapElementGroup),
    Type.Object({}, { additionalProperties: true })
]);

export const GroupTypes: Record<string, string> = {
    '0': 'custom',
    '1': 'default',
    '2': 'app_shared'
};

export const MarkerCoTType = {
    Point: 'u-d-p',
    LineString: 'u-d-f',
    Polygon: 'u-d-f'
} as const;

export type Marker = {
    element: Static<typeof MapElement>;
    group: Static<typeof MapElementGroup>;
    project: Static<typeof Project>;
};

export type MarkerMetadata = {
    device_class: 'pin';
    element_id: string;
    element_type: 'point' | 'line' | 'polygon';
    group?: string;
    group_type?: string;
    author?: string;
    color?: string;
    project?: string;
    project_uuid: string;
    created?: string;
    updated?: string;
};

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
export function markerGeometry(type: string | undefined, coordinates: unknown): Static<typeof Feature.InputFeature>['geometry'] | null {
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

/**
 * Every element of every element group of a Project
 */
export async function markers(
    api: DJIApi,
    project: Static<typeof Project>,
    opts: { distributedOnly?: boolean } = {}
): Promise<Marker[]> {
    const query = opts.distributedOnly ? '?is_distributed=true' : '';
    const data = await api.get(
        `/map/api/v1/workspaces/${encodeURIComponent(project.uuid)}/element-groups${query}`,
        MapElementGroups,
        project.uuid
    );

    const found: Marker[] = [];

    for (const group of Array.isArray(data) ? data : []) {
        for (const element of group.elements || []) {
            found.push({ element, group, project });
        }
    }

    return found;
}

/**
 * CoT Feature for a map element - null when it has no usable geometry
 */
export function markerToFeature(marker: Marker): Static<typeof Feature.InputFeature> | null {
    const { element, group, project } = marker;

    const content = element.resource?.content;
    const geometry = markerGeometry(content?.geometry?.type, content?.geometry?.coordinates);
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

    const metadata: MarkerMetadata = {
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
            type: MarkerCoTType[geometry.type],
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
