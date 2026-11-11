import { WebSocket } from 'ws';
import {
	createClose,
	createCompletion,
	createHandshakeResponse,
	createInvocation,
	createPing,
	decodePayload,
	FrameReader,
	HubMessageType,
	tryReadHandshake,
} from './frames';

export type HubHandler = (connection: HubConnection, ...args: any[]) => unknown | Promise<unknown>;

/** A single client connection to a hub. */
export class HubConnection {
	/** Negotiated connection id. */
	public readonly id: string;

	/** Value that identifies the connection inside a game (person name). */
	public userName: string | null = null;

	/** Server base url that the client has used to open this connection. */
	public baseUrl: string | null = null;

	private isHandshakeComplete = false;

	private isClosed = false;

	private readonly reader = new FrameReader();

	/**
	 * Keep-alive ping interval. The SignalR client drops the connection when it does not receive
	 * any message from the server for 30 seconds, so the server has to ping periodically (as ASP.NET Core does).
	 */
	private pingTimer: NodeJS.Timeout | null = setInterval(() => {
		if (this.isClosed) {
			return;
		}

		try {
			this.socket.send(createPing());
		} catch {
			// The socket is already closed; the `close` event will clean everything up
		}
	}, 15000);

	constructor(
		public readonly hubName: string,
		private readonly socket: WebSocket,
		id: string,
		private readonly handlers: Map<string, HubHandler>,
		private readonly onClosed: (connection: HubConnection) => void,
		private readonly log: (message: string) => void,
	) {
		this.id = id;

		this.socket.on('message', (data: Buffer) => {
			try {
				this.handleData(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
			} catch (e) {
				this.log(`[${this.hubName}] failed to process message: ${(e as Error).message}`);
				this.sendClose((e as Error).message);
			}
		});

		this.socket.on('close', () => this.close());
		this.socket.on('error', error => {
			this.log(`[${this.hubName}] socket error: ${error.message}`);
			this.close();
		});
	}

	/** Sends a hub method invocation to the client. */
	send(target: string, ...args: unknown[]): void {
		if (this.isClosed) {
			return;
		}

		try {
			this.socket.send(createInvocation(target, args));
		} catch (e) {
			this.log(`[${this.hubName}] failed to send ${target}: ${(e as Error).message}`);
		}
	}

	/** Closes the connection from the server side. */
	sendClose(error?: string): void {
		if (this.isClosed) {
			return;
		}

		try {
			this.socket.send(createClose(error));
		} catch {
			// Ignore: the socket is probably already gone
		}

		this.close();
	}

	/** Terminates the connection. */
	close(): void {
		if (this.isClosed) {
			return;
		}

		this.isClosed = true;

		if (this.pingTimer) {
			clearInterval(this.pingTimer);
			this.pingTimer = null;
		}

		try {
			this.socket.close();
		} catch {
			// Ignore
		}

		this.onClosed(this);
	}

	get closed(): boolean {
		return this.isClosed;
	}

	private handleData(data: Buffer): void {
		if (!this.isHandshakeComplete) {
			const handshake = tryReadHandshake(data);

			if (!handshake) {
				throw new Error('Handshake is incomplete');
			}

			if (handshake.request.protocol !== 'messagepack') {
				this.socket.send(createHandshakeResponse(`Unsupported protocol: ${handshake.request.protocol}`));
				this.close();
				return;
			}

			this.isHandshakeComplete = true;
			this.socket.send(createHandshakeResponse());

			if (handshake.rest.length > 0) {
				this.handleFrames(handshake.rest);
			}

			return;
		}

		this.handleFrames(data);
	}

	private handleFrames(data: Buffer): void {
		for (const payload of this.reader.push(data)) {
			this.handlePayload(payload);
		}
	}

	private handlePayload(payload: Uint8Array): void {
		const message = decodePayload(payload);

		if (message.length === 0) {
			return;
		}

		const messageType = message[0] as HubMessageType;

		switch (messageType) {
			case HubMessageType.Invocation: {
				const invocationId = message[2] as string | null;
				const target = message[3] as string;
				const args = (message[4] ?? []) as unknown[];
				void this.invoke(invocationId, target, args);
				break;
			}

			case HubMessageType.Ping:
				// The client keeps the connection alive; answering keeps its own timeout happy too
				this.socket.send(createPing());
				break;

			case HubMessageType.Close:
				this.close();
				break;

			default:
				break;
		}
	}

	private async invoke(invocationId: string | null, target: string, args: unknown[]): Promise<void> {
		const handler = this.handlers.get(target);

		if (!handler) {
			if (invocationId) {
				this.socket.send(createCompletion(invocationId, undefined, `Unknown method: ${target}`));
			}

			return;
		}

		try {
			const result = await handler(this, ...args);

			if (invocationId) {
				this.socket.send(createCompletion(invocationId, result));
			}
		} catch (e) {
			this.log(`[${this.hubName}] ${target} failed: ${(e as Error).message}`);

			if (invocationId) {
				this.socket.send(createCompletion(invocationId, undefined, (e as Error).message));
			}
		}
	}
}
