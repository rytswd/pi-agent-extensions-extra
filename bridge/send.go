package main

import (
	"encoding/json"
	"net/http"
)

// ── Send endpoint — pi sessions send outbound messages via the bridge ────

type sendReq struct {
	Adapter   string `json:"adapter"`
	TopicID   int    `json:"topicId"`
	Text      string `json:"text"`
	ParseMode string `json:"parseMode,omitempty"`
	ReplyTo   int    `json:"replyTo,omitempty"`
}

type sendResp struct {
	OK        bool `json:"ok"`
	MessageID int  `json:"messageId,omitempty"`
}

// handleSend dispatches an outbound message to the appropriate adapter.
func handleSend(router *Router) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "POST only", http.StatusMethodNotAllowed)
			return
		}

		var body sendReq
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid JSON", http.StatusBadRequest)
			return
		}
		if body.Text == "" || body.Adapter == "" {
			http.Error(w, "adapter and text required", http.StatusBadRequest)
			return
		}

		adapter := router.GetAdapter(body.Adapter)
		if adapter == nil {
			http.Error(w, "unknown adapter: "+body.Adapter, http.StatusBadRequest)
			return
		}

		opts := SendOpts{
			ParseMode: body.ParseMode,
			ReplyTo:   body.ReplyTo,
		}

		// Chunk if needed (Telegram limit: 4096 chars, others may differ)
		chunks := chunkText(body.Text, 4096)
		var lastID int
		for i, chunk := range chunks {
			msgID, err := adapter.Send(body.TopicID, chunk, opts)
			if err != nil {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusBadGateway)
				json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
				return
			}
			lastID = msgID
			// Only reply to first chunk
			if i == 0 {
				opts.ReplyTo = 0
			}
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(sendResp{OK: true, MessageID: lastID})
	}
}

// chunkText splits text into chunks of at most maxLen chars.
func chunkText(text string, maxLen int) []string {
	if len(text) <= maxLen {
		return []string{text}
	}
	var chunks []string
	for len(text) > 0 {
		if len(text) <= maxLen {
			chunks = append(chunks, text)
			break
		}
		splitAt := maxLen
		for i := maxLen - 1; i > maxLen/2; i-- {
			if text[i] == '\n' {
				splitAt = i + 1
				break
			}
		}
		chunks = append(chunks, text[:splitAt])
		text = text[splitAt:]
	}
	return chunks
}
