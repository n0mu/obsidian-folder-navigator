// Minimal Chrome DevTools Protocol client on Node's built-in WebSocket.

interface Pending {
    resolve(value: unknown): void;
    reject(error: Error): void;
}

interface CdpMessage {
    id?: number;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: { message: string };
}

export class Cdp {
    private nextId = 1;
    private pending = new Map<number, Pending>();
    private listeners = new Map<string, Array<(params: unknown) => void>>();

    private ws: WebSocket;

    private constructor(ws: WebSocket) {
        this.ws = ws;
        ws.addEventListener("message", (event) => {
            const msg = JSON.parse(String(event.data)) as CdpMessage;
            if (msg.id !== undefined) {
                const p = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                if (msg.error) p?.reject(new Error(msg.error.message));
                else p?.resolve(msg.result);
            } else if (msg.method) {
                for (const cb of this.listeners.get(msg.method) ?? []) {
                    cb(msg.params);
                }
            }
        });
        ws.addEventListener("close", () => {
            for (const p of this.pending.values()) {
                p.reject(new Error("CDP connection closed"));
            }
            this.pending.clear();
        });
    }

    static async connect(url: string): Promise<Cdp> {
        const ws = new WebSocket(url);
        await new Promise<void>((resolve, reject) => {
            ws.addEventListener("open", () => resolve(), { once: true });
            ws.addEventListener(
                "error",
                () => reject(new Error(`cannot connect to ${url}`)),
                {
                    once: true,
                },
            );
        });
        return new Cdp(ws);
    }

    send<T = unknown>(method: string, params: object = {}): Promise<T> {
        const id = this.nextId++;
        this.ws.send(JSON.stringify({ id, method, params }));
        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, {
                resolve: (v) => resolve(v as T),
                reject,
            });
        });
    }

    on<T>(method: string, cb: (params: T) => void): void {
        const list = this.listeners.get(method) ?? [];
        list.push(cb as (params: unknown) => void);
        this.listeners.set(method, list);
    }

    close(): void {
        this.ws.close();
    }
}
