package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"
)

// ── Types ────────────────────────────────────────────────────────────────

// Event is pushed from an adapter to a pi session via SSE.
type Event struct {
	Type        string `json:"type"`                  // "message", "photo", "command"
	Adapter     string `json:"adapter"`               // "telegram", "discord", etc.
	Text        string `json:"text,omitempty"`
	MessageID   int    `json:"messageId,omitempty"`
	TopicID     int    `json:"topicId,omitempty"`
	PhotoFileID string `json:"photoFileId,omitempty"`
}

// Session represents a registered pi session.
type Session struct {
	ID       string    `json:"id"`
	CWD      string    `json:"cwd"`
	TopicID  int       `json:"topicId"`
	Adapter  string    `json:"adapter"` // which adapter this session uses
	Events   chan Event `json:"-"`
	LastSeen time.Time `json:"-"`
}

// ── Router ───────────────────────────────────────────────────────────────

// Router manages session registration, topic routing, and SSE delivery.
// Implements telegram.EventRouter so adapters can push events.
type Router struct {
	mu       sync.RWMutex
	sessions map[string]*Session // sessionId → Session
	adapters map[string]Adapter  // adapter name → Adapter
}

// StopAdapters shuts down all registered adapters.
func (r *Router) StopAdapters() {
	r.mu.RLock()
	defer r.mu.RUnlock()
	for _, a := range r.adapters {
		a.Stop()
	}
}



func newRouter() *Router {
	r := &Router{
		sessions: make(map[string]*Session),
		adapters: make(map[string]Adapter),
	}
	go r.cleanupLoop()
	return r
}

// RegisterAdapter adds an adapter to the router.
func (r *Router) RegisterAdapter(a Adapter) {
	r.mu.Lock()
	r.adapters[a.Name()] = a
	r.mu.Unlock()
}

// GetAdapter returns an adapter by name.
func (r *Router) GetAdapter(name string) Adapter {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.adapters[name]
}

// findSessionByTopic finds the session registered for a given topic+adapter.
func (r *Router) findSessionByTopic(adapterName string, topicID int) *Session {
	r.mu.RLock()
	defer r.mu.RUnlock()
	for _, s := range r.sessions {
		if s.Adapter == adapterName && s.TopicID == topicID {
			return s
		}
	}
	return nil
}

func (r *Router) register(id, cwd, adapter string, topicID int) (*Session, string) {
	r.mu.Lock()
	defer r.mu.Unlock()

	// Check for conflicting session on same topic (different session ID)
	if topicID > 0 {
		for existID, s := range r.sessions {
			if existID != id && s.Adapter == adapter && s.TopicID == topicID {
				log.Printf("Topic %d already claimed by session %s — rejecting %s", topicID, existID, id)
				return nil, fmt.Sprintf("topic %d already claimed by another session", topicID)
			}
		}
	}

	if existing, ok := r.sessions[id]; ok {
		existing.CWD = cwd
		existing.TopicID = topicID
		existing.Adapter = adapter
		existing.LastSeen = time.Now()
		return existing, ""
	}

	s := &Session{
		ID:       id,
		CWD:      cwd,
		TopicID:  topicID,
		Adapter:  adapter,
		Events:   make(chan Event, 64),
		LastSeen: time.Now(),
	}
	r.sessions[id] = s
	log.Printf("Session registered: %s (adapter=%s, topic=%d, cwd=%s)", id, adapter, topicID, cwd)
	return s, ""
}

func (r *Router) unregister(id string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if s, ok := r.sessions[id]; ok {
		close(s.Events)
		delete(r.sessions, id)
		log.Printf("Session unregistered: %s", id)
	}
}

func (r *Router) cleanupLoop() {
	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		r.mu.Lock()
		now := time.Now()
		for id, s := range r.sessions {
			if now.Sub(s.LastSeen) > 5*time.Minute {
				close(s.Events)
				delete(r.sessions, id)
				log.Printf("Session expired (no heartbeat): %s", id)
			}
		}
		r.mu.Unlock()
	}
}

// ── HTTP: /register ──────────────────────────────────────────────────────

type registerReq struct {
	SessionID string `json:"sessionId"`
	CWD       string `json:"cwd"`
	TopicID   int    `json:"topicId"`
	Adapter   string `json:"adapter"`
}

func (r *Router) handleRegister(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	var body registerReq
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}
	if body.SessionID == "" || body.Adapter == "" {
		http.Error(w, "sessionId and adapter required", http.StatusBadRequest)
		return
	}
	_, conflict := r.register(body.SessionID, body.CWD, body.Adapter, body.TopicID)
	if conflict != "" {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		json.NewEncoder(w).Encode(map[string]string{"error": conflict})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"ok":true}`))
}

// ── HTTP: /unregister ────────────────────────────────────────────────────

type unregisterReq struct {
	SessionID string `json:"sessionId"`
}

func (r *Router) handleUnregister(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	var body unregisterReq
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}
	r.unregister(body.SessionID)
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"ok":true}`))
}

// ── HTTP: /events (SSE) ──────────────────────────────────────────────────

func (r *Router) handleEvents(w http.ResponseWriter, req *http.Request) {
	sessionID := req.URL.Query().Get("sessionId")
	if sessionID == "" {
		http.Error(w, "sessionId query param required", http.StatusBadRequest)
		return
	}

	r.mu.RLock()
	session, ok := r.sessions[sessionID]
	r.mu.RUnlock()
	if !ok {
		http.Error(w, "session not registered", http.StatusNotFound)
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	flusher.Flush()

	ctx := req.Context()
	heartbeat := time.NewTicker(30 * time.Second)
	defer heartbeat.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case evt, ok := <-session.Events:
			if !ok {
				return
			}
			data, _ := json.Marshal(evt)
			fmt.Fprintf(w, "data: %s\n\n", data)
			flusher.Flush()

			r.mu.Lock()
			session.LastSeen = time.Now()
			r.mu.Unlock()
		case <-heartbeat.C:
			fmt.Fprintf(w, ": heartbeat\n\n")
			flusher.Flush()

			r.mu.Lock()
			session.LastSeen = time.Now()
			r.mu.Unlock()
		}
	}
}

// ── HTTP: /sessions (list registered sessions) ───────────────────────────

func (r *Router) handleSessions(w http.ResponseWriter, req *http.Request) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	type sessionInfo struct {
		ID       string `json:"id"`
		CWD      string `json:"cwd"`
		TopicID  int    `json:"topicId"`
		Adapter  string `json:"adapter"`
		LastSeen string `json:"lastSeen"`
	}

	list := make([]sessionInfo, 0, len(r.sessions))
	for _, s := range r.sessions {
		list = append(list, sessionInfo{
			ID:       s.ID,
			CWD:      s.CWD,
			TopicID:  s.TopicID,
			Adapter:  s.Adapter,
			LastSeen: s.LastSeen.Format(time.RFC3339),
		})
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(list)
}
