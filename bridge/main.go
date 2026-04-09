package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"

	tg "github.com/rytswd/pi-agent-extensions-extra/pi-bridge/adapter/telegram"
)

func main() {
	cfg, err := loadConfig()
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}

	if err := writePIDFile(); err != nil {
		log.Printf("Warning: could not write PID file: %v", err)
	}
	defer removePIDFile()

	router := newRouter()

	// Initialize adapters from config
	for _, ac := range cfg.Adapters {
		switch ac.Type {
		case "telegram":
			var tgCfg tg.Config
			raw, _ := json.Marshal(ac.Config)
			json.Unmarshal(raw, &tgCfg)
			adapter := tg.New(tgCfg)
			router.RegisterAdapter(newAdapterWrapper(adapter))
			adapter.StartWithHandlers(
				// onEvent: route to session
				func(topicID int, evt tg.Event) bool {
					session := router.findSessionByTopic("telegram", topicID)
					if session == nil {
						return false
					}
					// Convert to bridge Event
					data, _ := json.Marshal(evt)
					var bridgeEvt Event
					json.Unmarshal(data, &bridgeEvt)
					select {
					case session.Events <- bridgeEvt:
					default:
						log.Printf("Event channel full for session %s", session.ID)
					}
					return true
				},
				// onNoSession: reply in Telegram
				func(topicID int) {
					opts := map[string]any{"chat_id": tgCfg.ChatID, "text": "\u26a0\ufe0f No pi session connected. Start one with /telegram in pi."}
					if topicID > 0 {
						opts["message_thread_id"] = topicID
					}
					adapter.Send(topicID, "\u26a0\ufe0f No pi session connected. Start one with /telegram in pi.", "", 0)
				},
			)
			log.Printf("Adapter started: telegram")
		default:
			log.Printf("Unknown adapter type: %s", ac.Type)
		}
	}

	// HTTP API
	mux := http.NewServeMux()
	mux.HandleFunc("/health", handleHealth)
	mux.HandleFunc("/register", router.handleRegister)
	mux.HandleFunc("/unregister", router.handleUnregister)
	mux.HandleFunc("/send", handleSend(router))
	mux.HandleFunc("/events", router.handleEvents)
	mux.HandleFunc("/sessions", router.handleSessions)

	addr := fmt.Sprintf("127.0.0.1:%d", cfg.Port)
	log.Printf("pi-bridge listening on %s", addr)

	// Graceful shutdown
	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		log.Println("Shutting down...")
		router.StopAdapters()
		removePIDFile()
		os.Exit(0)
	}()

	log.Fatal(http.ListenAndServe(addr, mux))
}

// ── Config ───────────────────────────────────────────────────────────────

type adapterConfig struct {
	Type   string         `json:"type"`
	Config map[string]any `json:"config"`
}

type bridgeConfig struct {
	Port     int             `json:"port"`
	Adapters []adapterConfig `json:"adapters"`
}

// Resolve config directory. See .ref/config-dir.org for convention.
func configDir() string {
	// 1. Check override file
	home, _ := os.UserHomeDir()
	overrideFile := filepath.Join(home, ".pi", "agent", "pi-agent-extensions.json")
	if data, err := os.ReadFile(overrideFile); err == nil {
		var override struct {
			ConfigDir string `json:"configDir"`
		}
		if json.Unmarshal(data, &override) == nil && override.ConfigDir != "" {
			return filepath.Join(override.ConfigDir, "bridge")
		}
	}
	// 2. XDG_CONFIG_HOME
	if xdg := os.Getenv("XDG_CONFIG_HOME"); xdg != "" {
		return filepath.Join(xdg, "pi-agent-extensions", "bridge")
	}
	// 3. Default
	return filepath.Join(home, ".config", "pi-agent-extensions", "bridge")
}

func configPath() string {
	return filepath.Join(configDir(), "config.json")
}

func loadConfig() (*bridgeConfig, error) {
	data, err := os.ReadFile(configPath())
	if err != nil {
		return nil, fmt.Errorf("read config %s: %w", configPath(), err)
	}
	var cfg bridgeConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}
	if cfg.Port == 0 {
		cfg.Port = 19384
	}
	return &cfg, nil
}

// ── PID file ─────────────────────────────────────────────────────────────

func pidPath() string {
	return filepath.Join(configDir(), "bridge.pid")
}

func writePIDFile() error {
	if err := os.MkdirAll(configDir(), 0755); err != nil {
		return err
	}
	return os.WriteFile(pidPath(), []byte(strconv.Itoa(os.Getpid())), 0644)
}

func removePIDFile() {
	os.Remove(pidPath())
}

// ── Health endpoint ──────────────────────────────────────────────────────

func handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"status":"ok"}`))
}

// ── Adapter wrapper (bridges tg.Adapter to the Adapter interface) ────────

type telegramAdapterWrapper struct {
	inner *tg.Adapter
}

func newAdapterWrapper(a *tg.Adapter) Adapter {
	return &telegramAdapterWrapper{inner: a}
}

func (w *telegramAdapterWrapper) Name() string { return "telegram" }
func (w *telegramAdapterWrapper) Start(router *Router) {
	// Already started in main()
}
func (w *telegramAdapterWrapper) Stop()                     { w.inner.Stop() }
func (w *telegramAdapterWrapper) React(messageID int, emoji string) { w.inner.React(messageID, emoji) }
func (w *telegramAdapterWrapper) Send(topicID int, text string, opts SendOpts) (int, error) {
	return w.inner.Send(topicID, text, opts.ParseMode, opts.ReplyTo)
}
