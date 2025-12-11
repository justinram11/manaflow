// ws-ssh-proxy: Simple WebSocket-to-TCP bridge for SSH-over-HTTPS
// This replaces chisel with a much simpler protocol - just raw WebSocket frames
// carrying TCP data to/from localhost:22
package main

import (
	"flag"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

var (
	listenAddr = flag.String("listen", ":22221", "Address to listen on")
	sshAddr    = flag.String("ssh", "localhost:22", "SSH server address to connect to")
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  16384,
	WriteBufferSize: 16384,
	CheckOrigin:     func(r *http.Request) bool { return true },
}

func handleWebSocket(w http.ResponseWriter, r *http.Request) {
	// Upgrade HTTP to WebSocket
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("WebSocket upgrade failed: %v", err)
		return
	}
	defer ws.Close()

	// Connect to SSH server
	ssh, err := net.DialTimeout("tcp", *sshAddr, 10*time.Second)
	if err != nil {
		log.Printf("Failed to connect to SSH server %s: %v", *sshAddr, err)
		ws.WriteMessage(websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseInternalServerErr, "SSH connection failed"))
		return
	}
	defer ssh.Close()

	log.Printf("New connection: WebSocket -> %s", *sshAddr)

	var wg sync.WaitGroup
	wg.Add(2)

	// WebSocket -> SSH
	go func() {
		defer wg.Done()
		defer ssh.Close()
		for {
			messageType, data, err := ws.ReadMessage()
			if err != nil {
				if !websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
					log.Printf("WebSocket read error: %v", err)
				}
				return
			}
			if messageType == websocket.BinaryMessage || messageType == websocket.TextMessage {
				if _, err := ssh.Write(data); err != nil {
					log.Printf("SSH write error: %v", err)
					return
				}
			}
		}
	}()

	// SSH -> WebSocket
	go func() {
		defer wg.Done()
		defer ws.Close()
		buf := make([]byte, 16384)
		for {
			n, err := ssh.Read(buf)
			if err != nil {
				if err != io.EOF {
					log.Printf("SSH read error: %v", err)
				}
				return
			}
			if err := ws.WriteMessage(websocket.BinaryMessage, buf[:n]); err != nil {
				log.Printf("WebSocket write error: %v", err)
				return
			}
		}
	}()

	wg.Wait()
	log.Printf("Connection closed")
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	w.Write([]byte("ok"))
}

func main() {
	flag.Parse()

	// Set up logging
	log.SetOutput(os.Stdout)
	log.SetFlags(log.Ldate | log.Ltime | log.Lmicroseconds)

	mux := http.NewServeMux()
	mux.HandleFunc("/", handleWebSocket)
	mux.HandleFunc("/health", healthHandler)

	log.Printf("ws-ssh-proxy starting on %s, forwarding to %s", *listenAddr, *sshAddr)

	server := &http.Server{
		Addr:         *listenAddr,
		Handler:      mux,
		ReadTimeout:  0, // No timeout for SSH sessions
		WriteTimeout: 0,
	}

	if err := server.ListenAndServe(); err != nil {
		log.Fatalf("Server failed: %v", err)
	}
}
