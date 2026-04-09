/**
 * Bridge client — connects to pi-bridge via HTTP + SSE.
 * Used instead of direct Telegram polling when the bridge is running.
 */

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Config ───────────────────────────────────────────────────────────────

const DEFAULT_PORT = 19384;

function bridgeConfigDir(): string {
	const xdg = process.env.XDG_CONFIG_HOME;
	return join(xdg || join(homedir(), ".config"), "pi-bridge");
}

function bridgePort(): number {
	try {
		const cfg = JSON.parse(readFileSync(join(bridgeConfigDir(), "config.json"), "utf-8"));
		return cfg.port || DEFAULT_PORT;
	} catch {
		return DEFAULT_PORT;
	}
}

function bridgeUrl(): string {
	return `http://127.0.0.1:${bridgePort()}`;
}

function bridgePidPath(): string {
	return join(bridgeConfigDir(), "bridge.pid");
}

// ── Health check ─────────────────────────────────────────────────────────

export async function isBridgeRunning(): Promise<boolean> {
	try {
		const res = await fetch(`${bridgeUrl()}/health`, {
			signal: AbortSignal.timeout(2000),
		});
		return res.ok;
	} catch {
		return false;
	}
}

// ── Spawn bridge ─────────────────────────────────────────────────────────

/**
 * Find the pi-bridge binary. Checks:
 * 1. PI_BRIDGE_BIN env var
 * 2. pi-bridge in PATH
 * 3. bridge/pi-bridge relative to this extension
 */
function findBridgeBinary(): string | null {
	if (process.env.PI_BRIDGE_BIN) return process.env.PI_BRIDGE_BIN;

	// Check PATH
	try {
		const { execFileSync } = require("node:child_process");
		return execFileSync("which", ["pi-bridge"], { encoding: "utf-8" }).trim();
	} catch {
		// Not in PATH
	}

	// Check relative to extension (for development)
	const devPath = join(__dirname, "..", "bridge", "pi-bridge");
	if (existsSync(devPath)) return devPath;

	return null;
}

/**
 * Ensure bridge config exists. Creates it from telegram-connect config
 * if needed, wrapping credentials in the adapter format.
 */
export function ensureBridgeConfig(telegramConfig: {
	botToken: string;
	chatId: number;
	allowedUserId: number;
}): void {
	const dir = bridgeConfigDir();
	const path = join(dir, "config.json");

	// Don't overwrite existing config
	if (existsSync(path)) return;

	const cfg = {
		port: DEFAULT_PORT,
		adapters: [
			{
				type: "telegram",
				config: {
					botToken: telegramConfig.botToken,
					chatId: telegramConfig.chatId,
					allowedUserId: telegramConfig.allowedUserId,
				},
			},
		],
	};

	mkdirSync(dir, { recursive: true });
	writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
}

export async function spawnBridge(): Promise<boolean> {
	if (await isBridgeRunning()) return true;

	const bin = findBridgeBinary();
	if (!bin) return false;

	const child = spawn(bin, [], {
		detached: true,
		stdio: "ignore",
		env: process.env,
	});
	child.unref();

	// Wait for it to start
	for (let i = 0; i < 10; i++) {
		await new Promise((r) => setTimeout(r, 500));
		if (await isBridgeRunning()) return true;
	}
	return false;
}

export function killBridge(): void {
	try {
		const pidFile = bridgePidPath();
		if (!existsSync(pidFile)) return;
		const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
		if (pid > 0) process.kill(pid, "SIGTERM");
	} catch {
		// Best effort
	}
}

// ── Register / Unregister ────────────────────────────────────────────────

export async function registerSession(
	sessionId: string,
	cwd: string,
	adapter: string,
	topicId: number,
): Promise<boolean> {
	try {
		const res = await fetch(`${bridgeUrl()}/register`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ sessionId: sessionId, cwd, adapter, topicId }),
			signal: AbortSignal.timeout(5000),
		});
		return res.ok;
	} catch {
		return false;
	}
}

export async function unregisterSession(sessionId: string): Promise<void> {
	try {
		await fetch(`${bridgeUrl()}/unregister`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ sessionId: sessionId }),
			signal: AbortSignal.timeout(5000),
		});
	} catch {
		// Best effort
	}
}

// ── Heartbeat (re-register periodically) ─────────────────────────────────

export function startHeartbeat(
	sessionId: string,
	cwd: string,
	adapter: string,
	topicId: number,
	intervalMs = 60_000,
): () => void {
	const timer = setInterval(() => {
		registerSession(sessionId, cwd, adapter, topicId).catch(() => {});
	}, intervalMs);
	return () => clearInterval(timer);
}

// ── SSE event stream ─────────────────────────────────────────────────────

export interface BridgeEvent {
	type: string;
	adapter: string;
	text: string;
	messageId: number;
	topicId: number;
	photoFileId?: string;
}

/**
 * Connect to the bridge's SSE event stream.
 * Returns a cleanup function to close the connection.
 */
export function connectEventStream(
	sessionId: string,
	onEvent: (evt: BridgeEvent) => void,
	onError?: (err: Error) => void,
	reregister?: () => Promise<void>,
): () => void {
	let aborted = false;
	const controller = new AbortController();

	let errorLogged = false;

	async function connect() {
		while (!aborted) {
			// Try to respawn bridge if it's down, then re-register
			const alive = await isBridgeRunning();
			if (!alive) {
				await spawnBridge();
			}
			if (reregister) {
				await reregister().catch(() => {});
			}

			try {
				const res = await fetch(`${bridgeUrl()}/events?sessionId=${sessionId}`, {
					signal: controller.signal,
					headers: { Accept: "text/event-stream" },
				});

				if (!res.ok || !res.body) {
					throw new Error(`SSE connection failed: ${res.status}`);
				}
				errorLogged = false; // Connected — reset error state

				const reader = res.body.getReader();
				const decoder = new TextDecoder();
				let buffer = "";

				while (!aborted) {
					const { done, value } = await reader.read();
					if (done) break;

					buffer += decoder.decode(value, { stream: true });
					const lines = buffer.split("\n");
					buffer = lines.pop() || "";

					for (const line of lines) {
						if (line.startsWith("data: ")) {
							try {
								const evt = JSON.parse(line.slice(6)) as BridgeEvent;
								onEvent(evt);
							} catch {
								// Skip malformed events
							}
						}
						// Ignore heartbeat comments (lines starting with ":")
					}
				}
			} catch (err: any) {
				if (aborted) return;
				if (!errorLogged && onError) {
					onError(err);
					errorLogged = true;
				}
				// Reconnect after 10s
				await new Promise((r) => setTimeout(r, 10_000));
			}
		}
	}

	connect();

	return () => {
		aborted = true;
		controller.abort();
	};
}

// ── Send message via bridge ──────────────────────────────────────────────

export async function sendViaBridge(
	adapter: string,
	topicId: number,
	text: string,
	opts?: { parseMode?: string; replyTo?: number },
): Promise<{ ok: boolean; messageId?: number }> {
	try {
		const res = await fetch(`${bridgeUrl()}/send`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				adapter,
				topicId,
				text,
				parseMode: opts?.parseMode,
				replyTo: opts?.replyTo,
			}),
			signal: AbortSignal.timeout(10_000),
		});
		if (!res.ok) return { ok: false };
		return (await res.json()) as { ok: boolean; messageId?: number };
	} catch {
		return { ok: false };
	}
}
