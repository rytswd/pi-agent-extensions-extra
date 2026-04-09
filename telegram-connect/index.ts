/**
 * Telegram Connect Extension
 *
 * Bridges pi coding agent sessions to Telegram for mobile use.
 *
 * Bidirectional:
 *   pi → Telegram  — agent responses pushed after each run with stats
 *   pi → Telegram  — live draft streaming via sendMessageDraft (512B/4s/12s throttle)
 *   pi → Telegram  — phase-aware heartbeat (🧠 Thinking… / 🔧 tool…)
 *   Telegram → pi  — text, photos → injected as user prompts
 *   Telegram → pi  — inline keyboard choices tap → submit_text injected
 *
 * Pi commands:
 *   /telegram          — toggle on/off
 *   /telegram setup    — enter pairing mode
 *   /telegram start    — enable and start polling
 *   /telegram stop     — disable and stop polling
 *   /telegram stream   — toggle draft streaming
 *   /telegram status   — show config
 *   /telegram topic    — create a forum topic and bind this instance to it
 *
 * Telegram commands (from your phone):
 *   /abort    — stop agent run
 *   /status   — agent state, model, context usage
 *   /compact  — compress context
 *   /think    — cycle thinking level: none → low → high
 *   /stream   — toggle draft streaming
 *   /mute     — silence notifications (polling continues)
 *   /unmute   — resume notifications
 *   /new      — queue new session
 *
 * Based on https://github.com/aldoborrero/pi-agent-kit/tree/main/extensions/walkie
 */

import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import * as tg from "./src/telegram.js";
import { MessageQueue } from "./src/queue.js";
import {
	DRAFT_HEARTBEAT_INTERVAL_MS,
	type AgentStats,
	type DraftFlush,
	type DraftState,
	appendDraftChunk,
	buildFinalMessage,
	buildHeartbeatText,
	buildTransportText,
	chunkText,
	createDraftState,
	escapeHTML,
	formatForTelegram,
	heartbeatDraft,
	suppressDraftUntil,
} from "./src/format.js";
import {
	isBridgeRunning,
	spawnBridge,
	ensureBridgeConfig,
	killBridge,
	registerSession,
	unregisterSession,
	startHeartbeat,
	connectEventStream,
	sendViaBridge,
	type BridgeEvent,
} from "./src/bridge-client.js";

// ── Config ────────────────────────────────────────────────────────────────────

/** Resolve config directory. See .ref/config-dir.org for convention. */
function getConfigDir(): string {
	const override = join(homedir(), ".pi", "agent", "pi-agent-extensions.json");
	try {
		const cfg = JSON.parse(readFileSync(override, "utf-8"));
		if (cfg.configDir) return join(cfg.configDir, "telegram-connect");
	} catch {}
	const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
	return join(base, "pi-agent-extensions", "telegram-connect");
}

const CONFIG_DIR = getConfigDir();
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

interface TelegramConnectConfig {
	botToken: string;
	chatId: number;
	allowedUserId: number;
	enabled: boolean;
	/** Use sendMessageDraft for live streaming preview (default: true) */
	streaming: boolean;
	/** Unix timestamp (ms) until which sendMessageDraft is suppressed */
	draftSuppressedUntil?: number;
	/** Forum topic (message_thread_id) this instance is scoped to */
	topicId?: number;
	/** Display name for the topic / project */
	topicName?: string;
}

function loadConfigSync(): Partial<TelegramConnectConfig> {
	try {
		return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<TelegramConnectConfig>;
	} catch {
		return {};
	}
}

/** Load project-local overrides from <cwd>/.pi/telegram-connect.json */
function loadProjectConfigSync(cwd: string): Partial<TelegramConnectConfig> {
	try {
		// Derive the pi directory name from getAgentDir() for consistency
		const piDirName = getAgentDir().replace(homedir() + "/", "").replace(/\/[^/]+$/, "");
		const path = join(cwd, piDirName, "telegram-connect.json");
		return JSON.parse(readFileSync(path, "utf8")) as Partial<TelegramConnectConfig>;
	} catch {
		return {};
	}
}

/**
 * Persist global config. See .ref/config-dir.org for convention.
 * topicId and topicName are project-specific — use persistProjectConfig() for those.
 */
async function persistConfig(config: Partial<TelegramConnectConfig>): Promise<void> {
	// Never persist enabled — it's session-only (opt-in per session)
	const { topicId, topicName, enabled, ...globalFields } = config;
	try {
		await mkdir(CONFIG_DIR, { recursive: true });
		await writeFile(CONFIG_PATH, JSON.stringify(globalFields, null, 2) + "\n", "utf8");
	} catch {
		// non-critical
	}
}

/** Persist project-local overrides (topicId, topicName) to <cwd>/.pi/telegram-connect.json */
async function persistProjectConfig(cwd: string, partial: Pick<Partial<TelegramConnectConfig>, "topicId" | "topicName">): Promise<void> {
	try {
		const piDirName = getAgentDir().replace(homedir() + "/", "").replace(/\/[^/]+$/, "");
		const dir = join(cwd, piDirName);
		const path = join(dir, "telegram-connect.json");
		await mkdir(dir, { recursive: true });
		let existing: Partial<TelegramConnectConfig> = {};
		try { existing = JSON.parse(readFileSync(path, "utf8")) as Partial<TelegramConnectConfig>; } catch { /* ok */ }
		const merged = { ...existing, ...partial };
		await writeFile(path, JSON.stringify(merged, null, 2) + "\n", "utf8");
	} catch {
		// non-critical
	}
}

// ── Guards ────────────────────────────────────────────────────────────────────

function isConfigured(c: Partial<TelegramConnectConfig>): c is TelegramConnectConfig {
	return (
		typeof c.botToken === "string" &&
		c.botToken.length > 0 &&
		typeof c.chatId === "number" &&
		typeof c.allowedUserId === "number"
	);
}

function isActive(c: Partial<TelegramConnectConfig>): c is TelegramConnectConfig {
	if (!isConfigured(c)) return false;
	return c.enabled;
}

// ── Interactive choices ───────────────────────────────────────────────────────

interface ChoiceOption {
	id: string;
	label: string;
	submit_text: string;
}

interface PendingInteraction {
	options: ChoiceOption[];
	messageId: number | null;
	expiresAt: number;
}

const INTERACTION_TTL_MS = 15 * 60 * 1000;
const SETUP_MODE_TTL_MS = 5 * 60 * 1000;

const CHOICES_SYSTEM_PROMPT = `
## Telegram Interactive Buttons

When communicating via Telegram you may present the user with tappable choice buttons by appending a JSON block at the very end of your response (after all your text):

{"v":1,"options":[
  {"id":"a","label":"✅ Option A","submit_text":"I choose option A"},
  {"id":"b","label":"❌ Option B","submit_text":"I choose option B"}
]}

Rules:
- 2–4 options only
- label: shown on the Telegram button (keep it short, ≤ 30 chars)
- submit_text: injected as the user's next message when the button is tapped
- Use only for genuine discrete choices, not open-ended questions
- The JSON block must be the very last thing in your response`.trim();

function parseChoicesBlock(text: string): { visibleText: string; choices: ChoiceOption[] | null } {
	const markerRe = /\{"v"\s*:\s*1\s*,\s*"options"\s*:\s*\[/g;
	let lastMatch: RegExpExecArray | null = null;
	let m: RegExpExecArray | null;
	while ((m = markerRe.exec(text)) !== null) lastMatch = m;
	if (!lastMatch) return { visibleText: text, choices: null };
	const idx = lastMatch.index;
	try {
		const block = JSON.parse(text.slice(idx)) as { v: number; options: ChoiceOption[] };
		if (!Array.isArray(block.options)) return { visibleText: text, choices: null };
		if (block.options.length < 2 || block.options.length > 4) return { visibleText: text, choices: null };
		if (!block.options.every(o => o.id && o.label && o.submit_text)) return { visibleText: text, choices: null };
		return { visibleText: text.slice(0, idx).trim(), choices: block.options };
	} catch {
		return { visibleText: text, choices: null };
	}
}

const CALLBACK_DATA_MAX_BYTES = 64;

function buildChoicesKeyboard(interactionId: number, options: ChoiceOption[]): tg.InlineKeyboardMarkup {
	return {
		inline_keyboard: options.map(opt => {
			const prefix = `tc:${interactionId}:`;
			let id = opt.id;
			while (Buffer.byteLength(prefix + id, "utf8") > CALLBACK_DATA_MAX_BYTES && id.length > 1) {
				id = id.slice(0, -1);
			}
			return [{ text: opt.label, callback_data: prefix + id }];
		}),
	};
}

// ── Bot command menu ──────────────────────────────────────────────────────────

const BOT_COMMANDS: tg.BotCommand[] = [
	{ command: "abort", description: "Stop the current agent run immediately" },
	{ command: "status", description: "Show agent state, model, and context usage" },
	{ command: "compact", description: "Compress context to free up space" },
	{ command: "new", description: "New session (queued if agent is active)" },
	{ command: "think", description: "Cycle thinking level: none → low → high" },
	{ command: "stream", description: "Toggle live draft preview on/off" },
	{ command: "mute", description: "Silence notifications" },
	{ command: "unmute", description: "Resume notifications" },
];

const BOT_COMMANDS_ES: tg.BotCommand[] = [
	{ command: "abort", description: "Detener la ejecución del agente inmediatamente" },
	{ command: "status", description: "Ver estado del agente, modelo y contexto" },
	{ command: "compact", description: "Comprimir el contexto para liberar espacio" },
	{ command: "new", description: "Nueva sesión (en cola si el agente está activo)" },
	{ command: "think", description: "Cambiar nivel de razonamiento: ninguno → bajo → alto" },
	{ command: "stream", description: "Activar/desactivar vista previa en tiempo real" },
	{ command: "mute", description: "Silenciar notificaciones" },
	{ command: "unmute", description: "Reanudar notificaciones" },
];

// ── Topic routing helpers ─────────────────────────────────────────────────────

function topicOptions(config: Partial<TelegramConnectConfig>): Partial<tg.SendMessageOptions> {
	return config.topicId ? { message_thread_id: config.topicId } : {};
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractLastAssistantText(messages: unknown[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i] as { role?: string; content?: Array<{ type?: string; text?: string }> };
		if (msg.role !== "assistant") continue;
		const text = (msg.content ?? [])
			.filter(c => c.type === "text")
			.map(c => c.text ?? "")
			.join("\n\n")
			.trim();
		if (text) return text;
	}
	return "";
}

// ── Extension ─────────────────────────────────────────────────────────────────

export default function telegramConnectExtension(pi: ExtensionAPI) {
	// ─── Check env var to disable at startup ────────────────────────────────
	if (process.env.PI_NO_TELEGRAM === "1") return;

	// ─── pi API shims ─────────────────────────────────────────────────────
	function getThinkingLevel(): string {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return String((pi as any).getThinkingLevel?.() ?? "none");
	}

	function setThinkingLevel(level: string): void {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(pi as any).setThinkingLevel?.(level);
	}

	// ─── Module-level state ──────────────────────────────────────────────

	let config: Partial<TelegramConnectConfig> = loadConfigSync();
	let pollingAbort: AbortController | null = null;
	let isStreaming = false;
	let setupMode = false;
	let setupModeTimer: ReturnType<typeof setTimeout> | null = null;
	let lastCtx: ExtensionContext | null = null;

	// Bridge mode state
	let useBridge = false;
	let bridgeSessionId = "";
	let stopBridgeSSE: (() => void) | null = null;
	let stopBridgeHeartbeat: (() => void) | null = null;

	// ─── Per-run counters ────────────────────────────────────────────────

	let agentStartTime: number | null = null;
	let turnCount = 0;
	let filesChanged = 0;
	let runTriggerMessageId: number | null = null;
	let nextRunTriggerMessageId: number | null = null;
	let agentPhase = "Processing request...";

	// ─── Message queue ──────────────────────────────────────────────────

	const messageQueue = new MessageQueue();

	function drainQueue(): void {
		if (!messageQueue.pending) return;
		const next = messageQueue.shift()!;
		runTriggerMessageId = next.messageId;

		if (next.images?.length) {
			const content = [
				{ type: "text" as const, text: next.text },
				...next.images,
			];
			pi.sendUserMessage(content);
		} else {
			pi.sendUserMessage(next.text);
		}
	}

	// ─── Text debounce buffer ───────────────────────────────────────────

	const TEXT_DEBOUNCE_MS = 3_000;

	interface PendingTextEntry {
		items: Array<{ text: string; messageId: number }>;
		timer: ReturnType<typeof setTimeout>;
	}

	let pendingTextEntry: PendingTextEntry | null = null;

	function flushPendingText(): void {
		if (!pendingTextEntry) return;
		const pending = pendingTextEntry;
		pendingTextEntry = null;

		const merged = pending.items.map(i => i.text).join("\n");
		const lastId = pending.items[pending.items.length - 1]!.messageId;

		if (isStreaming) {
			messageQueue.push({ text: merged, messageId: lastId });
		} else {
			runTriggerMessageId = lastId;
			pi.sendUserMessage(merged);
		}
	}

	function cancelPendingText(): void {
		if (!pendingTextEntry) return;
		clearTimeout(pendingTextEntry.timer);
		pendingTextEntry = null;
	}

	// ─── Pending inline keyboard interactions ──────────────────────────

	const pendingInteractions = new Map<number, PendingInteraction>();
	let interactionSeq = 0;

	function cleanExpiredInteractions(): void {
		const now = Date.now();
		for (const [id, interaction] of pendingInteractions) {
			if (interaction.expiresAt <= now) pendingInteractions.delete(id);
		}
	}

	// ─── Draft state ───────────────────────────────────────────────────

	let draftState: DraftState | null = null;
	let draftIdCounter = 0;
	let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	let typingTimer: ReturnType<typeof setInterval> | null = null;

	// ─── Helpers ───────────────────────────────────────────────────────

	async function reloadConfigForCwd(ctx: ExtensionContext): Promise<void> {
		config = { enabled: false, streaming: true, ...loadConfigSync(), ...loadProjectConfigSync(ctx.cwd) };
		updateStatus(ctx);

		if (isConfigured(config)) {
			await registerBotCommands(config.botToken, config.chatId);
		}
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const { setStatus } = ctx.ui;
		const theme = ctx.ui.theme;

		if (!config.enabled) {
			// Only show "off" if it was explicitly disabled (configured but off).
			// Don't clutter the status bar when telegram was never started.
			setStatus("telegram", undefined);
			return;
		}
		if (setupMode) {
			setStatus("telegram", theme.fg("warning", "telegram:setup"));
			return;
		}
		if (!isConfigured(config)) {
			setStatus("telegram", theme.fg("error", "telegram:unconfigured"));
			return;
		}
		const tgIcon = "\uf2c6"; // Nerd Font: Telegram
		const topic = config.topicName ?? (config.topicId ? `#${config.topicId}` : "");
		const label = topic ? `${tgIcon} ${topic}` : `${tgIcon} tg`;
		setStatus("telegram", theme.fg("dim", label));
	}

	async function send(text: string, extraOptions?: Partial<tg.SendMessageOptions>): Promise<number | null> {
		if (!isActive(config)) return null;

		// Route through bridge if connected
		if (useBridge) {
			const formatted = formatForTelegram(text);
			const replyTo = (extraOptions?.reply_parameters as any)?.message_id ?? 0;
			const result = await sendViaBridge("telegram", config.topicId ?? 0, formatted, {
				parseMode: "HTML",
				replyTo,
			});
			return result.messageId ?? null;
		}

		const { botToken, chatId } = config;

		const { reply_markup, ...restExtra } = extraOptions ?? {};
		const topic = topicOptions(config);

		const formatted = formatForTelegram(text);
		const chunks = chunkText(formatted);

		let lastMessageId: number | null = null;
		for (let i = 0; i < chunks.length; i++) {
			const isLast = i === chunks.length - 1;
			const markupOpt = isLast && reply_markup ? { reply_markup } : {};

			try {
				const msg = await tg.sendMessage(botToken, chatId, chunks[i]!, {
					...topic,
					parse_mode: "HTML",
					...restExtra,
					...markupOpt,
				});
				lastMessageId = msg.message_id;
			} catch (err) {
				if (!(err instanceof tg.TelegramError && err.statusCode === 400)) continue;

				const remainingHtml = chunks.slice(i).join("");
				const remainingPlain = remainingHtml
					.replace(/<a\s+href="([^"]*)">/gi, "")
					.replace(/<\/?(?:b|i|s|code|pre|a)>/gi, "")
					.replace(/&lt;/g, "<")
					.replace(/&gt;/g, ">")
					.replace(/&amp;/g, "&");

				const plainChunks = chunkText(remainingPlain);
				for (let j = 0; j < plainChunks.length; j++) {
					const plainIsLast = j === plainChunks.length - 1;
					const plainMarkup = plainIsLast && reply_markup ? { reply_markup } : {};
					const msg = await tg.sendMessage(botToken, chatId, plainChunks[j]!, {
						...topic,
						...restExtra,
						...plainMarkup,
					}).catch(() => null);
					if (msg) lastMessageId = msg.message_id;
				}
				return lastMessageId;
			}
		}
		return lastMessageId;
	}

	async function sendPlain(text: string): Promise<void> {
		if (!isActive(config)) return;
		const { botToken, chatId } = config;
		const chunks = chunkText(text);
		for (const chunk of chunks) {
			await tg.sendMessage(botToken, chatId, chunk, topicOptions(config)).catch(() => {});
		}
	}

	type FlushResult = "ok" | "rate_limited" | "peer_invalid" | "stale" | "skipped";

	async function flushDraft(flush: DraftFlush): Promise<FlushResult> {
		if (!isActive(config) || !config.streaming) return "skipped";
		if (!draftState || flush.draftId !== draftState.draftId) return "stale";

		try {
			await tg.sendMessageDraft(config.botToken, config.chatId, flush.draftId, flush.text, { messageThreadId: config.topicId });
			return "ok";
		} catch (err) {
			if (err instanceof tg.TelegramError) {
				if (err.statusCode === 429) {
					const backoffMs = (err.retryAfter ?? 5) * 1000;
					if (draftState) suppressDraftUntil(draftState, backoffMs);
					return "rate_limited";
				}
				if (err.description.includes("TEXTDRAFT_PEER_INVALID")) {
					config.draftSuppressedUntil = Date.now() + 24 * 60 * 60 * 1000;
					await persistConfig(config);
					return "peer_invalid";
				}
			}
			return "skipped";
		}
	}

	async function flushDraftAndHandleResult(flush: DraftFlush): Promise<void> {
		const displayFlush = agentPhase.startsWith("🔧")
			? { ...flush, text: `${flush.text}\n\n${agentPhase}` }
			: flush;
		const result = await flushDraft(displayFlush).catch(() => "skipped" as FlushResult);
		if (result === "peer_invalid") draftState = null;
	}

	function stopTimers(): void {
		if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
		if (typingTimer) { clearInterval(typingTimer); typingTimer = null; }
	}

	function stopPolling(): void {
		pollingAbort?.abort();
		pollingAbort = null;
	}

	// ─── Bridge connection ─────────────────────────────────────────────

	async function connectViaBridge(ctx: ExtensionContext): Promise<boolean> {
		if (!isConfigured(config)) return false;

		// Ensure bridge config exists (creates from telegram-connect config)
		ensureBridgeConfig({
			botToken: config.botToken,
			chatId: config.chatId,
			allowedUserId: config.allowedUserId,
		});

		// Check if bridge is running, spawn if needed
		let running = await isBridgeRunning();
		if (!running) {
			running = await spawnBridge();
		}
		if (!running) return false;

		// Generate session ID
		bridgeSessionId = `${process.pid}-${Date.now()}`;
		const topicId = config.topicId ?? 0;

		if (topicId === 0) {
			// No topic configured — can't route safely via bridge
			// Fall back to direct polling
			return false;
		}

		// Register with bridge
		const ok = await registerSession(bridgeSessionId, ctx.cwd, "telegram", topicId);
		if (!ok) {
			if (ctx.hasUI) {
				(lastCtx ?? ctx).ui.notify("Topic already claimed by another session — using direct polling", "warning");
			}
			return false;
		}

		useBridge = true;

		// Start heartbeat
		stopBridgeHeartbeat = startHeartbeat(bridgeSessionId, ctx.cwd, "telegram", topicId);

		// Listen for inbound events via SSE (with auto-reregister on reconnect)
		stopBridgeSSE = connectEventStream(
			bridgeSessionId,
			(evt: BridgeEvent) => handleBridgeEvent(evt),
			undefined, // errors handled silently by bridge-client (logs once, auto-reconnects)
			() => registerSession(bridgeSessionId, ctx.cwd, "telegram", topicId),
		);

		return true;
	}

	function disconnectBridge(): void {
		if (stopBridgeSSE) { stopBridgeSSE(); stopBridgeSSE = null; }
		if (stopBridgeHeartbeat) { stopBridgeHeartbeat(); stopBridgeHeartbeat = null; }
		if (bridgeSessionId) {
			unregisterSession(bridgeSessionId).catch(() => {});
			bridgeSessionId = "";
		}
		useBridge = false;
	}

	function handleBridgeEvent(evt: BridgeEvent): void {
		if (!lastCtx) return;

		const text = evt.text;
		if (!text) return;

		// Telegram commands from phone
		if (text.startsWith("/")) {
			handleCommand(text).catch(() => {});
			return;
		}

		// Text message → inject as user prompt
		if (evt.type === "message") {
			injectText(text, evt.messageId);
		}
		// Photos are handled by the bridge (file download) — not yet implemented
	}

	// ─── Polling Loop ───────────────────────────────────────────────────

	async function startPolling(initialOffset = 0): Promise<void> {
		if (pollingAbort) return;
		if (!isConfigured(config) && !setupMode) return;
		if (!config.botToken) return;

		pollingAbort = new AbortController();
		const { signal } = pollingAbort;
		const token = config.botToken;

		let offset = initialOffset;
		let errorCount = 0;

		while (!signal.aborted) {
			try {
				const updates = await tg.getUpdates(token, { offset, timeout: 30 }, signal);
				errorCount = 0;

				for (const update of updates) {
					offset = update.update_id + 1;
					handleUpdate(update).catch((err) => { console.error("[telegram-connect] handleUpdate error:", err); });
				}
			} catch (err) {
				if (signal.aborted) break;
				errorCount++;
				const backoffMs = Math.min(1_000 * 2 ** (errorCount - 1), 60_000);
				await sleep(backoffMs, signal).catch(() => {});
			}
		}
	}

	async function registerBotCommands(token: string, chatId?: number): Promise<void> {
		const scope: tg.BotCommandScope | undefined = chatId
			? { type: "chat", chat_id: chatId }
			: undefined;
		await tg.setMyCommands(token, BOT_COMMANDS, undefined, scope).catch(() => {});
		await tg.setMyCommands(token, BOT_COMMANDS_ES, "es", scope).catch(() => {});
	}

	// ─── Update sub-handlers ────────────────────────────────────────────

	function resolveMessageThreadId(msg: tg.TelegramMessage | undefined): number | undefined {
		if (!msg) return undefined;
		if (msg.message_thread_id && msg.message_thread_id > 0) return msg.message_thread_id;
		return undefined;
	}

	async function handleSetupPairing(msg: tg.TelegramMessage): Promise<void> {
		config.chatId = msg.chat.id;
		config.allowedUserId = msg.from!.id;
		config.enabled = true; // Enable for THIS session
		setupMode = false;
		if (setupModeTimer) { clearTimeout(setupModeTimer); setupModeTimer = null; }
		// Persist credentials but NOT enabled state — each session opts in explicitly
		await persistConfig({ ...config, enabled: false });
		if (lastCtx) updateStatus(lastCtx);
		await registerBotCommands(config.botToken!, config.chatId);
		await tg.sendMessage(config.botToken!, config.chatId, "✅ Paired and connected! This session is now linked. Future sessions need /telegram or /telegram start to reconnect.", topicOptions(config)).catch(() => {});
	}

	async function handleCallbackQuery(cq: tg.TelegramCallbackQuery): Promise<void> {
		if (!isConfigured(config)) return;
		await tg.answerCallbackQuery(config.botToken, cq.id).catch(() => {});

		if (!cq.data) return;

		if (cq.data.startsWith("tc:")) {
			const parts = cq.data.split(":");
			const interactionId = Number(parts[1]);
			const optionId = parts.slice(2).join(":");
			if (!Number.isFinite(interactionId) || !optionId) return;

			const interaction = pendingInteractions.get(interactionId);
			if (!interaction || interaction.expiresAt <= Date.now()) return;

			const opt = interaction.options.find(o => o.id === optionId);
			if (!opt) return;

			pendingInteractions.delete(interactionId);
			if (interaction.messageId !== null) {
				await tg.editMessageReplyMarkup(config.botToken, config.chatId, interaction.messageId).catch(() => {});
			}
			if (isStreaming) {
				messageQueue.push({ text: opt.submit_text, messageId: cq.message?.message_id ?? 0 });
			} else {
				runTriggerMessageId = cq.message?.message_id ?? null;
				pi.sendUserMessage(opt.submit_text);
			}
		} else {
			pi.events.emit("telegram:callback", { data: cq.data });
		}
	}

	async function handleCommand(text: string): Promise<void> {
		if (!isConfigured(config)) return;
		const rawCmd = text.split(/\s+/)[0]!;
		const cmd = rawCmd.includes("@") ? rawCmd.slice(0, rawCmd.indexOf("@")) : rawCmd;

		switch (cmd) {
			case "/abort":
				cancelPendingText();
				await tg.sendMessage(config.botToken, config.chatId, "⛔ Abort signal sent.", topicOptions(config)).catch(() => {});
				if (isStreaming) {
					pi.sendUserMessage("Stop what you're doing and summarize what happened.", { deliverAs: "steer" });
				}
				lastCtx?.abort();
				break;

			case "/status": {
				const projectName = lastCtx ? basename(lastCtx.cwd) : "unknown";
				const modelName = lastCtx?.model?.name ?? "unknown";
				const usage = lastCtx?.getContextUsage();
				const usageStr = usage?.percent != null
					? `${Math.round(usage.percent)}% · ${(usage.tokens ?? 0).toLocaleString()} tokens`
					: "unknown";
				const thinkingLevel = getThinkingLevel();
				const topicLine = config.topicId
					? `Topic: <code>${escapeHTML(config.topicName ?? String(config.topicId))}</code> (#${config.topicId})`
					: null;
				const html = [
					`📍 <b>Pi Status</b>`,
					`Project: <code>${escapeHTML(projectName)}</code>`,
					topicLine,
					`Agent: ${isStreaming ? "🔄 running" : "⏸ idle"}`,
					`Model: <code>${escapeHTML(String(modelName))}</code>`,
					`Context: ${usageStr}`,
					`Thinking: ${thinkingLevel}`,
					`Streaming: ${config.streaming ? "✅" : "❌"}`,
					`Telegram: ${config.enabled ? "✅" : "❌"}`,
				].filter(Boolean).join("\n");
				await tg.sendMessage(config.botToken, config.chatId, html, { ...topicOptions(config), parse_mode: "HTML" }).catch(() => {});
				break;
			}

			case "/think": {
				const levels = ["none", "low", "high"] as const;
				const current = getThinkingLevel();
				const idx = levels.indexOf(current as typeof levels[number]);
				const next = levels[(Math.max(0, idx) + 1) % levels.length]!;
				setThinkingLevel(next);
				await sendPlain(`🧠 Thinking: ${current} → ${next}`).catch(() => {});
				break;
			}

			case "/compact":
				if (isStreaming) {
					await sendPlain("⚠️ Cannot compact while agent is running.").catch(() => {});
					break;
				}
				await sendPlain("🗜 Compacting context...").catch(() => {});
				lastCtx?.compact({
					onComplete: async () => { await sendPlain("✅ Context compacted.").catch(() => {}); },
					onError: async (err) => { await sendPlain(`❌ Compaction failed: ${err.message}`).catch(() => {}); },
				});
				break;

			case "/new":
				if (isStreaming) {
					messageQueue.push({ text: "When you're done, please start a new session.", messageId: 0 });
					await sendPlain("📋 Queued: new session after current task.").catch(() => {});
				} else {
					await sendPlain("⚠️ Use /new in the terminal to start a new session.").catch(() => {});
				}
				break;

			case "/stream":
				config.streaming = !config.streaming;
				if (config.streaming) config.draftSuppressedUntil = undefined;
				await persistConfig(config);
				if (lastCtx) updateStatus(lastCtx);
				await sendPlain(`📡 Streaming ${config.streaming ? "enabled ✅" : "disabled ❌"}`).catch(() => {});
				break;

			case "/mute":
				await sendPlain("🔕 Notifications muted. Send /unmute to resume.").catch(() => {});
				config.enabled = false;
				if (lastCtx) updateStatus(lastCtx);
				break;

			case "/unmute":
				config.enabled = true;
				if (lastCtx) updateStatus(lastCtx);
				await sendPlain("🔔 Notifications resumed.").catch(() => {});
				break;
		}
	}

	function injectText(text: string, messageId: number): void {
		tg.setMessageReaction(config.botToken, config.chatId, messageId, "👀").catch(() => {});

		if (pendingTextEntry) {
			clearTimeout(pendingTextEntry.timer);
			pendingTextEntry.items.push({ text, messageId });
			pendingTextEntry.timer = setTimeout(flushPendingText, TEXT_DEBOUNCE_MS);
		} else {
			pendingTextEntry = {
				items: [{ text, messageId }],
				timer: setTimeout(flushPendingText, TEXT_DEBOUNCE_MS),
			};
		}
	}

	async function handlePhoto(msg: tg.TelegramMessage): Promise<void> {
		await tg.setMessageReaction(config.botToken, config.chatId, msg.message_id, "👀").catch(() => {});
		const largest = msg.photo![msg.photo!.length - 1]!;
		try {
			const fileInfo = await tg.getFile(config.botToken, largest.file_id);
			if (!fileInfo.file_path) {
				await sendPlain("❌ Could not retrieve photo from Telegram (no file path returned).").catch(() => {});
				return;
			}
			const buf = await tg.downloadFile(config.botToken, fileInfo.file_path);
			const caption = (msg.caption ?? msg.text ?? "Image from Telegram").trim();
			const content = [
				{ type: "text" as const, text: caption },
				{ type: "image" as const, data: buf.toString("base64"), mimeType: "image/jpeg" },
			];
			if (isStreaming) {
				messageQueue.push({
					text: caption,
					messageId: msg.message_id,
					images: [{ type: "image", data: buf.toString("base64"), mimeType: "image/jpeg" }],
				});
			} else {
				runTriggerMessageId = msg.message_id;
				pi.sendUserMessage(content);
			}
		} catch (err) {
			await sendPlain(`❌ Could not send photo: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
		}
	}

	async function handleUpdate(update: tg.TelegramUpdate): Promise<void> {
		cleanExpiredInteractions();
		if (setupMode && update.message?.from && !update.message.from.is_bot) {
			await handleSetupPairing(update.message);
			return;
		}

		if (!isConfigured(config)) return;
		const senderId = update.message?.from?.id ?? update.callback_query?.from.id;
		if (senderId !== config.allowedUserId) return;

		// Topic filter
		if (config.topicId !== undefined) {
			const msgThreadId = resolveMessageThreadId(update.message)
				?? update.callback_query?.message?.message_thread_id;
			if (msgThreadId !== config.topicId) return;
		}

		if (update.callback_query) {
			await handleCallbackQuery(update.callback_query);
			return;
		}

		if (!update.message) return;
		const msg = update.message;
		const text = msg.text?.trim() ?? "";

		if (text.startsWith("/")) {
			await handleCommand(text);
			return;
		}

		if (text) injectText(text, msg.message_id);
		else if (msg.photo?.length) await handlePhoto(msg);
		else {
			await sendPlain("⚠️ Unsupported message type — send text or a photo.").catch(() => {});
		}
	}

	// ─── Pi Events ──────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		await reloadConfigForCwd(ctx);

		// Only start if explicitly enabled (via config or /telegram start)
		if (!isActive(config)) return;

		// Try bridge first, fall back to direct polling
		const bridgeOk = await connectViaBridge(ctx);
		if (!bridgeOk) {
			const initialOffset = await tg.getNextUpdateOffset(config.botToken).catch(() => 0);
			startPolling(initialOffset).catch(() => {});
		}
		await registerBotCommands(config.botToken, config.chatId);

		const isFresh = ctx.sessionManager.getEntries().length === 0;
		if (isFresh) {
			const projectName = config.topicName ?? basename(ctx.cwd);
			await sendPlain(`🟢 Pi started · ${projectName}`).catch(() => {});
		}
	});

	pi.on("session_switch", async (_event, ctx) => {
		lastCtx = ctx;
		await reloadConfigForCwd(ctx);
		if (!isActive(config)) return;
		const projectName = config.topicName ?? basename(ctx.cwd);
		await sendPlain(`📂 Session switched · ${projectName}`).catch(() => {});
	});

	pi.on("before_agent_start", async (_event, _ctx) => {
		if (!isActive(config)) return;
		return {
			message: {
				content: CHOICES_SYSTEM_PROMPT,
				display: false,
			},
		};
	});

	pi.on("agent_start", async (_event, ctx) => {
		lastCtx = ctx;
		isStreaming = true;
		agentStartTime = Date.now();
		turnCount = 0;
		filesChanged = 0;
		agentPhase = "Processing request...";
		if (runTriggerMessageId === null) {
			runTriggerMessageId = nextRunTriggerMessageId;
		}
		nextRunTriggerMessageId = null;

		if (!isActive(config)) return;

		typingTimer = setInterval(async () => {
			if (!isActive(config)) return;
			if (draftState?.lastFlushCharOffset) return;
			await tg.sendChatAction(config.botToken!, config.chatId!, "typing", config.topicId).catch(() => {});
		}, 4_000);

		if (!config.streaming) return;
		if (config.draftSuppressedUntil && Date.now() < config.draftSuppressedUntil) return;

		draftIdCounter++;
		draftState = createDraftState(draftIdCounter, agentStartTime);

		heartbeatTimer = setInterval(async () => {
			if (!draftState) return;
			const flush = heartbeatDraft(draftState, Date.now(), agentPhase);
			if (flush) await flushDraftAndHandleResult(flush);
		}, DRAFT_HEARTBEAT_INTERVAL_MS);
	});

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(pi as any).on("message_update", async (event: any) => {
		const ae = event?.assistantMessageEvent;
		if (!ae) return;

		if (ae.type === "thinking_delta") {
			agentPhase = "🧠 Thinking...";
			return;
		}

		if (ae.type !== "text_delta" || typeof ae.delta !== "string") return;
		agentPhase = "Processing request...";

		if (!isActive(config) || !config.streaming || !draftState) return;
		const flush = appendDraftChunk(draftState, ae.delta as string, Date.now());
		if (flush) await flushDraftAndHandleResult(flush);
	});

	pi.on("turn_start", async (event) => {
		turnCount = event.turnIndex + 1;
	});

	pi.on("tool_call", async (event) => {
		agentPhase = `🔧 ${event.toolName}...`;

		if (!draftState || !isActive(config) || !config.streaming) return;
		if (draftState.suppressUntil > Date.now()) return;

		const nowMs = Date.now();
		const base = draftState.buffer.trim();
		const displayText = base
			? buildTransportText(`${base}\n\n${agentPhase}`, draftState.startedAt, nowMs)
			: buildHeartbeatText(draftState.startedAt, nowMs, agentPhase);

		await tg.sendMessageDraft(config.botToken, config.chatId, draftState.draftId, displayText, { messageThreadId: config.topicId })
			.catch(() => {});
	});

	pi.on("tool_result", async (event) => {
		if ((event.toolName === "edit" || event.toolName === "write") && !event.isError) {
			filesChanged++;
		}
		agentPhase = "Processing request...";
	});

	pi.on("agent_end", async (event, ctx) => {
		lastCtx = ctx;
		isStreaming = false;
		stopTimers();
		draftState = null;

		if (!isActive(config)) return;

		const elapsed = agentStartTime !== null ? Date.now() - agentStartTime : 0;
		agentStartTime = null;

		const lastAssistantText = extractLastAssistantText(event.messages);
		if (!lastAssistantText) return;

		const stats: AgentStats = {
			turnCount,
			filesChanged,
			elapsedMs: elapsed,
		};

		cleanExpiredInteractions();

		const { visibleText, choices } = parseChoicesBlock(lastAssistantText);
		const body = buildFinalMessage(choices ? visibleText : lastAssistantText, stats);
		const replyOptions = runTriggerMessageId !== null
			? { reply_parameters: { message_id: runTriggerMessageId } }
			: undefined;

		if (choices) {
			interactionSeq++;
			const id = interactionSeq;
			const sentMessageId = await send(body, {
				reply_markup: buildChoicesKeyboard(id, choices),
				...replyOptions,
			}).catch(() => null);
			pendingInteractions.set(id, {
				options: choices,
				messageId: sentMessageId,
				expiresAt: Date.now() + INTERACTION_TTL_MS,
			});
		} else {
			await send(body, replyOptions).catch(() => {});
		}

		if (isActive(config) && runTriggerMessageId !== null) {
			await tg.setMessageReaction(config.botToken, config.chatId, runTriggerMessageId, "✅").catch(() => {});
		}
		runTriggerMessageId = null;

		drainQueue();
	});

	pi.on("session_shutdown", async (_event, _ctx) => {
		disconnectBridge();
		stopPolling();
		stopTimers();
		if (setupModeTimer) { clearTimeout(setupModeTimer); setupModeTimer = null; }
		if (pendingTextEntry) { clearTimeout(pendingTextEntry.timer); pendingTextEntry = null; }
		messageQueue.clear();
		if (isActive(config)) {
			await sendPlain("🔴 Pi session ended").catch(() => {});
		}
	});

	// ─── Commands ───────────────────────────────────────────────────────

	pi.registerCommand("telegram", {
		description: "Telegram bridge — toggle, setup, or configure",

		getArgumentCompletions: (prefix: string) => {
			const subs = ["setup", "topic", "start", "stop", "status", "stream"];
			const filtered = subs.filter((s) => s.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((s) => ({ value: s, label: s })) : null;
		},

		handler: async (args, ctx) => {
			lastCtx = ctx;
			const parts = args.trim().split(/\s+/);
			const sub = parts[0]?.toLowerCase() ?? "";
			const subArgs = parts.slice(1).join(" ");

			// No arg: toggle
			if (!sub) {
				config.enabled = !config.enabled;
				updateStatus(ctx);

				if (config.enabled && isConfigured(config)) {
					const bridgeOk = await connectViaBridge(ctx);
					if (!bridgeOk && !pollingAbort) {
						startPolling().catch(() => {});
					}
					const topicLabel = config.topicName ?? (config.topicId ? `topic #${config.topicId}` : "main chat");
					const mode = bridgeOk ? "bridge" : "direct";
					ctx.ui.notify(`Telegram enabled (${mode}) — ${topicLabel}`, "info");
				} else if (!config.enabled) {
					disconnectBridge();
					stopPolling();
					ctx.ui.notify("Telegram disabled", "info");
				}
				return;
			}

			switch (sub) {
				case "setup": {
					const hint = config.botToken
						? `Current: ${config.botToken.slice(0, 12)}… — leave blank to keep, or enter a new token`
						: "Enter your Telegram bot token from @BotFather";
					const token = await ctx.ui.input("Bot Token", hint);
					if (token === null) {
						ctx.ui.notify("Setup cancelled", "info");
						return;
					}
					const trimmed = token.trim();
					if (trimmed) {
						config.botToken = trimmed;
						await persistConfig(config);
					} else if (!config.botToken) {
						ctx.ui.notify("No bot token provided — setup cancelled.", "warning");
						return;
					}

					const currentTopic = config.topicId ? `Current: ${config.topicId}` : "none";
					const topicHint = `Forum topic ID (message_thread_id) — leave blank to clear / use no topic. Current: ${currentTopic}`;
					const topicInput = await ctx.ui.input("Topic ID (optional)", topicHint);
					if (topicInput !== null) {
						const trimmedTopic = topicInput.trim();
						const tid = parseInt(trimmedTopic, 10);
						if (!isNaN(tid) && tid > 0) {
							config.topicId = tid;
						} else {
							config.topicId = undefined;
							config.topicName = undefined;
						}
					}

					if (config.topicId) {
						const nameHint = config.topicName
							? `Current: ${config.topicName} — leave blank to keep`
							: "Short project name shown in notifications (e.g. my-project)";
						const nameInput = await ctx.ui.input("Project name (optional)", nameHint);
						if (nameInput !== null && nameInput.trim()) {
							config.topicName = nameInput.trim();
						}
					}

					setupMode = true;
					if (setupModeTimer) clearTimeout(setupModeTimer);
					setupModeTimer = setTimeout(() => {
						if (setupMode) {
							setupMode = false;
							setupModeTimer = null;
							if (lastCtx) updateStatus(lastCtx);
							lastCtx?.ui.notify("⏱ Setup mode expired — run /telegram setup again to pair.", "warning");
						}
					}, SETUP_MODE_TTL_MS);

					config.enabled = true; // Session-only for setup pairing
					await persistProjectConfig(ctx.cwd, { topicId: config.topicId, topicName: config.topicName });
					updateStatus(ctx);

					stopPolling();
					const initialOffset = config.botToken
						? await tg.getNextUpdateOffset(config.botToken).catch(() => 0)
						: 0;
					startPolling(initialOffset).catch(() => {});

					ctx.ui.notify(
						"📱 Send any message to your Telegram bot to pair this chat (expires in 5 min).",
						"info",
					);
					break;
				}

				case "start": {
					config.enabled = true;
					updateStatus(ctx);

					if (isConfigured(config)) {
						// Try bridge first, fall back to direct polling
						const bridgeOk = await connectViaBridge(ctx);
						if (bridgeOk) {
							const topicLabel = config.topicName ?? (config.topicId ? `topic #${config.topicId}` : "main chat");
							ctx.ui.notify(`Telegram started (bridge) — ${topicLabel}`, "info");
						} else if (!pollingAbort) {
							const initialOffset = await tg.getNextUpdateOffset(config.botToken).catch(() => 0);
							startPolling(initialOffset).catch(() => {});
							const topicLabel2 = config.topicName ?? (config.topicId ? `topic #${config.topicId}` : "main chat");
							ctx.ui.notify(`Telegram started (direct) — ${topicLabel2}`, "info");
						}
					}
					break;
				}

				case "stop": {
					config.enabled = false;
					disconnectBridge();
					stopPolling();
					updateStatus(ctx);
					ctx.ui.notify("Telegram stopped", "info");
					break;
				}

				case "stream": {
					config.streaming = !config.streaming;
					if (config.streaming) config.draftSuppressedUntil = undefined;
					await persistConfig(config);
					ctx.ui.notify(
						`Live draft streaming ${config.streaming ? "enabled (default)" : "disabled"}`,
						"info",
					);
					break;
				}

				case "status": {
					const lines = [
						`Token   : ${config.botToken ? config.botToken.slice(0, 12) + "…" : "not set"}`,
						`Chat ID : ${config.chatId ?? "not set"}`,
						`User ID : ${config.allowedUserId ?? "not set"}`,
						`Topic   : ${config.topicId ? `${config.topicName ?? "unnamed"} (#${config.topicId})` : "none"}`,
						`Enabled : ${config.enabled ? "yes" : "no"}`,
						`Stream  : ${config.streaming ? "yes" : "no"}`,
						`Polling : ${pollingAbort ? "active" : "stopped"}`,
						`Agent   : ${isStreaming ? "running" : "idle"}`,
					];
					ctx.ui.notify(lines.join("\n"), "info");
					break;
				}

				case "topic": {
					if (!isConfigured(config)) {
						ctx.ui.notify("Telegram not configured — run /telegram setup first.", "warning");
						break;
					}

					// If topic already exists for this project, show it instead of creating a duplicate
					if (config.topicId) {
						const keep = await ctx.ui.confirm(
							"Topic exists",
							`Already bound to topic "${config.topicName ?? config.topicId}" (id: ${config.topicId}). Create a new one instead?`,
						);
						if (!keep) break;
					}

					const rawName = subArgs.trim();
					const topicName = rawName || basename(ctx.cwd);
					try {
						const { message_thread_id } = await tg.createForumTopic(config.botToken, config.chatId, topicName);
						config.topicId = message_thread_id;
						config.topicName = topicName;
						await persistConfig(config);
						await persistProjectConfig(ctx.cwd, { topicId: message_thread_id, topicName });
						ctx.ui.notify(
							`✅ Forum topic created: "${topicName}" (id: ${message_thread_id})\nAll messages now routed to this topic.`,
							"info",
						);
					} catch (err) {
						ctx.ui.notify(
							`❌ Could not create topic: ${err instanceof Error ? err.message : String(err)}\nMake sure the bot is admin in a supergroup with Topics enabled.`,
							"error",
						);
					}
					break;
				}

				default:
					ctx.ui.notify(
						"Usage: /telegram [setup | topic <name> | start | stop | status | stream]",
						"warning",
					);
			}
		},
	});
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		if (signal) {
			const onAbort = () => {
				clearTimeout(timer);
				reject(new DOMException("Aborted", "AbortError"));
			};
			if (signal.aborted) {
				onAbort();
			} else {
				signal.addEventListener("abort", onAbort, { once: true });
			}
		}
	});
}
