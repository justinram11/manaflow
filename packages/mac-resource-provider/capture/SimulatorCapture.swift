#!/usr/bin/env swift
//
// SimulatorCapture.swift
// Captures the iOS Simulator window using ScreenCaptureKit and serves it
// as a minimal RFB (VNC) server for noVNC consumption.
//
// Usage: swift SimulatorCapture.swift --udid <SIMULATOR_UDID> --port <PORT> [--fps <FPS>]
//
// Requirements: macOS 14+, ScreenCaptureKit framework

import Foundation
import CoreGraphics

// MARK: - Argument Parsing

struct Config {
    let simulatorUdid: String
    let port: UInt16
    let fps: Int

    static func parse() -> Config {
        let args = CommandLine.arguments
        var udid = ""
        var port: UInt16 = 5900
        var fps = 30

        var i = 1
        while i < args.count {
            switch args[i] {
            case "--udid":
                i += 1
                if i < args.count { udid = args[i] }
            case "--port":
                i += 1
                if i < args.count { port = UInt16(args[i]) ?? 5900 }
            case "--fps":
                i += 1
                if i < args.count { fps = Int(args[i]) ?? 30 }
            default:
                break
            }
            i += 1
        }

        guard !udid.isEmpty else {
            fputs("Error: --udid is required\n", stderr)
            exit(1)
        }

        return Config(simulatorUdid: udid, port: port, fps: fps)
    }
}

// MARK: - Simulator Window Finder

/// Finds the Simulator.app window for the given UDID by matching the window title.
func findSimulatorWindowId(udid: String) -> CGWindowID? {
    // Get the PID of the Simulator process that has this UDID
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
    task.arguments = ["simctl", "list", "devices", "-j", "booted"]
    let pipe = Pipe()
    task.standardOutput = pipe
    task.standardError = FileHandle.nullDevice
    try? task.run()
    task.waitUntilExit()

    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let devices = json["devices"] as? [String: [[String: Any]]] else {
        return nil
    }

    // Find the device name for this UDID
    var deviceName: String?
    for (_, deviceList) in devices {
        for device in deviceList {
            if let deviceUdid = device["udid"] as? String, deviceUdid == udid {
                deviceName = device["name"] as? String
                break
            }
        }
        if deviceName != nil { break }
    }

    guard let name = deviceName else {
        fputs("Warning: Could not find device name for UDID \(udid)\n", stderr)
        return nil
    }

    // Find the window matching this simulator name
    guard let windowList = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else {
        return nil
    }

    for window in windowList {
        guard let ownerName = window[kCGWindowOwnerName as String] as? String,
              ownerName == "Simulator",
              let windowName = window[kCGWindowName as String] as? String,
              windowName.contains(name),
              let windowId = window[kCGWindowNumber as String] as? CGWindowID else {
            continue
        }
        return windowId
    }

    return nil
}

// MARK: - Minimal RFB Server

/// A minimal RFB (VNC) server that captures the simulator window
/// and sends raw pixel updates to connected clients.
class RfbServer {
    let config: Config
    let serverSocket: Int32
    var clientSocket: Int32 = -1
    var running = true
    var windowId: CGWindowID?
    var lastWidth: Int = 0
    var lastHeight: Int = 0

    init(config: Config) {
        self.config = config

        // Create server socket
        serverSocket = socket(AF_INET, SOCK_STREAM, 0)
        guard serverSocket >= 0 else {
            fputs("Failed to create socket\n", stderr)
            exit(1)
        }

        var reuse: Int32 = 1
        setsockopt(serverSocket, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout<Int32>.size))

        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = config.port.bigEndian
        addr.sin_addr.s_addr = INADDR_ANY.bigEndian

        let bindResult = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
                bind(serverSocket, sockPtr, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }

        guard bindResult == 0 else {
            fputs("Failed to bind to port \(config.port): \(String(cString: strerror(errno)))\n", stderr)
            exit(1)
        }

        listen(serverSocket, 1)
        fputs("RFB server listening on port \(config.port)\n", stderr)
    }

    func run() {
        while running {
            // Wait for the simulator window
            while windowId == nil && running {
                windowId = findSimulatorWindowId(udid: config.simulatorUdid)
                if windowId == nil {
                    fputs("Waiting for simulator window...\n", stderr)
                    Thread.sleep(forTimeInterval: 1.0)
                }
            }

            guard running else { break }
            fputs("Found simulator window ID: \(windowId!)\n", stderr)

            // Accept client connection
            fputs("Waiting for VNC client connection...\n", stderr)
            var clientAddr = sockaddr_in()
            var clientAddrLen = socklen_t(MemoryLayout<sockaddr_in>.size)
            clientSocket = withUnsafeMutablePointer(to: &clientAddr) { ptr in
                ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
                    accept(serverSocket, sockPtr, &clientAddrLen)
                }
            }

            guard clientSocket >= 0 else {
                fputs("Accept failed\n", stderr)
                continue
            }

            // Disable Nagle for low latency
            var nodelay: Int32 = 1
            setsockopt(clientSocket, IPPROTO_TCP, TCP_NODELAY, &nodelay, socklen_t(MemoryLayout<Int32>.size))

            fputs("VNC client connected\n", stderr)

            // RFB handshake
            if !performHandshake() {
                close(clientSocket)
                clientSocket = -1
                continue
            }

            // Send framebuffer updates
            streamFrames()

            close(clientSocket)
            clientSocket = -1
            fputs("VNC client disconnected\n", stderr)
        }

        close(serverSocket)
    }

    func performHandshake() -> Bool {
        // Protocol version
        let version = "RFB 003.008\n"
        send(clientSocket, version, version.utf8.count, 0)

        // Read client version
        var clientVersion = [UInt8](repeating: 0, count: 12)
        let read = recv(clientSocket, &clientVersion, 12, 0)
        guard read == 12 else { return false }

        // Security type: None (1)
        var secTypes: [UInt8] = [1, 1] // count=1, type=1 (None)
        send(clientSocket, &secTypes, 2, 0)

        // Read client security selection
        var selectedSec: UInt8 = 0
        recv(clientSocket, &selectedSec, 1, 0)

        // Security result: OK (0)
        var secResult: UInt32 = 0
        send(clientSocket, &secResult, 4, 0)

        // Read client init (shared flag)
        var shared: UInt8 = 0
        recv(clientSocket, &shared, 1, 0)

        // Capture initial frame to get dimensions
        guard let image = captureFrame() else { return false }
        let width = image.width
        let height = image.height
        lastWidth = width
        lastHeight = height

        // Server init
        var serverInit = Data()
        serverInit.append(UInt16(width).bigEndianData)
        serverInit.append(UInt16(height).bigEndianData)

        // Pixel format: 32-bit BGRA
        serverInit.append(contentsOf: [
            32,  // bits-per-pixel
            24,  // depth
            0,   // big-endian-flag
            1,   // true-colour-flag
        ])
        serverInit.append(UInt16(255).bigEndianData) // red-max
        serverInit.append(UInt16(255).bigEndianData) // green-max
        serverInit.append(UInt16(255).bigEndianData) // blue-max
        serverInit.append(contentsOf: [
            16, 8, 0,  // red/green/blue shift
            0, 0, 0,   // padding
        ])

        // Name
        let name = "iOS Simulator"
        serverInit.append(UInt32(name.utf8.count).bigEndianData)
        serverInit.append(contentsOf: name.utf8)

        serverInit.withUnsafeBytes { ptr in
            _ = send(clientSocket, ptr.baseAddress!, ptr.count, 0)
        }

        return true
    }

    func captureFrame() -> CGImage? {
        guard let wid = windowId else { return nil }
        return CGWindowListCreateImage(
            .null,
            .optionIncludingWindow,
            wid,
            [.bestResolution, .boundsIgnoreFraming]
        )
    }

    func streamFrames() {
        let interval = 1.0 / Double(config.fps)

        while running && clientSocket >= 0 {
            // Read any client messages (non-blocking)
            var buf = [UInt8](repeating: 0, count: 256)
            let flags: Int32 = 0x40 // MSG_DONTWAIT
            while recv(clientSocket, &buf, buf.count, flags) > 0 {
                // Consume client messages (FramebufferUpdateRequest, KeyEvent, PointerEvent, etc.)
            }

            guard let image = captureFrame() else {
                Thread.sleep(forTimeInterval: interval)
                continue
            }

            let width = image.width
            let height = image.height

            // Get raw pixel data
            guard let dataProvider = image.dataProvider,
                  let pixelData = dataProvider.data else {
                Thread.sleep(forTimeInterval: interval)
                continue
            }

            let data = pixelData as Data

            // Send FramebufferUpdate (type 0)
            var update = Data()
            update.append(0) // message-type
            update.append(0) // padding
            update.append(UInt16(1).bigEndianData) // number-of-rectangles

            // Rectangle header
            update.append(UInt16(0).bigEndianData) // x-position
            update.append(UInt16(0).bigEndianData) // y-position
            update.append(UInt16(width).bigEndianData) // width
            update.append(UInt16(height).bigEndianData) // height
            update.append(Int32(0).bigEndianData) // encoding-type: Raw (0)

            // Send header
            let headerSent = update.withUnsafeBytes { ptr -> Int in
                send(clientSocket, ptr.baseAddress!, ptr.count, 0)
            }
            guard headerSent > 0 else { break }

            // Send pixel data
            let pixelsSent = data.withUnsafeBytes { ptr -> Int in
                send(clientSocket, ptr.baseAddress!, min(ptr.count, width * height * 4), 0)
            }
            guard pixelsSent > 0 else { break }

            Thread.sleep(forTimeInterval: interval)
        }
    }

    func stop() {
        running = false
        if clientSocket >= 0 { close(clientSocket) }
        close(serverSocket)
    }
}

// MARK: - Data Extensions

extension UInt16 {
    var bigEndianData: Data {
        var value = self.bigEndian
        return Data(bytes: &value, count: 2)
    }
}

extension UInt32 {
    var bigEndianData: Data {
        var value = self.bigEndian
        return Data(bytes: &value, count: 4)
    }
}

extension Int32 {
    var bigEndianData: Data {
        var value = self.bigEndian
        return Data(bytes: &value, count: 4)
    }
}

// MARK: - Main

let config = Config.parse()
let server = RfbServer(config: config)

// Handle SIGTERM/SIGINT
signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)
let termSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
let intSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
termSource.setEventHandler { server.stop() }
intSource.setEventHandler { server.stop() }
termSource.resume()
intSource.resume()

server.run()
