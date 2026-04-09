package main

// Adapter is the interface that external service integrations implement.
// Each adapter handles its own inbound polling and outbound sending.
type Adapter interface {
	// Name returns a unique identifier for this adapter (e.g. "telegram").
	Name() string

	// Start begins the adapter's inbound loop (e.g. Telegram long-poll).
	// Events are pushed to the router. Called once on startup.
	Start(router *Router)

	// Stop gracefully shuts down the adapter's inbound loop.
	Stop()

	// Send delivers an outbound message through this adapter.
	// Returns a provider-specific message ID (or 0) and any error.
	Send(topicID int, text string, opts SendOpts) (messageID int, err error)

	// React adds a reaction to an inbound message (best-effort).
	React(messageID int, emoji string)
}

// SendOpts are optional parameters for outbound messages.
type SendOpts struct {
	ParseMode string // "HTML", "MarkdownV2", or ""
	ReplyTo   int    // Message ID to reply to (0 = no reply)
}
