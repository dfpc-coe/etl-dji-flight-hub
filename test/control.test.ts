import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { WebSocketServer } from 'ws';
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
    osd: Array<Record<string, unknown>>;
    sockets: Array<{ token: string | null; sent: unknown[] }>;
    close: () => Promise<void>;
};

const RC_SN = '9N9CN3G001313A';

const RC_OSD = {
    app_version: '', capacity_percent: 80, drc_state: 0, height: 0,
    latitude: 39.078575, longitude: -108.5374171,
    wireless_link: { '4g_quality': 65535, link_workmode: 1, sdr_quality: 0 }
};

const DRONE_OSD = {
    latitude: 39.0791, longitude: -108.5381, height: 1450.5, elevation: 48,
    attitude_head: 120, horizontal_speed: 4.2, vertical_speed: 0.5, home_distance: 95,
    mode_code: 3,
    battery: { capacity_percent: 61, remain_flight_time: 900, batteries: null },
    position_state: { gps_number: 14, rtk_number: 0, is_fixed: 0, quality: 5 },
    cameras: [{ payload_index: '88-0-0', camera_mode: 0, zoom_factor: 7, photo_state: 0 }],
    '88-0-0': {
        payload_index: '88-0-0', zoom_factor: 0.57,
        gimbal_yaw: 95, gimbal_pitch: -30, gimbal_roll: 0,
        measure_target_latitude: 39.0802, measure_target_longitude: -108.5363,
        measure_target_altitude: 1398.2, measure_target_distance: 213.7, measure_target_error_state: 0
    }
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

const RC_DRONE = {
    sn: '1581F7FVC253H00D9BPW',
    callsign: 'Matrice 4E',
    device_model: { key: '0-99-0', domain: '0', type: '99', sub_type: '0', name: 'Matrice 4E', class: 'drone' },
    device_online_status: true,
    mode_code: 0,
    camera_list: null
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
    },
    [RC_DRONE.sn]: {
        latitude: 39.07856625186832,
        longitude: -108.53742546323147,
        height: 1402.2998046875,
        elevation: 0,
        attitude_head: 50,
        horizontal_speed: 0,
        vertical_speed: 0,
        home_distance: 1.9255199432373047,
        mode_code: 'standby',
        battery: { capacity_percent: 46, remain_flight_time: 0, batteries: null },
        position_state: { gps_number: 13, rtk_number: 9, is_fixed: 'not_started', quality: '0' },
        drone_in_dock: null
    }
};

async function mock(): Promise<Mock> {
    const state: Mock = {
        base: '',
        requests: [],
        states: structuredClone(STATES),
        osd: [
            { sn: RC_SN, host: RC_OSD, to: ['org', PROJECT_B] },
            { sn: '1581F7FVC253H00D9BPW', host: DRONE_OSD, to: ['org', PROJECT_B] },
            { sn: '1581F7FVC253H00D9BPW', host: { latitude: 39.0792, longitude: -108.5382, '88-0-0': { payload_index: '88-0-0', gimbal_yaw: 100, measure_target_error_state: 3, measure_target_latitude: 39.0802, measure_target_longitude: -108.5363 } }, to: ['org', PROJECT_B], delay: 1300 }
        ],
        sockets: [],
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

        const groups = url.pathname.match(/^\/map\/api\/v1\/workspaces\/([^/]+)\/element-groups$/);
        if (groups) {
            if (groups[1] !== PROJECT_A) return json(200, { code: 0, message: 'success', data: null });

            const distributed = url.searchParams.get('is_distributed') === 'true';

            return json(200, {
                code: 0,
                message: 'success',
                data: [
                    { id: 'g-app', name: 'dji_app', type: 7, is_distributed: true, elements: [] },
                    ...(distributed ? [] : [{
                        id: 'g-default', name: 'default', type: 1, is_distributed: false,
                        elements: [{
                            id: 'el-line', name: 'Route A', desc: '', source: 0, status: 1, display: 1,
                            resource: {
                                type: 1, user_name: 'Nicholas Ingalls', user_id: '1', remark: '',
                                content: { type: 'Feature', properties: { color: '#19BE6B', clampToGround: true }, geometry: { type: 'LineString', coordinates: [[-108.5376, 39.0784, 1393], [-108.5370, 39.0788, 1393]] } }
                            },
                            create_time: 1792442800000, update_time: 1792442900000
                        }]
                    }]),
                    {
                        id: 'g-share', name: 'share', type: 2, is_distributed: true,
                        elements: [{
                            id: '22cfe1ec-748c-4c6a-9ef1-58b263f53b9b', name: 'Nicholas Ingalls 4', desc: 'Staging area', source: 0, status: 1, display: 1,
                            resource: {
                                type: 0, user_name: 'Nicholas Ingalls', user_id: '1', remark: '',
                                content: { type: 'Feature', properties: { IsTransparent: false, clampToGround: false, color: '#2D8CF0', icon: 0, is3d: false }, geometry: { type: 'Point', coordinates: [-108.53760088936559, 39.078463577137946, 1393.2000732421875], breadCrumbs: null } }
                            },
                            create_time: 1792442846530, update_time: 1792442846530, elevation_load_status: 0, notify: false
                        }, {
                            id: 'el-poly', name: 'Search Area', desc: '', source: 0, status: 1, display: 1,
                            resource: {
                                type: 2, user_name: 'Nicholas Ingalls', user_id: '1', remark: '',
                                content: { type: 'Feature', properties: { color: '#E23C39' }, geometry: { type: 'Polygon', coordinates: [[-108.538, 39.078], [-108.537, 39.078], [-108.537, 39.079]] } }
                            },
                            create_time: 1792442850000, update_time: 1792442850000
                        }, {
                            id: 'el-bad', name: 'No fix', resource: { type: 0, content: { geometry: { type: 'Point', coordinates: [0, 0, 0] } } }
                        }]
                    }
                ]
            });
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

        if (path === '/device') {
            const device_model_class = url.searchParams.get('device_model_class');

            if (device_model_class === 'drone') {
                return json(200, {
                    code: 0,
                    message: '',
                    data: { list: [{ gateway: RC_DRONE, drone: null }, { gateway: DOCK, drone: DOCK_DRONE }] }
                });
            } else if (device_model_class === 'airport') {
                return json(200, { code: 0, message: '', data: { list: [{ gateway: DOCK, drone: DOCK_DRONE }] } });
            }

            return json(200, { code: 210070, message: 'Bad Request' });
        }

        const details = path.match(/^\/project\/device\/([^/]+)$/);
        if (details) {
            if (project !== PROJECT_B || decodeURIComponent(details[1]) !== RC_DRONE.sn) {
                return json(200, { code: 200400, message: 'Bad Request' });
            }

            return json(200, {
                code: 0,
                message: 'OK',
                data: { device_sn: RC_DRONE.sn, device_model: RC_DRONE.device_model, is_org_device: true }
            });
        }

        const device = path.match(/^\/device\/([^/]+)\/state$/);
        if (device) {
            const device_state = state.states[decodeURIComponent(device[1])];
            if (!device_state) return json(200, { code: 212015, message: 'Device is offline.' });
            if (device[1] === RC_DRONE.sn && project !== PROJECT_B) {
                return json(200, { code: 200403, message: 'Forbidden', data: { path: 'device-management/team-view-device' } });
            }

            return json(200, {
                code: 0,
                message: '',
                data: { device_sn: device[1], device_state }
            });
        }

        json(404, { code: 404, message: 'not found' });
    });

    const wss = new WebSocketServer({ server, path: '/duplex/web' });

    wss.on('connection', (socket, req) => {
        const token = new URL(req.url || '/', 'http://localhost').searchParams.get('x-user-token');
        const record = { token, sent: [] as unknown[] };
        state.sockets.push(record);

        if (token !== 'org-key') return socket.close(4001, 'unauthorized');

        socket.on('message', (raw) => {
            const text = String(raw);
            if (text === 'ping') return socket.send('pong');

            const msg = JSON.parse(text);
            record.sent.push(msg);

            if (msg.biz_code !== 'biz_scope') return;

            if (!msg.data?.organization) return socket.close(4003);

            socket.send(JSON.stringify({ biz_code: 'biz_scope', conn_id: 'conn', conn_platform: 'web', msg_trace_id: msg.msg_trace_id }));
            socket.send(JSON.stringify({
                biz_code: 'manage_member_status', msg_trace_id: 'needs-ack', need_reply: true,
                to: [PROJECT_B], data: { project_uuid: PROJECT_B, online_status: true }
            }));

            state.osd.forEach((osd, i) => {
                setTimeout(() => {
                    if (socket.readyState !== socket.OPEN) return;
                    socket.send(JSON.stringify({
                        version: '', sub_biz_code: '', to_category: 'org_or_prj', biz_code: 'device_osd',
                        msg_trace_id: `osd-${i}`, to: osd.to, data: { host: osd.host, sn: osd.sn },
                        timestamp: Date.now(), need_reply: false
                    }));
                }, typeof osd.delay === 'number' ? osd.delay : 50 + i * 100);
            });
        });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    state.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    state.close = () => new Promise((resolve) => { wss.close(); server.close(() => resolve()); });

    return state;
}

async function run(api: Mock, environment: Record<string, unknown>) {
    const task = await Task.init();

    const layer = {
        id: 1,
        connection: 1,
        task: 'etl-dji-flight-hub-v1.0.0',
        incoming: {
            environment: {
                DJI_ORG_KEY: 'org-key',
                DJI_API_URL: api.base,
                DJI_WEBSOCKET: false,
                INCLUDE_PINS: false,
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
            `/openapi/v2.0/device/${RC_DRONE.sn}/state ${PROJECT_B}`,
            `/openapi/v2.0/project/device ${PROJECT_A}`,
            `/openapi/v2.0/project/device ${PROJECT_B}`,
            `/openapi/v2.0/project/device/${RC_DRONE.sn} ${PROJECT_A}`,
            `/openapi/v2.0/project/device/${RC_DRONE.sn} ${PROJECT_B}`,
            '/openapi/v2.0/device?device_model_class=drone undefined',
            '/openapi/v2.0/device?device_model_class=airport undefined',
            '/openapi/v2.0/project?page=1&page_size=100 undefined'
        ].sort());

        for (const req of api.requests) {
            assert.match(String(req.request_id), /^[0-9a-f-]{36}$/);
        }

        assert.equal(submitted.length, 1);
        assert.equal(submitted[0].features.length, 4);

        const rc = find(submitted[0], RC_DRONE.sn);
        assert.equal(rc.properties.type, 'a-f-A-M-H-Q');
        assert.equal(rc.properties.callsign, 'Matrice 4E');
        assert.equal(rc.properties.course, 50);
        assert.equal(rc.properties.sensor, undefined);
        assert.deepEqual(rc.geometry.coordinates, [-108.53742546323147, 39.07856625186832, 1402.2998046875]);
        assert.equal(rc.properties.metadata.airborne, false);
        assert.equal(rc.properties.metadata.gateway_serial, undefined);
        assert.equal(rc.properties.metadata.project, 'Project B');
        assert.equal(rc.properties.metadata.project_uuid, PROJECT_B);
        assert.equal(rc.properties.metadata.gps_satellites, 13);
        assert.match(String(rc.properties.remarks), /Battery: 46%/);
        assert.doesNotMatch(String(rc.properties.remarks), /Controller:|Dock:/);

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
            '/openapi/v0.1/device?device_model_class=drone',
            '/openapi/v0.1/device?device_model_class=airport',
            `/openapi/v0.1/project/device/${RC_DRONE.sn}`,
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
        assert.equal(api.requests.filter((r) => r.url.endsWith('/state')).length, 5);

        assert.equal(submitted.length, 1);
        assert.deepEqual(submitted[0].features.map((f) => f.id).sort(), [
            `dji-${DOCK_DRONE.sn}`,
            `dji-${DOCK.sn}`,
            `dji-${RC_DRONE.sn}`
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

test('control - does not submit when no device reports a location', async () => {
    const api = await mock();

    api.states = { [OFFLINE_DRONE.sn]: STATES[OFFLINE_DRONE.sn], [RC_DRONE.sn]: STATES[OFFLINE_DRONE.sn] };

    try {
        const { submitted } = await run(api, { INCLUDE_OFFLINE: true });

        assert.equal(submitted.length, 0);
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

test('control - streams live telemetry over the web socket', async () => {
    const api = await mock();

    try {
        const { submitted } = await run(api, { DJI_WEBSOCKET: true, STREAM_DURATION: 2, STREAM_INTERVAL: 1 });

        assert.equal(api.sockets.length, 1);
        assert.equal(api.sockets[0].token, 'org-key');

        const subscribe = api.sockets[0].sent.find((m) => (m as { biz_code: string }).biz_code === 'biz_scope') as Record<string, unknown>;
        assert.ok(subscribe);
        assert.equal(subscribe.version, '1.0');
        assert.match(String(subscribe.msg_trace_id), /^[0-9a-f-]{36}$/);
        assert.deepEqual(subscribe.data, {
            codes: ['device_osd', 'device_state', 'device_online', 'device_offline', 'device_update_topo'],
            project: '',
            organization: 'org'
        });

        const ack = api.sockets[0].sent.find((m) => (m as { biz_code: string }).biz_code === 'ack_reply') as Record<string, unknown>;
        assert.deepEqual(ack?.data, { msg_trace_id: 'needs-ack' });

        // The Thing Model snapshot is submitted first, then the stream
        assert.ok(submitted.length >= 2, `expected a snapshot and a stream submission, got ${submitted.length}`);
        assert.equal(submitted[0].features.length, 4);

        const live = submitted.slice(1).flatMap((fc) => fc.features);
        const ids = live.map((f) => f.id);
        assert.ok(ids.includes(`dji-${RC_SN}`), `controller missing from ${ids}`);
        assert.ok(ids.includes('dji-1581F7FVC253H00D9BPW'), `aircraft missing from ${ids}`);
        assert.ok(ids.includes('dji-1581F7FVC253H00D9BPW-rng'), `laser target missing from ${ids}`);

        const rc = live.find((f) => f.id === `dji-${RC_SN}`)!;
        assert.equal(rc.properties!.type, 'a-f-G-U-C-V-U-R');
        assert.equal(rc.properties!.callsign, `DJI ${RC_SN}`);
        assert.deepEqual(rc.geometry.coordinates, [-108.5374171, 39.078575, 0]);
        assert.equal((rc.properties!.metadata as Record<string, unknown>).project_uuid, PROJECT_B);
        assert.equal((rc.properties!.metadata as Record<string, unknown>).live, true);

        // The second OSD merges over the first, the laser then reports no signal
        const drones = live.filter((f) => f.id === 'dji-1581F7FVC253H00D9BPW');
        assert.equal(drones.length, 2);
        const [drone, after] = drones;
        const meta = drone.properties!.metadata as Record<string, unknown>;
        assert.equal(drone.properties!.type, 'a-f-A-M-H-Q');
        assert.equal(drone.properties!.callsign, 'Matrice 4E');
        assert.equal(drone.properties!.course, 120);
        assert.equal(drone.properties!.speed, 4.2);
        assert.deepEqual(drone.properties!.sensor, { azimuth: 95, elevation: -30, fov: 45, range: 213.7 });
        assert.equal(meta.status, 'manual_flight');
        assert.equal(meta.airborne, true);
        assert.equal(meta.battery, 61);
        assert.equal(meta.project, 'Project B');
        assert.equal(meta.laser_distance, 213.7);
        assert.match(String(drone.properties!.remarks), /Laser Range: 214m/);

        assert.deepEqual(after.geometry.coordinates, [-108.5382, 39.0792, 1450.5]);
        assert.deepEqual(after.properties!.sensor, { azimuth: 100, elevation: 0, fov: 45, range: 100 });
        assert.equal((after.properties!.metadata as Record<string, unknown>).laser_state, undefined);
        assert.equal(ids.filter((id) => id === 'dji-1581F7FVC253H00D9BPW-rng').length, 1);

        const first = live.find((f) => f.id === 'dji-1581F7FVC253H00D9BPW-rng')!;
        assert.equal(first.properties!.type, 'b-m-p-s-p-i');
        assert.equal(first.properties!.callsign, 'Matrice 4E RNG');
        assert.deepEqual(first.geometry.coordinates, [-108.5363, 39.0802, 1398.2]);
        const laser = first.properties!.metadata as Record<string, unknown>;
        assert.equal(laser.device_class, 'laser');
        assert.equal(laser.laser_distance, 213.7);
        assert.equal(laser.laser_state, 'normal');
        assert.equal(laser.project_uuid, PROJECT_B);
    } finally {
        await api.close();
    }
});

test('control - streaming honours device class filters', async () => {
    const api = await mock();

    try {
        const { submitted } = await run(api, {
            DJI_WEBSOCKET: true, STREAM_DURATION: 1, STREAM_INTERVAL: 1,
            INCLUDE_CONTROLLERS: false, INCLUDE_DOCKS: false
        });

        const live = submitted.slice(1).flatMap((fc) => fc.features).map((f) => f.id);
        assert.ok(!live.includes(`dji-${RC_SN}`));
        assert.ok(live.includes('dji-1581F7FVC253H00D9BPW'));
    } finally {
        await api.close();
    }
});

test('control - submits map pins, lines & polygons', async () => {
    const api = await mock();

    try {
        const { submitted } = await run(api, { INCLUDE_PINS: true });

        assert.deepEqual(api.requests.filter((r) => r.url.includes('/map/')).map((r) => `${r.url} ${r.project}`), [
            `/map/api/v1/workspaces/${PROJECT_A}/element-groups ${PROJECT_A}`,
            `/map/api/v1/workspaces/${PROJECT_B}/element-groups ${PROJECT_B}`
        ]);

        assert.equal(submitted.length, 1);
        const ids = submitted[0].features.map((f) => f.id);
        assert.ok(ids.includes('dji-pin-22cfe1ec-748c-4c6a-9ef1-58b263f53b9b'));
        assert.ok(ids.includes('dji-pin-el-line'));
        assert.ok(ids.includes('dji-pin-el-poly'));
        assert.ok(!ids.includes('dji-pin-el-bad'));
        assert.equal(submitted[0].features.length, 7);

        const pin = submitted[0].features.find((f) => f.id === 'dji-pin-22cfe1ec-748c-4c6a-9ef1-58b263f53b9b')!;
        assert.equal(pin.properties!.type, 'u-d-p');
        assert.equal(pin.properties!.callsign, 'Nicholas Ingalls 4');
        assert.equal(pin.properties!['marker-color'], '#2D8CF0');
        assert.equal(pin.properties!.time, undefined);
        assert.deepEqual(pin.geometry.coordinates, [-108.53760088936559, 39.078463577137946, 1393.2000732421875]);
        assert.match(String(pin.properties!.remarks), /Staging area/);
        assert.match(String(pin.properties!.remarks), /Created by: Nicholas Ingalls/);
        assert.match(String(pin.properties!.remarks), /Layer: share/);
        const meta = pin.properties!.metadata as Record<string, unknown>;
        assert.equal(meta.device_class, 'pin');
        assert.equal(meta.element_type, 'point');
        assert.equal(meta.group_type, 'app_shared');
        assert.equal(meta.author, 'Nicholas Ingalls');
        assert.equal(meta.created, '2026-10-19T20:47:26.530Z');
        assert.equal(meta.project_uuid, PROJECT_A);

        const line = submitted[0].features.find((f) => f.id === 'dji-pin-el-line')!;
        assert.equal(line.properties!.type, 'u-d-f');
        assert.equal(line.properties!.stroke, '#19BE6B');
        assert.equal(line.properties!.fill, undefined);
        assert.equal(line.geometry.type, 'LineString');
        assert.equal((line.properties!.metadata as Record<string, unknown>).group_type, 'default');

        const poly = submitted[0].features.find((f) => f.id === 'dji-pin-el-poly')!;
        assert.equal(poly.properties!.type, 'u-d-f');
        assert.equal(poly.properties!.fill, '#E23C39');
        assert.equal(poly.properties!['fill-opacity'], 0.2);
        assert.deepEqual(poly.geometry.coordinates, [[[-108.538, 39.078], [-108.537, 39.078], [-108.537, 39.079], [-108.538, 39.078]]]);
    } finally {
        await api.close();
    }
});

test('control - distributed pins only', async () => {
    const api = await mock();

    try {
        const { submitted } = await run(api, { INCLUDE_PINS: true, PINS_DISTRIBUTED_ONLY: true });

        assert.ok(api.requests.some((r) => r.url === `/map/api/v1/workspaces/${PROJECT_A}/element-groups?is_distributed=true`));
        const ids = submitted[0].features.map((f) => f.id);
        assert.ok(ids.includes('dji-pin-el-poly'));
        assert.ok(!ids.includes('dji-pin-el-line'));
    } finally {
        await api.close();
    }
});
