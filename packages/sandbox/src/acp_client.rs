use agent_client_protocol::{
    Client, Agent, ClientSideConnection, Error, RequestPermissionRequest, RequestPermissionResponse,
    RequestPermissionOutcome, PermissionOptionId,
    ReadTextFileRequest, ReadTextFileResponse, WriteTextFileRequest, WriteTextFileResponse,
    CreateTerminalRequest, CreateTerminalResponse, TerminalOutputRequest, TerminalOutputResponse,
    SessionNotification, InitializeRequest, NewSessionRequest,
    ClientCapabilities, FileSystemCapability, PromptRequest, ContentBlock, SessionUpdate,
    SessionId, TextContent, V1,
    ReleaseTerminalRequest, ReleaseTerminalResponse,
    WaitForTerminalExitRequest, WaitForTerminalExitResponse,
    KillTerminalCommandRequest, KillTerminalCommandResponse,
};
use ratatui::{
    backend::CrosstermBackend,
    layout::{Constraint, Direction, Layout},
    widgets::{Block, Borders, Paragraph, Wrap},
    Terminal,
};
use crossterm::{
    event::{self, DisableMouseCapture, EnableMouseCapture, Event, KeyCode, KeyModifiers, EventStream},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use tui_textarea::{TextArea, Input, Key};
use tokio::sync::mpsc;
use std::{sync::Arc, io, fs::OpenOptions, io::Write};
use futures::{StreamExt, SinkExt};
use anyhow::Result;

fn log_debug(msg: &str) {
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open("/tmp/cmux-chat.log") {
        let _ = writeln!(file, "[{}] {}", chrono::Utc::now().to_rfc3339(), msg);
    }
}

struct AppClient {
    tx: mpsc::UnboundedSender<AppEvent>,
}

#[derive(Debug)]
enum AppEvent {
    SessionUpdate(SessionNotification),
    Error(String),
}

#[async_trait::async_trait(?Send)]
impl Client for AppClient {
    async fn request_permission(
        &self,
        request: RequestPermissionRequest,
    ) -> Result<RequestPermissionResponse, Error> {
        log_debug(&format!("RequestPermission: {:?}", request));
        let option_id = request.options.first().map(|o| o.id.clone())
            .unwrap_or(PermissionOptionId("allow".into()));

        Ok(RequestPermissionResponse {
            outcome: RequestPermissionOutcome::Selected { option_id },
            meta: None,
        })
    }

    async fn read_text_file(
        &self,
        request: ReadTextFileRequest,
    ) -> Result<ReadTextFileResponse, Error> {
        log_debug(&format!("ReadTextFile: {:?}", request.path));
        match tokio::fs::read_to_string(&request.path).await {
            Ok(content) => Ok(ReadTextFileResponse {
                content,
                meta: None,
            }),
            Err(e) => {
                log_debug(&format!("ReadTextFile Error: {}", e));
                Err(Error::internal_error().with_data(e.to_string()))
            },
        }
    }

    async fn write_text_file(
        &self,
        request: WriteTextFileRequest,
    ) -> Result<WriteTextFileResponse, Error> {
        log_debug(&format!("WriteTextFile: {:?}", request.path));
        match tokio::fs::write(&request.path, &request.content).await {
            Ok(_) => Ok(WriteTextFileResponse::default()),
            Err(e) => Err(Error::internal_error().with_data(e.to_string())),
        }
    }

    async fn create_terminal(
        &self,
        _request: CreateTerminalRequest,
    ) -> Result<CreateTerminalResponse, Error> {
         Err(Error::internal_error().with_data("Terminal not supported yet"))
    }

    async fn terminal_output(
        &self,
        _request: TerminalOutputRequest,
    ) -> Result<TerminalOutputResponse, Error> {
        Err(Error::internal_error().with_data("Terminal not supported yet"))
    }

    async fn release_terminal(
        &self,
        _request: ReleaseTerminalRequest,
    ) -> Result<ReleaseTerminalResponse, Error> {
         Err(Error::internal_error().with_data("Terminal not supported yet"))
    }

    async fn wait_for_terminal_exit(
        &self,
        _request: WaitForTerminalExitRequest,
    ) -> Result<WaitForTerminalExitResponse, Error> {
         Err(Error::internal_error().with_data("Terminal not supported yet"))
    }

    async fn kill_terminal_command(
        &self,
        _request: KillTerminalCommandRequest,
    ) -> Result<KillTerminalCommandResponse, Error> {
         Err(Error::internal_error().with_data("Terminal not supported yet"))
    }

    async fn session_notification(&self, notification: SessionNotification) -> Result<(), Error> {
        log_debug(&format!("SessionNotification: {:?}", notification));
        let _ = self.tx.send(AppEvent::SessionUpdate(notification));
        Ok(())
    }
}

struct App<'a> {
    history: Vec<String>,
    textarea: TextArea<'a>,
    client_connection: Option<Arc<ClientSideConnection>>,
    session_id: Option<SessionId>,
}

impl<'a> App<'a> {
    fn new() -> Self {
        let mut textarea = TextArea::default();
        textarea.set_block(
            Block::default()
                .borders(Borders::TOP | Borders::BOTTOM)
                .border_style(ratatui::style::Style::default().fg(ratatui::style::Color::DarkGray))
        );
        textarea.set_placeholder_text("Type a message and press Enter to send. Ctrl+J for new line.");
        Self {
            history: vec![],
            textarea,
            client_connection: None,
            session_id: None,
        }
    }

    fn on_session_update(&mut self, notification: SessionNotification) {
        match notification.update {
            SessionUpdate::UserMessageChunk(chunk) => {
                 if let ContentBlock::Text(text_content) = chunk.content {
                     self.append_message("User", &text_content.text);
                 }
            }
            SessionUpdate::AgentMessageChunk(chunk) => {
                 if let ContentBlock::Text(text_content) = chunk.content {
                     self.append_message("Agent", &text_content.text);
                 }
            }
            SessionUpdate::AgentThoughtChunk(chunk) => {
                 if let ContentBlock::Text(text_content) = chunk.content {
                     self.append_message("Thought", &text_content.text);
                 }
            }
            _ => {}
        }
    }

    fn append_message(&mut self, role: &str, text: &str) {
        let prefix = format!("{}: ", role);
        if let Some(last) = self.history.last_mut() {
             if last.starts_with(&prefix) {
                 last.push_str(text);
                 return;
             }
        }
        self.history.push(format!("{}{}", prefix, text));
    }

    async fn send_message(&mut self) {
        // Clone connection and session_id early to drop the borrow of self
        let (conn, session_id) = if let (Some(conn), Some(session_id)) = (&self.client_connection, &self.session_id) {
            (conn.clone(), session_id.clone())
        } else {
            return;
        };

        let lines = self.textarea.lines();
        let text = lines.join("\n");
        if text.trim().is_empty() {
            return;
        }

        self.append_message("User", &text);
        
        // Clear input immediately
        self.textarea = TextArea::default();
        self.textarea.set_block(
            Block::default()
                .borders(Borders::TOP | Borders::BOTTOM)
                .border_style(ratatui::style::Style::default().fg(ratatui::style::Color::DarkGray))
        );
        self.textarea.set_placeholder_text("Type a message and press Enter to send. Ctrl+J for new line.");

        let request = PromptRequest {
            session_id,
            prompt: vec![ContentBlock::Text(TextContent { 
                text, 
                annotations: None, 
                meta: None 
            })],
            meta: None,
        };

        tokio::task::spawn_local(async move {
            // Manually deref if needed, but method syntax should work if trait is in scope.
            // We are using `Agent` trait method `prompt`.
            if let Err(_) = Agent::prompt(&*conn, request).await {
                // Log error
            }
        });
    }
}

// Wrappers for AsyncRead/AsyncWrite
struct TokioCompatRead<T>(T);

impl<T: tokio::io::AsyncRead + Unpin> futures::io::AsyncRead for TokioCompatRead<T> {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut [u8],
    ) -> std::task::Poll<io::Result<usize>> {
        let mut read_buf = tokio::io::ReadBuf::new(buf);
        futures::ready!(std::pin::Pin::new(&mut self.0).poll_read(cx, &mut read_buf))?;
        std::task::Poll::Ready(Ok(read_buf.filled().len()))
    }
}

struct TokioCompatWrite<T>(T);

impl<T: tokio::io::AsyncWrite + Unpin> futures::io::AsyncWrite for TokioCompatWrite<T> {
    fn poll_write(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<io::Result<usize>> {
        std::pin::Pin::new(&mut self.0).poll_write(cx, buf)
    }

    fn poll_flush(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<io::Result<()>> {
        std::pin::Pin::new(&mut self.0).poll_flush(cx)
    }

    fn poll_close(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<io::Result<()>> {
        std::pin::Pin::new(&mut self.0).poll_shutdown(cx)
    }
}

pub async fn run_chat_tui(base_url: String, sandbox_id: String) -> Result<()> {
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen, EnableMouseCapture)?;
    enable_raw_mode()?;
    
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    let local = tokio::task::LocalSet::new();
    let res = local.run_until(run_main_loop(&mut terminal, base_url, sandbox_id)).await;

    disable_raw_mode()?;
    execute!(
        terminal.backend_mut(),
        LeaveAlternateScreen,
        DisableMouseCapture
    )?;
    terminal.show_cursor()?;

    // Surface errors to the user
    match res {
        Ok(_) => Ok(()),
        Err(e) => {
            eprintln!("\n\x1b[31mError: {}\x1b[0m", e);
            // Also try to read the end of the log file to give more context if available
            if let Ok(logs) = std::fs::read_to_string("/tmp/cmux-chat.log") {
                let lines: Vec<&str> = logs.lines().rev().take(5).collect();
                if !lines.is_empty() {
                    eprintln!("\nRecent logs:");
                    for line in lines.iter().rev() {
                        eprintln!("  {}", line);
                    }
                }
            }
            Err(anyhow::anyhow!(e))
        }
    }
}

async fn run_main_loop<B: ratatui::backend::Backend>(terminal: &mut Terminal<B>, base_url: String, sandbox_id: String) -> Result<()> {
    log_debug("Starting run_main_loop");
    let (tx, rx) = mpsc::unbounded_channel();
    
    let ws_url = base_url
        .replace("http://", "ws://")
        .replace("https://", "wss://")
        .trim_end_matches('/')
        .to_string();
        
    // Wrap in stdbuf to ensure unbuffered I/O over pipes
    let command = "/usr/bin/stdbuf -i0 -o0 -e0 /usr/local/bin/codex-acp -c approval_policy=\"never\" -c sandbox_mode=\"danger-full-access\" -c model=\"gpt-5.1-codex-max\"";
    let encoded_command = url::form_urlencoded::byte_serialize(command.as_bytes()).collect::<String>();
    
    let url = format!(
        "{}/sandboxes/{}/attach?cols=80&rows=24&tty=false&command={}",
        ws_url, sandbox_id, encoded_command
    );
    log_debug(&format!("Connecting to: {}", url));

    let (ws_stream, _) = tokio_tungstenite::connect_async(url).await?;
    log_debug("WebSocket connected");
    
    let (write, read) = ws_stream.split();
    
    struct WsRead(futures::stream::SplitStream<tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>>);
    struct WsWrite(futures::stream::SplitSink<tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>, tokio_tungstenite::tungstenite::Message>);

    impl tokio::io::AsyncRead for WsRead {
        fn poll_read(
            mut self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
            buf: &mut tokio::io::ReadBuf<'_>,
        ) -> std::task::Poll<io::Result<()>> {
            loop {
                match futures::ready!(self.0.poll_next_unpin(cx)) {
                    Some(Ok(tokio_tungstenite::tungstenite::Message::Binary(data))) => {
                        // log_debug(&format!("RECV BINARY: {} bytes", data.len()));
                        buf.put_slice(&data);
                        return std::task::Poll::Ready(Ok(()));
                    }
                    Some(Ok(tokio_tungstenite::tungstenite::Message::Text(data))) => {
                        log_debug(&format!("RECV TEXT: {}", data));
                        buf.put_slice(data.as_bytes());
                        return std::task::Poll::Ready(Ok(()));
                    }
                    Some(Ok(tokio_tungstenite::tungstenite::Message::Close(_))) | None => {
                        log_debug("RECV EOF");
                        return std::task::Poll::Ready(Ok(())); // EOF
                    }
                    Some(Err(e)) => {
                        log_debug(&format!("RECV Error: {}", e));
                        return std::task::Poll::Ready(Err(io::Error::new(io::ErrorKind::Other, e)))
                    },
                    _ => continue,
                }
            }
        }
    }

    impl tokio::io::AsyncWrite for WsWrite {
        fn poll_write(
            mut self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
            buf: &[u8],
        ) -> std::task::Poll<io::Result<usize>> {
            log_debug(&format!("SEND: {:?}", String::from_utf8_lossy(buf)));
            match self.0.start_send_unpin(tokio_tungstenite::tungstenite::Message::Binary(buf.to_vec())) {
                Ok(_) => {
                    // Force a flush attempt to ensure the message is pushed to the underlying socket
                    // even if the caller doesn't call flush immediately.
                    match self.0.poll_flush_unpin(cx) {
                        std::task::Poll::Ready(Ok(_)) => log_debug("Auto-flush success"),
                        std::task::Poll::Ready(Err(e)) => log_debug(&format!("Auto-flush error: {}", e)),
                        std::task::Poll::Pending => log_debug("Auto-flush pending"),
                    }
                    std::task::Poll::Ready(Ok(buf.len()))
                },
                Err(e) => std::task::Poll::Ready(Err(io::Error::new(io::ErrorKind::Other, e))),
            }
        }

        fn poll_flush(
            mut self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<io::Result<()>> {
            log_debug("FLUSH");
            self.0.poll_flush_unpin(cx).map_err(|e| io::Error::new(io::ErrorKind::Other, e))
        }

        fn poll_shutdown(
            mut self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<io::Result<()>> {
            self.0.poll_close_unpin(cx).map_err(|e| io::Error::new(io::ErrorKind::Other, e))
        }
    }

    let (client_conn, io_task) = ClientSideConnection::new(
        Arc::new(AppClient { tx: tx.clone() }),
        TokioCompatWrite(WsWrite(write)),
        TokioCompatRead(WsRead(read)),
        Box::new(|fut| {
            tokio::task::spawn_local(fut);
        }),
    );
    let client_conn = Arc::new(client_conn);

    tokio::task::spawn_local(async move {
        if let Err(e) = io_task.await {
             log_debug(&format!("IO Task Error: {}", e));
        } else {
             log_debug("IO Task Finished");
        }
    });

    log_debug("Sending Initialize...");
    client_conn.initialize(InitializeRequest {
        protocol_version: V1,
        client_capabilities: ClientCapabilities {
            fs: FileSystemCapability {
                read_text_file: true,
                write_text_file: true,
                meta: None,
            },
            terminal: false,
            meta: None,
        },
        client_info: None,
        meta: None,
    }).await?;
    log_debug("Initialize complete");

    log_debug("Starting New Session...");
    let new_session_res = client_conn.new_session(NewSessionRequest {
        cwd: std::path::PathBuf::from("/workspace"),
        mcp_servers: vec![],
        meta: None,
    }).await?;
    log_debug("New Session started");

    let mut app = App::new();
    app.client_connection = Some(client_conn);
    app.session_id = Some(new_session_res.session_id);

    log_debug("Running App UI loop...");
    run_app(terminal, app, rx).await?;
    log_debug("App UI loop finished");
    
    Ok(())
}

async fn run_app<B: ratatui::backend::Backend>(
    terminal: &mut Terminal<B>,
    mut app: App<'_>,
    mut rx: mpsc::UnboundedReceiver<AppEvent>,
) -> io::Result<()> {
    let mut reader = EventStream::new();

    loop {
        terminal.draw(|f| ui(f, &app))?;

        tokio::select! {
            Some(event) = rx.recv() => {
                match event {
                    AppEvent::SessionUpdate(notification) => app.on_session_update(notification),
                    AppEvent::Error(msg) => app.history.push(format!("Error: {}", msg)),
                }
            }
            Some(Ok(event)) = reader.next() => {
                // log_debug(&format!("Event: {:?}", event));
                if let Event::Key(key) = event {
                     if key.modifiers.contains(KeyModifiers::CONTROL) {
                         match key.code {
                            KeyCode::Char('q') | KeyCode::Char('c') | KeyCode::Char('d') => return Ok(()),
                            KeyCode::Char('j') => { app.textarea.insert_newline(); },
                            _ => { app.textarea.input(key); }
                        }
                    } else if key.code == KeyCode::Enter {
                        app.send_message().await;
                    } else {
                        app.textarea.input(key);
                    }
                }
            }
        }
    }
}

fn ui(f: &mut ratatui::Frame, app: &App) {
    // Calculate dynamic height based on line count
    // +2 accounts for top and bottom borders
    // Clamp between 3 (1 line) and 12 (10 lines)
    let line_count = app.textarea.lines().len() as u16;
    let input_height = (line_count + 2).clamp(3, 12);

    let chunks = Layout::default() 
        .direction(Direction::Vertical)
        .constraints(
            [
                Constraint::Min(1),
                Constraint::Length(input_height),
            ]
            .as_ref(),
        )
        .split(f.area());

    let history_text = app.history.join("\n");
    let history_paragraph = Paragraph::new(history_text)
        .wrap(Wrap { trim: true });
    f.render_widget(history_paragraph, chunks[0]);

    f.render_widget(&app.textarea, chunks[1]);
}