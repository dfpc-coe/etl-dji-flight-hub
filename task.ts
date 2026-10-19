import type { Static, TSchema } from '@sinclair/typebox';
import { Type } from '@sinclair/typebox';
import type { Event } from '@tak-ps/etl';
import ETL, { SchemaType, handler as internal, local, Feature, DataFlowType, InvocationType } from '@tak-ps/etl';
import { DJIApi, DeviceState, deviceClass, stripNulls, validate } from './lib/dji-api.js';
import type { DevicePair, Project } from './lib/dji-api.js';
import { markers, markerToFeature } from './lib/dji-api-markers.js';
import { DJISocket } from './lib/dji-socket.js';
import type { Telemetry } from './lib/dji-socket.js';
import { OutputSchema, inferTracked, stateToFeatures } from './lib/features.js';
import type { Tracked } from './lib/features.js';

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

type Env = Static<typeof InputSchema>;
type InputFeature = Static<typeof Feature.InputFeature>;

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

    dji(env: Env): DJIApi {
        return new DJIApi({
            url: env.DJI_API_URL,
            version: env.DJI_API_VERSION,
            key: env.DJI_ORG_KEY,
            unsafe: Boolean(process.env.DJI_UNSAFE_URLS)
        });
    }

    /**
     * Projects to track - every Project of the Organization unless limited by DJI_PROJECTS
     */
    async projects(env: Env, api: DJIApi): Promise<Static<typeof Project>[]> {
        const projects = await api.projects();

        const limit = new Set(env.DJI_PROJECTS.map((project) => project.ProjectUUID.trim()));
        if (!limit.size) return projects;

        return Array.from(limit).map((uuid) => {
            return projects.find((project) => project.uuid === uuid) || { uuid };
        });
    }

    included(env: Env, entry: Tracked): boolean {
        if (entry.device_class === 'dock' && !env.INCLUDE_DOCKS) return false;
        if (entry.device_class === 'controller' && !env.INCLUDE_CONTROLLERS) return false;
        return true;
    }

    /**
     * Every device of the tracked Projects, from the Project device lists and the
     * Organization device list which is the only source of aircraft flown from a
     * Remote Controller
     */
    async devices(env: Env, api: DJIApi, projects: Static<typeof Project>[]): Promise<Tracked[]> {
        const tracked: Map<string, Tracked> = new Map();
        const seen: Set<string> = new Set();

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
                const entry = { device_class: deviceClass(gateway, 'dock'), device: gateway, project };
                if (this.included(env, entry)) tracked.set(gateway.sn, entry);
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
                for (const pair of await api.projectDevices(project.uuid)) track(pair, project);
            } catch (err) {
                console.error(`not ok - project ${project.name || project.uuid}:`, err instanceof Error ? err.message : err);
            }
        }

        const pending: Static<typeof DevicePair>[] = [];
        for (const device_model_class of ['drone', 'airport'] as const) {
            try {
                for (const pair of await api.organizationDevices(device_model_class)) {
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
            const project = await api.deviceProject(sn, projects);

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

    /**
     * Thing Model snapshot of each device
     */
    async snapshot(env: Env, api: DJIApi, tracked: Tracked[]): Promise<InputFeature[]> {
        const features: InputFeature[] = [];

        const concurrency = 5;
        for (let i = 0; i < tracked.length; i += concurrency) {
            await Promise.all(tracked.slice(i, i + concurrency).map(async (entry) => {
                try {
                    const state = await api.deviceState(entry.device.sn, entry.project.uuid);
                    const feats = state ? stateToFeatures(entry, state) : [];

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

    /**
     * Map pins, lines & polygons of each Project
     */
    async pins(env: Env, api: DJIApi, projects: Static<typeof Project>[]): Promise<InputFeature[]> {
        const features: InputFeature[] = [];

        for (const project of projects) {
            try {
                for (const marker of await markers(api, project, { distributedOnly: env.PINS_DISTRIBUTED_ONLY })) {
                    const feat = markerToFeature(marker);

                    if (feat) {
                        features.push(feat);
                    } else if (env.DEBUG) {
                        console.log(`ok - element ${marker.element.id} has no usable geometry`);
                    }
                }
            } catch (err) {
                console.error(`not ok - pins for project ${project.name || project.uuid}:`, err instanceof Error ? err.message : err);
            }
        }

        return features;
    }

    /**
     * Submit live telemetry as it arrives until the stream duration elapses
     */
    async stream(env: Env, api: DJIApi, projects: Static<typeof Project>[], known: Map<string, Tracked>): Promise<void> {
        const byProject = new Map(projects.map((project) => [project.uuid, project]));

        const latest: Map<string, Static<typeof DeviceState>> = new Map();
        const projectOf: Map<string, Static<typeof Project>> = new Map();
        const dirty: Set<string> = new Set();
        let flushing = false;

        const onTelemetry = (telemetry: Telemetry) => {
            try {
                const host = stripNulls(telemetry.host) as Record<string, unknown>;
                latest.set(telemetry.sn, validate(DeviceState, { ...(latest.get(telemetry.sn) || {}), ...host }));
            } catch (err) {
                if (env.DEBUG) console.log(`ok - ${telemetry.sn} telemetry rejected: ${err instanceof Error ? err.message : err}`);
                return;
            }

            for (const uuid of telemetry.to) {
                const project = byProject.get(uuid);
                if (project) projectOf.set(telemetry.sn, project);
            }

            dirty.add(telemetry.sn);
        };

        const flush = async () => {
            if (flushing || !dirty.size) return;
            flushing = true;

            try {
                const features: InputFeature[] = [];

                for (const sn of dirty) {
                    const state = latest.get(sn);
                    if (!state) continue;

                    const tracked = known.get(sn) || inferTracked(sn, state, projectOf.get(sn));
                    if (!this.included(env, tracked)) continue;

                    features.push(...stateToFeatures(tracked, state, true));
                }

                dirty.clear();

                if (features.length) await this.submitFeatures(env, features);
            } catch (err) {
                console.error('not ok - stream submit:', err instanceof Error ? err.message : err);
            } finally {
                flushing = false;
            }
        };

        const socket = new DJISocket({
            url: api.url,
            key: api.key,
            organization: api.organization(projects)
        });

        await socket.stream({
            duration: env.STREAM_DURATION,
            interval: env.STREAM_INTERVAL,
            onTelemetry,
            onInterval: flush,
            onClose: (code, received) => console.log(`ok - websocket closed (${code}) after ${received} telemetry messages`)
        });

        await flush();
    }

    async submitFeatures(env: Env, features: InputFeature[]): Promise<void> {
        const fc: Static<typeof Feature.InputFeatureCollection> = {
            type: 'FeatureCollection',
            features
        };

        if (env.DEBUG) console.log(JSON.stringify(fc));

        await this.submit(fc);
    }

    async control(): Promise<void> {
        const env = await this.env(InputSchema);
        const api = this.dji(env);

        const projects = await this.projects(env, api);
        console.log(`ok - found ${projects.length} projects`);

        const devices = await this.devices(env, api, projects);
        const polled = devices.filter((entry) => env.INCLUDE_OFFLINE || entry.device.device_online_status);
        console.log(`ok - found ${devices.length} devices (${polled.length} polled)`);

        const features = await this.snapshot(env, api, polled);

        if (env.INCLUDE_PINS) {
            const pins = await this.pins(env, api, projects);
            console.log(`ok - found ${pins.length} map elements`);
            features.push(...pins);
        }

        if (features.length) await this.submitFeatures(env, features);

        if (env.DJI_WEBSOCKET) {
            await this.stream(env, api, projects, new Map(devices.map((entry) => [entry.device.sn, entry])));
        }
    }
}

await local(await Task.init(import.meta.url), import.meta.url);
export async function handler(event: Event = {}) {
    return await internal(new Task(import.meta.url), event);
}
