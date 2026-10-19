import crypto from 'node:crypto';

/**
 * FlightHub 2 web socket client
 *
 * The FlightHub 2 web UI receives live device telemetry over a socket at
 * `/duplex/web` on the OpenAPI host. It is not documented by DJI - the protocol
 * was derived from the web application and may change without notice:
 *
 * 1. Authenticate with the Organization Key as the `x-user-token` query parameter
 * 2. Send a `biz_scope` subscription naming the Organization (mandatory - the
 *    server closes with code 4003 without it), an optional Project and the biz
 *    codes of interest. The server acknowledges with `biz_scope` & `ack_reply`
 * 3. `device_osd` messages arrive at ~2 Hz per online device with the Cloud API
 *    OSD object of the device in `data.host`
 * 4. `ping` text frames are answered with `pong`, messages flagged `need_reply`
 *    expect an `ack_reply` carrying their `msg_trace_id`
 */

export const DefaultCodes = ['device_osd', 'device_state', 'device_online', 'device_offline', 'device_update_topo'];

export type Telemetry = {
    sn: string;
    host: Record<string, unknown>;
    /** Organization & Project UUIDs the message was addressed to */
    to: string[];
};

export type DJISocketOptions = {
    /** OpenAPI base URL - the socket lives on the same host */
    url: string;
    key: string;
    organization: string;
    project?: string;
    codes?: string[];
    /** Seconds between keepalive pings */
    ping?: number;
};

export type StreamOptions = {
    /** Seconds to hold the socket open */
    duration: number;
    onTelemetry: (telemetry: Telemetry) => void;
    /** Called every `interval` seconds while the socket is open */
    interval?: number;
    onInterval?: () => Promise<void> | void;
    onClose?: (code: number, received: number) => void;
};

type Message = {
    biz_code?: unknown;
    msg_trace_id?: unknown;
    need_reply?: unknown;
    to?: unknown;
    data?: { sn?: unknown, host?: unknown };
};

export class DJISocket {
    readonly opts: DJISocketOptions;

    constructor(opts: DJISocketOptions) {
        this.opts = opts;
    }

    static url(base: string, key: string): URL {
        const url = new URL('/duplex/web', base);
        url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
        url.searchParams.set('x-user-token', key);
        return url;
    }

    /**
     * Subscribe & deliver telemetry until the duration elapses or the server
     * closes the socket. Resolves with the number of telemetry messages received
     */
    async stream(opts: StreamOptions): Promise<number> {
        const ws = new WebSocket(DJISocket.url(this.opts.url, this.opts.key));

        let received = 0;

        const send = (message: Record<string, unknown>) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
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

            const deadline = setTimeout(finish, opts.duration * 1000);

            ws.addEventListener('open', () => {
                send({
                    biz_code: 'biz_scope',
                    version: '1.0',
                    timestamp: Date.now(),
                    msg_trace_id: crypto.randomUUID(),
                    data: {
                        codes: this.opts.codes || DefaultCodes,
                        project: this.opts.project || '',
                        organization: this.opts.organization
                    }
                });

                timers.push(setInterval(() => {
                    if (ws.readyState === WebSocket.OPEN) ws.send('ping');
                }, (this.opts.ping || 15) * 1000));

                if (opts.onInterval && opts.interval) {
                    const onInterval = opts.onInterval;
                    timers.push(setInterval(() => { onInterval(); }, opts.interval * 1000));
                }
            });

            ws.addEventListener('message', (event) => {
                let message: Message;

                try {
                    message = JSON.parse(String(event.data));
                } catch {
                    return;
                }

                if (message.need_reply && message.msg_trace_id) {
                    send({ biz_code: 'ack_reply', timestamp: Date.now(), data: { msg_trace_id: message.msg_trace_id } });
                }

                if (message.biz_code !== 'device_osd' || typeof message.data?.sn !== 'string') return;
                if (!message.data.host || typeof message.data.host !== 'object') return;

                received++;

                opts.onTelemetry({
                    sn: message.data.sn,
                    host: message.data.host as Record<string, unknown>,
                    to: Array.isArray(message.to) ? message.to.map(String) : []
                });
            });

            ws.addEventListener('error', () => {
                console.error('not ok - websocket error');
            });

            ws.addEventListener('close', (event) => {
                if (opts.onClose) opts.onClose(event.code, received);
                finish();
            });
        });

        return received;
    }
}
