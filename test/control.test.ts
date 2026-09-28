import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Static } from '@sinclair/typebox';
import type { Feature } from '@tak-ps/etl';

process.env.ETL_API = process.env.ETL_API || 'http://localhost:5001';
process.env.ETL_LAYER = process.env.ETL_LAYER || '1';
process.env.ETL_TOKEN = process.env.ETL_TOKEN || 'etl.test-token';
process.env.DJI_UNSAFE_URLS = 'true';

const { default: Task } = await import('../task.js');

type FeatureCollection = Static<typeof Feature.InputFeatureCollection>;

type Mock = {
    base: string;
    requests: Array<{ url: string; project: string | undefined; request_id: string | undefined }>;
    states: Record<string, unknown>;
    close: () => Promise<void>;
};

const PROJECT_A = '93df839d-ae74-4f04-842e-2f1f81c89a66';
const PROJECT_B = '03504ad1-3868-4fe2-b715-36ef6e16f549';

const DOCK = {
    sn: '7CTDM3D00BZNVZ',
    callsign: 'Test Dock',
    device_model: { key: '3-2-0', domain: '3', type: '2', sub_type: '0', name: 'DJI Dock 2', class: 'airport' },
    device_online_status: true,
    mode_code: 4,
    camera_list: null
};

const DOCK_DRONE = {
    sn: '1581F6Q8D242100CPWEK',
    callsign: '',
    device_model: { key: '0-91-1', domain: '0', type: '91', sub_type: '1', name: 'M3TD', class: 'drone' },
    device_online_status: true,
    mode_code: 5,
    camera_list: null
};

const CONTROLLER = {
    sn: '5YSZL260021E9A',
    callsign: 'Pilot 1',
    device_model: { key: '2-174-0', domain: '2', type: '174', sub_type: '0', name: 'DJI RC Plus 2', class: 'rc' },
    device_online_status: true
};

const OFFLINE_DRONE = {
    sn: '1581F8HGX253S00A05MQ',
    callsign: 'Matrice 4T',
    device_model: { key: '0-99-1', domain: '0', type: '99', sub_type: '1', name: 'M4T', class: 'drone' },
    device_online_status: false,
    mode_code: 14
};

const STATES: Record<string, unknown> = {
    [DOCK.sn]: {
        latitude: 22.793216926533837,
        longitude: 114.35782881713465,
        height: 49.58319854736328,
        heading: 112.0,
        mode_code: 'in_operation',
        drone_in_dock: 'outside',
        firmware_version: '10.01.3205',
        position_state: { gps_number: 9, rtk_number: 44, quality: 'gear_5' },
        sub_device: { device_sn: DOCK_DRONE.sn, device_online_status: 'power_on' }
    },
    [DOCK_DRONE.sn]: {
        latitude: 22.7951,
        longitude: 114.3601,
        height: 169.5,
        elevation: 120,
        attitude_head: -90,
        horizontal_speed: 12.5,
        vertical_speed: 0,
        home_distance: 310.2,
        mode_code: 'wayline_flight',
        battery: { capacity_percent: 76, remain_flight_time: 1500, batteries: null },
        position_state: { gps_number: 18, rtk_number: 30 },
        '81-0-0': { gimbal_pitch: -45, gimbal_roll: 0, gimbal_yaw: -170, payload_index: '81-0-0', zoom_factor: 2 }
    },
    [CONTROLLER.sn]: {
        latitude: 22.79,
        longitude: 114.35,
        height: 40,
        capacity_percent: 55
    },
    [OFFLINE_DRONE.sn]: {
        latitude: 0,
        longitude: 0,
        height: 0,
        mode_code: 'not_connected'
    }
};

async function mock(): Promise<Mock> {
    const state: Mock = {
        base: '',
        requests: [],
        states: structuredClone(STATES),
        close: async () => {}
    };

    const server = http.createServer((req, res) => {
        const url = new URL(req.url || '/', 'http://localhost');
        const project = req.headers['x-project-uuid'] ? String(req.headers['x-project-uuid']) : undefined;

        state.requests.push({
            url: req.url || '',
            project,
            request_id: req.headers['x-request-id'] ? String(req.headers['x-request-id']) : undefined
        });

        const json = (code: number, body: unknown) => {
            res.writeHead(code, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(body));
        };

        if (!req.headers['x-user-token']) {
            return json(200, { code: 200401, message: 'X-User-Token not found or empty' });
        } else if (req.headers['x-user-token'] !== 'org-key') {
            return json(200, { code: 200401, message: 'X-User-Token is invalid' });
        }

        const path = url.pathname.replace(/^\/openapi\/(v2\.0|v0\.1)/, '');
        if (path === url.pathname) return json(404, { code: 404, message: 'not found' });

        if (path === '/project') {
            if (url.searchParams.get('page') !== '1') return json(200, { code: 0, message: 'OK', data: { list: null } });

            return json(200, {
                code: 0,
                message: 'OK',
                data: {
                    list: [
                        { name: 'Project A', introduction: '', uuid: PROJECT_A, org_uuid: 'org' },
                        { name: 'Project B', introduction: '', uuid: PROJECT_B, org_uuid: 'org' }
                    ]
                }
            });
        }

        if (path === '/project/device') {
            if (project === PROJECT_A) {
                return json(200, {
                    code: 0,
                    message: 'OK',
                    data: {
                        list: [
                            { gateway: DOCK, drone: DOCK_DRONE },
                            { gateway: CONTROLLER, drone: OFFLINE_DRONE }
                        ]
                    }
                });
            } else if (project === PROJECT_B) {
                return json(200, { code: 0, message: 'OK', data: { list: null } });
            }

            return json(200, { code: 200403, message: 'No permission for the project' });
        }

        const device = path.match(/^\/device\/([^/]+)\/state$/);
        if (device) {
            const device_state = state.states[decodeURIComponent(device[1])];
            if (!device_state) return json(200, { code: 212015, message: 'Device is offline.' });

            return json(200, {
                code: 0,
                message: '',
                data: { device_sn: device[1], device_state }
            });
        }

        json(404, { code: 404, message: 'not found' });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    state.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    state.close = () => new Promise((resolve) => server.close(() => resolve()));

    return state;
}

async function run(api: Mock, environment: Record<string, unknown>) {
    const task = await Task.init();

    const layer = {
        id: 1,
        connection: 1,
        task: 'etl-dji-flight-hub-v1.0.0',
        timeout: 120,
        incoming: {
            environment: {
                DJI_ORG_KEY: 'org-key',
                DJI_API_URL: api.base,
                POLL_INTERVAL: 0,
                ...environment
            },
            ephemeral: {}
        }
    };

    // @ts-expect-error partial layer for testing
    task.fetchLayer = async () => layer;
    // @ts-expect-error private in base
    task.layer = layer;

    const submitted: FeatureCollection[] = [];
    task.submit = async (fc: FeatureCollection) => {
        submitted.push(structuredClone(fc));
        return true;
    };

    await task.control();

    return { submitted };
}

function find(fc: FeatureCollection, sn: string) {
    const feat = fc.features.find((f) => f.id === `dji-${sn}`);
    assert.ok(feat, `expected a feature for ${sn}`);
    assert.ok(feat.properties);
    return feat as typeof feat & { properties: NonNullable<typeof feat.properties> & { metadata: Record<string, unknown> } };
}

test('control - submits aircraft, docks & controllers', async () => {
    const api = await mock();

    try {
        const { submitted } = await run(api, {});

        assert.deepEqual(api.requests.map((r) => `${r.url} ${r.project}`).sort(), [
            `/openapi/v2.0/device/${DOCK_DRONE.sn}/state ${PROJECT_A}`,
            `/openapi/v2.0/device/${CONTROLLER.sn}/state ${PROJECT_A}`,
            `/openapi/v2.0/device/${DOCK.sn}/state ${PROJECT_A}`,
            `/openapi/v2.0/project/device ${PROJECT_A}`,
            `/openapi/v2.0/project/device ${PROJECT_B}`,
            '/openapi/v2.0/project?page=1&page_size=100 undefined'
        ].sort());

        for (const req of api.requests) {
            assert.match(String(req.request_id), /^[0-9a-f-]{36}$/);
        }

        assert.equal(submitted.length, 1);
        assert.equal(submitted[0].features.length, 3);

        const drone = find(submitted[0], DOCK_DRONE.sn);
        assert.equal(drone.properties.type, 'a-f-A-M-H-Q');
        assert.equal(drone.properties.callsign, 'Test Dock M3TD');
        assert.equal(drone.properties.course, 270);
        assert.equal(drone.properties.speed, 12.5);
        assert.deepEqual(drone.properties.sensor, { azimuth: 190, elevation: -45, fov: 45, range: 100 });
        assert.deepEqual(drone.geometry.coordinates, [114.3601, 22.7951, 169.5]);
        assert.match(String(drone.properties.remarks), /Status: Wayline Flight/);
        assert.match(String(drone.properties.remarks), /Battery: 76%/);
        assert.match(String(drone.properties.remarks), /Dock: Test Dock/);
        assert.match(String(drone.properties.remarks), /Project: Project A/);
        assert.equal(drone.properties.metadata.airborne, true);
        assert.equal(drone.properties.metadata.status, 'wayline_flight');
        assert.equal(drone.properties.metadata.gateway_serial, DOCK.sn);
        assert.equal(drone.properties.metadata.project_uuid, PROJECT_A);

        const dock = find(submitted[0], DOCK.sn);
        assert.equal(dock.properties.type, 'a-f-G-I-B-A');
        assert.equal(dock.properties.callsign, 'Test Dock');
        assert.equal(dock.properties.course, undefined);
        assert.equal(dock.properties.metadata.status, 'in_operation');
        assert.equal(dock.properties.metadata.drone_in_dock, false);
        assert.equal(dock.properties.metadata.rtk_satellites, 44);

        const controller = find(submitted[0], CONTROLLER.sn);
        assert.equal(controller.properties.type, 'a-f-G-U-C-V-U-R');
        assert.equal(controller.properties.callsign, 'Pilot 1');
        assert.equal(controller.properties.metadata.battery, 55);
        assert.equal(controller.properties.metadata.status, undefined);
    } finally {
        await api.close();
    }
});

test('control - honours device class & project filters on the v0.1 prefix', async () => {
    const api = await mock();

    try {
        const { submitted } = await run(api, {
            DJI_API_VERSION: 'v0.1',
            DJI_PROJECTS: [{ ProjectUUID: PROJECT_A }],
            INCLUDE_DOCKS: false,
            INCLUDE_CONTROLLERS: false
        });

        assert.deepEqual(api.requests.map((r) => r.url), [
            '/openapi/v0.1/project?page=1&page_size=100',
            '/openapi/v0.1/project/device',
            `/openapi/v0.1/device/${DOCK_DRONE.sn}/state`
        ]);

        assert.equal(submitted.length, 1);
        assert.deepEqual(submitted[0].features.map((f) => f.id), [`dji-${DOCK_DRONE.sn}`]);
    } finally {
        await api.close();
    }
});

test('control - integer mode codes, missing fixes & device failures', async () => {
    const api = await mock();

    api.states[DOCK_DRONE.sn] = {
        latitude: 22.7951,
        longitude: 114.3601,
        height: 52,
        attitude_head: 45,
        mode_code: 0,
        battery: null
    };
    delete api.states[CONTROLLER.sn];

    try {
        const { submitted } = await run(api, { INCLUDE_OFFLINE: true });

        // The offline aircraft is requested but reports 0,0 & the controller request fails
        assert.equal(api.requests.filter((r) => r.url.endsWith('/state')).length, 4);

        assert.equal(submitted.length, 1);
        assert.deepEqual(submitted[0].features.map((f) => f.id).sort(), [
            `dji-${DOCK_DRONE.sn}`,
            `dji-${DOCK.sn}`
        ].sort());

        const drone = find(submitted[0], DOCK_DRONE.sn);
        assert.equal(drone.properties.metadata.status, 'standby');
        assert.equal(drone.properties.metadata.airborne, false);
        assert.equal(drone.properties.metadata.battery, undefined);
        assert.equal(drone.properties.sensor, undefined);
    } finally {
        await api.close();
    }
});

test('control - polls aircraft & controllers while airborne', async () => {
    const api = await mock();

    try {
        const { submitted } = await run(api, {
            POLL_INTERVAL: 1,
            POLL_DURATION: 2
        });

        assert.ok(submitted.length >= 2, `expected multiple submissions, got ${submitted.length}`);
        assert.equal(submitted[0].features.length, 3);

        for (const fc of submitted.slice(1)) {
            assert.deepEqual(fc.features.map((f) => f.id).sort(), [
                `dji-${DOCK_DRONE.sn}`,
                `dji-${CONTROLLER.sn}`
            ].sort());
        }

        // Projects & device lists are only requested once per invocation
        assert.equal(api.requests.filter((r) => r.url.includes('/project')).length, 3);
    } finally {
        await api.close();
    }
});

test('control - business errors fail the invocation', async () => {
    const api = await mock();

    try {
        await assert.rejects(run(api, {
            DJI_ORG_KEY: 'wrong-key'
        }), /FlightHub GET \/project\?page=1&page_size=100 failed \(200\): 200401 X-User-Token is invalid/);
    } finally {
        await api.close();
    }
});
