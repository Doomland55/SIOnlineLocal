import crypto from 'crypto';
import { IncomingMessage } from 'http';
import { Duplex } from 'stream';
import { WebSocketServer } from 'ws';
import { HubConnection, HubHandler } from './hubConnection';

/** Handler of a hub method: receives the connection and the invocation arguments. */
export type HubMethod = (connection: HubConnection, ...args: any[]) => unknown;

export interface HubHostOptions {
	/** Diagnostic logger. */
	log: (message: string) => void;
}

interface NegotiatedConnection {
	hubName: string;
	connectionId: string;
	createdAt: number;
	used: boolean;
}

/** Serves SignalR messagepack hubs over WebSockets with a minimal negotiate endpoint. */
export class HubHost {
	private readonly sockets = new WebSocketServer({ noServer: true });

	private readonly negotiations = new Map<string, NegotiatedConnection>();

	private readonly hubs = new Map<string, Map<string, HubMethod>>();

	private readonly active = new Map<string, Set<HubConnection>>();

	constructor(
		private readonly options: HubHostOptions,
		private readonly onConnectionClosed: (hubName: string, connection: HubConnection) => void,
	) { }

	/** Registers a hub with its methods. */
	registerHub(hubName: string, methods: Record<string, HubMethod>): void {
		this.hubs.set(hubName, new Map(Object.entries(methods)));
	}

	/** Handles `POST /<hub>/negotiate?negotiateVersion=1`. */
	negotiate(hubName: string): { connectionId: string; connectionToken: string } | null {
		if (!this.hubs.has(hubName)) {
			return null;
		}

		const connectionId = crypto.randomBytes(16).toString('hex');
		const connectionToken = crypto.randomBytes(16).toString('hex');

		this.negotiations.set(connectionToken, {
			hubName,
			connectionId,
			createdAt: Date.now(),
			used: false,
		});

		this.cleanupNegotiations();
		return { connectionId, connectionToken };
	}

	private cleanupNegotiations(): void {
		const expired = Date.now() - 60 * 1000;

		for (const [token, value] of this.negotiations.entries()) {
			if (value.createdAt < expired) {
				this.negotiations.delete(token);
			}
		}
	}

	/** Returns the hub name of a request path (first segment) or null. */
	getHubName(url: URL): string | null {
		const [first] = url.pathname.split('/').filter(Boolean);
		return first && this.hubs.has(first) ? first : null;
	}

	/** Handles a websocket upgrade request. */
	handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
		const url = new URL(request.url ?? '/', 'http://localhost');
		const hubName = this.getHubName(url);
		const token = url.searchParams.get('id');
		const negotiation = token ? this.negotiations.get(token) : undefined;

		if (!hubName || !token || !negotiation || negotiation.hubName !== hubName || negotiation.used) {
			socket.destroy();
			return;
		}

		negotiation.used = true;
		const methods = this.hubs.get(hubName) as Map<string, HubMethod>;

		// Rebuild the url the client can use to reach the server (LAN ip or a proxy host)
		const host = (request.headers['x-forwarded-host'] ?? request.headers.host ?? '').toString();
		const protocol = (request.headers['x-forwarded-proto'] ?? 'http').toString();
		const baseUrl = host ? `${protocol}://${host}` : null;

		this.sockets.handleUpgrade(request, socket, head, ws => {
			const handlers = new Map<string, HubHandler>();

			for (const [method, handler] of methods.entries()) {
				handlers.set(method, (connection, ...args) => handler(connection, ...args));
			}

			const connection = new HubConnection(
				hubName,
				ws,
				negotiation.connectionId,
				handlers,
				closed => {
					this.active.get(hubName)?.delete(closed);
					this.options.log(`[${hubName}] connection closed`);
					this.onConnectionClosed(hubName, closed);
				},
				this.options.log,
			);

			connection.baseUrl = baseUrl;

			let set = this.active.get(hubName);

			if (!set) {
				set = new Set();
				this.active.set(hubName, set);
			}

			set.add(connection);
		});
	}

	/** Returns a snapshot of the active connections of a hub. */
	getConnections(hubName: string): HubConnection[] {
		return [...(this.active.get(hubName) ?? [])];
	}

	/** Closes all connections. */
	dispose(): void {
		for (const set of this.active.values()) {
			for (const connection of set) {
				connection.close();
			}
		}

		this.sockets.close();
	}
}

export default HubHost;
