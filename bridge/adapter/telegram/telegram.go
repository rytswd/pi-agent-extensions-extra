package telegram

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"time"
)

// ── Telegram types ───────────────────────────────────────────────────────

type User struct {
	ID    int64 `json:"id"`
	IsBot bool  `json:"is_bot"`
}

type Chat struct {
	ID   int64  `json:"id"`
	Type string `json:"type"`
}

type PhotoSize struct {
	FileID string `json:"file_id"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
}

type Message struct {
	MessageID       int         `json:"message_id"`
	From            *User       `json:"from,omitempty"`
	Chat            Chat        `json:"chat"`
	Text            string      `json:"text,omitempty"`
	Caption         string      `json:"caption,omitempty"`
	Photo           []PhotoSize `json:"photo,omitempty"`
	MessageThreadID int         `json:"message_thread_id,omitempty"`
}

type CallbackQuery struct {
	ID      string   `json:"id"`
	From    User     `json:"from"`
	Message *Message `json:"message,omitempty"`
	Data    string   `json:"data,omitempty"`
}

type Update struct {
	UpdateID      int            `json:"update_id"`
	Message       *Message       `json:"message,omitempty"`
	CallbackQuery *CallbackQuery `json:"callback_query,omitempty"`
}

type apiResponse struct {
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result,omitempty"`
	Desc   string          `json:"description,omitempty"`
	Code   int             `json:"error_code,omitempty"`
}

// ── Config ───────────────────────────────────────────────────────────────

type Config struct {
	BotToken      string `json:"botToken"`
	ChatID        int64  `json:"chatId"`
	AllowedUserID int64  `json:"allowedUserId"`
}

// ── Event is the bridge-level event type (imported from parent package) ──

type Event struct {
	Type        string `json:"type"`
	Adapter     string `json:"adapter"`
	Text        string `json:"text,omitempty"`
	MessageID   int    `json:"messageId,omitempty"`
	TopicID     int    `json:"topicId,omitempty"`
	PhotoFileID string `json:"photoFileId,omitempty"`
}

// EventHandler is called by the adapter when an inbound event arrives.
// Returns true if a session was found and the event was delivered.
type EventHandler func(topicID int, evt Event) bool

// NoSessionHandler is called when no session is found for a topic.
type NoSessionHandler func(topicID int)

// ── API helpers ──────────────────────────────────────────────────────────

func apiCall(token, method string, body any) (json.RawMessage, error) {
	var reqBody io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reqBody = bytes.NewReader(data)
	}

	url := fmt.Sprintf("https://api.telegram.org/bot%s/%s", token, method)
	client := &http.Client{Timeout: 10 * time.Second}
	req, err := http.NewRequest("POST", url, reqBody)
	if err != nil {
		return nil, err
	}
	if reqBody != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var tgResp apiResponse
	if err := json.NewDecoder(resp.Body).Decode(&tgResp); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}
	if !tgResp.OK {
		return nil, fmt.Errorf("telegram %s: %s (%d)", method, tgResp.Desc, tgResp.Code)
	}
	return tgResp.Result, nil
}

// ── Adapter ──────────────────────────────────────────────────────────────

type Adapter struct {
	cfg             Config
	onEvent         EventHandler
	onNoSession     NoSessionHandler
	stopCh          chan struct{}
}

func New(cfg Config) *Adapter {
	return &Adapter{
		cfg:    cfg,
		stopCh: make(chan struct{}),
	}
}

func (a *Adapter) Name() string { return "telegram" }

func (a *Adapter) StartWithHandlers(onEvent EventHandler, onNoSession NoSessionHandler) {
	a.onEvent = onEvent
	a.onNoSession = onNoSession
	go a.poll()
}

func (a *Adapter) Stop() {
	close(a.stopCh)
}

func (a *Adapter) Send(topicID int, text string, parseMode string, replyTo int) (int, error) {
	params := map[string]any{
		"chat_id": a.cfg.ChatID,
		"text":    text,
	}
	if parseMode != "" {
		params["parse_mode"] = parseMode
	}
	if topicID > 0 {
		params["message_thread_id"] = topicID
	}
	if replyTo > 0 {
		params["reply_parameters"] = map[string]any{"message_id": replyTo}
	}

	raw, err := apiCall(a.cfg.BotToken, "sendMessage", params)
	if err != nil {
		return 0, err
	}
	var msg Message
	json.Unmarshal(raw, &msg)
	return msg.MessageID, nil
}

func (a *Adapter) React(messageID int, emoji string) {
	apiCall(a.cfg.BotToken, "setMessageReaction", map[string]any{
		"chat_id":    a.cfg.ChatID,
		"message_id": messageID,
		"reaction":   []map[string]any{{"type": "emoji", "emoji": emoji}},
		"is_big":     false,
	})
}

// ── Polling loop ─────────────────────────────────────────────────────────

func (a *Adapter) poll() {
	offset := a.getInitialOffset()

	for {
		select {
		case <-a.stopCh:
			return
		default:
		}

		updates, err := a.getUpdates(offset)
		if err != nil {
			log.Printf("[telegram] getUpdates error: %v", err)
			select {
			case <-a.stopCh:
				return
			case <-time.After(5 * time.Second):
			}
			continue
		}

		for _, u := range updates {
			offset = u.UpdateID + 1
			a.handleUpdate(u)
		}
	}
}

func (a *Adapter) getInitialOffset() int {
	raw, err := apiCall(a.cfg.BotToken, "getUpdates", map[string]any{
		"offset": -1, "timeout": 0,
		"allowed_updates": []string{"message", "callback_query"},
	})
	if err != nil {
		return 0
	}
	var updates []Update
	json.Unmarshal(raw, &updates)
	if len(updates) == 0 {
		return 0
	}
	return updates[len(updates)-1].UpdateID + 1
}

func (a *Adapter) getUpdates(offset int) ([]Update, error) {
	client := &http.Client{Timeout: 40 * time.Second}
	body, _ := json.Marshal(map[string]any{
		"offset": offset, "timeout": 30,
		"allowed_updates": []string{"message", "callback_query"},
	})
	url := fmt.Sprintf("https://api.telegram.org/bot%s/getUpdates", a.cfg.BotToken)
	resp, err := client.Post(url, "application/json", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var tgResp apiResponse
	if err := json.NewDecoder(resp.Body).Decode(&tgResp); err != nil {
		return nil, err
	}
	if !tgResp.OK {
		return nil, fmt.Errorf("getUpdates: %s (%d)", tgResp.Desc, tgResp.Code)
	}
	var updates []Update
	json.Unmarshal(tgResp.Result, &updates)
	return updates, nil
}

func (a *Adapter) handleUpdate(u Update) {
	// Security: only accept from allowed user
	senderID := int64(0)
	if u.Message != nil && u.Message.From != nil {
		senderID = u.Message.From.ID
	} else if u.CallbackQuery != nil {
		senderID = u.CallbackQuery.From.ID
	}
	if a.cfg.AllowedUserID != 0 && senderID != a.cfg.AllowedUserID {
		return
	}

	if u.Message == nil {
		return
	}
	msg := u.Message
	topicID := msg.MessageThreadID

	// React 👀
	a.React(msg.MessageID, "👀")

	text := msg.Text
	if text == "" {
		text = msg.Caption
	}

	evt := Event{
		Type:      "message",
		Adapter:   "telegram",
		Text:      text,
		MessageID: msg.MessageID,
		TopicID:   topicID,
	}

	if len(msg.Photo) > 0 {
		largest := msg.Photo[len(msg.Photo)-1]
		evt.Type = "photo"
		evt.PhotoFileID = largest.FileID
		if evt.Text == "" {
			evt.Text = "Image from Telegram"
		}
	}

	if a.onEvent != nil {
		if !a.onEvent(topicID, evt) {
			if a.onNoSession != nil {
				a.onNoSession(topicID)
			}
		}
	}
}
