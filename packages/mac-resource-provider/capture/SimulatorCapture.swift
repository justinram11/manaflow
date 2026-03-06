#!/usr/bin/env swift
//
// SimulatorCapture.swift
// Captures the iOS Simulator window using ScreenCaptureKit and serves it
// as a minimal RFB (VNC) server for noVNC consumption.
//
// Usage: swift SimulatorCapture.swift --udid <SIMULATOR_UDID> --port <PORT> [--fps <FPS>]

import AppKit
import CoreGraphics
import CoreVideo
import Foundation
import ScreenCaptureKit

struct Config {
    let simulatorUdid: String
    let port: UInt16
    let fps: Int

    static func parse() -> Config {
        let args = CommandLine.arguments
        var udid = ""
        var port: UInt16 = 5900
        var fps = 30

        var index = 1
        while index < args.count {
            switch args[index] {
            case "--udid":
                index += 1
                if index < args.count { udid = args[index] }
            case "--port":
                index += 1
                if index < args.count { port = UInt16(args[index]) ?? 5900 }
            case "--fps":
                index += 1
                if index < args.count { fps = Int(args[index]) ?? 30 }
            default:
                break
            }
            index += 1
        }

        guard !udid.isEmpty else {
            fputs("Error: --udid is required\n", stderr)
            exit(1)
        }

        return Config(simulatorUdid: udid, port: port, fps: fps)
    }
}

struct SimulatorWindowMatch {
    let windowID: CGWindowID
    let title: String
    let bounds: CGRect
}

func ensureScreenCapturePermission() {
    if CGPreflightScreenCaptureAccess() {
        fputs("Screen capture access already granted\n", stderr)
        return
    }

    fputs("Screen capture access not granted; requesting access...\n", stderr)
    let granted = CGRequestScreenCaptureAccess()
    fputs("Screen capture access request result: \(granted)\n", stderr)
}

func getBootedSimulatorCount() -> Int {
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
    task.arguments = ["simctl", "list", "devices", "-j", "booted"]

    let pipe = Pipe()
    task.standardOutput = pipe
    task.standardError = FileHandle.nullDevice

    do {
        try task.run()
    } catch {
        return 0
    }

    task.waitUntilExit()
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    guard
        let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let devices = json["devices"] as? [String: [[String: Any]]]
    else {
        return 0
    }

    return devices.values.reduce(0) { partial, list in
        partial + list.count
    }
}

func getSimulatorDeviceName(udid: String) -> String? {
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
    task.arguments = ["simctl", "list", "devices", "-j"]

    let pipe = Pipe()
    task.standardOutput = pipe
    task.standardError = FileHandle.nullDevice

    do {
        try task.run()
    } catch {
        return nil
    }

    task.waitUntilExit()
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    guard
        let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let devices = json["devices"] as? [String: [[String: Any]]]
    else {
        return nil
    }

    for (_, deviceList) in devices {
        for device in deviceList where device["udid"] as? String == udid {
            return device["name"] as? String
        }
    }

    return nil
}

func findSimulatorWindowMatch(udid: String) -> SimulatorWindowMatch? {
    guard let deviceName = getSimulatorDeviceName(udid: udid) else {
        fputs("Warning: Could not find device name for UDID \(udid)\n", stderr)
        return nil
    }

    guard
        let infoList = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements],
            kCGNullWindowID
        ) as? [[String: Any]]
    else {
        return nil
    }

    let matches = infoList.compactMap { info -> SimulatorWindowMatch? in
        guard
            let owner = info[kCGWindowOwnerName as String] as? String,
            owner == "Simulator",
            let number = info[kCGWindowNumber as String] as? NSNumber,
            let boundsDictionary = info[kCGWindowBounds as String]
        else {
            return nil
        }

        let title = (info[kCGWindowName as String] as? String) ?? ""
        let bounds = CGRect(dictionaryRepresentation: boundsDictionary as! CFDictionary) ?? .zero
        return SimulatorWindowMatch(
            windowID: CGWindowID(number.uint32Value),
            title: title,
            bounds: bounds
        )
    }

    if let exact = matches.first(where: { $0.title == deviceName }) {
        return exact
    }

    if let contains = matches.first(where: { $0.title.contains(deviceName) }) {
        return contains
    }

    if getBootedSimulatorCount() == 1, let fallback = matches.first {
        fputs("Falling back to lone Simulator windowID \(fallback.windowID) for \(udid)\n", stderr)
        return fallback
    }

    return matches.first
}

class RfbServer {
    let config: Config
    let serverSocket: Int32
    var clientSocket: Int32 = -1
    var running = true
    var window: SimulatorWindowMatch?
    var lastWidth = 0
    var lastHeight = 0

    init(config: Config) {
        self.config = config

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
            while window == nil && running {
                window = findSimulatorWindowMatch(udid: config.simulatorUdid)
                if let window {
                    fputs("Found simulator windowID \(window.windowID) for \(config.simulatorUdid)\n", stderr)
                } else {
                    fputs("Waiting for simulator window...\n", stderr)
                    Thread.sleep(forTimeInterval: 1.0)
                }
            }

            guard running else { break }

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

            var nodelay: Int32 = 1
            setsockopt(clientSocket, IPPROTO_TCP, TCP_NODELAY, &nodelay, socklen_t(MemoryLayout<Int32>.size))

            fputs("VNC client connected\n", stderr)

            if !performHandshake() {
                close(clientSocket)
                clientSocket = -1
                continue
            }

            streamFrames()

            close(clientSocket)
            clientSocket = -1
            fputs("VNC client disconnected\n", stderr)
        }

        close(serverSocket)
    }

    func performHandshake() -> Bool {
        let version = "RFB 003.008\n"
        send(clientSocket, version, version.utf8.count, 0)

        var clientVersion = [UInt8](repeating: 0, count: 12)
        let versionRead = recv(clientSocket, &clientVersion, 12, 0)
        guard versionRead == 12 else { return false }

        var secTypes: [UInt8] = [1, 1]
        send(clientSocket, &secTypes, 2, 0)

        var selectedSec: UInt8 = 0
        let secRead = recv(clientSocket, &selectedSec, 1, 0)
        guard secRead == 1 else { return false }

        var secResult: UInt32 = 0
        send(clientSocket, &secResult, 4, 0)

        var shared: UInt8 = 0
        let sharedRead = recv(clientSocket, &shared, 1, 0)
        guard sharedRead == 1 else { return false }

        guard let image = captureFrame() else {
            fputs("Initial capture failed\n", stderr)
            return false
        }
        let width = image.width
        let height = image.height
        lastWidth = width
        lastHeight = height

        var serverInit = Data()
        serverInit.append(UInt16(width).bigEndianData)
        serverInit.append(UInt16(height).bigEndianData)
        serverInit.append(contentsOf: [32, 24, 0, 1])
        serverInit.append(UInt16(255).bigEndianData)
        serverInit.append(UInt16(255).bigEndianData)
        serverInit.append(UInt16(255).bigEndianData)
        serverInit.append(contentsOf: [16, 8, 0, 0, 0, 0])

        let name = "iOS Simulator"
        serverInit.append(UInt32(name.utf8.count).bigEndianData)
        serverInit.append(contentsOf: name.utf8)

        serverInit.withUnsafeBytes { ptr in
            _ = send(clientSocket, ptr.baseAddress!, ptr.count, 0)
        }

        fputs("Sent server init \(width)x\(height)\n", stderr)
        return true
    }

    func captureFrame() -> CGImage? {
        guard let freshWindow = findSimulatorWindowMatch(udid: config.simulatorUdid) else {
            window = nil
            return nil
        }
        window = freshWindow

        let semaphore = DispatchSemaphore(value: 0)
        var image: CGImage?

        if #available(macOS 15.2, *) {
            SCScreenshotManager.captureImage(in: freshWindow.bounds) { capturedImage, error in
                if let error {
                    fputs("ScreenCaptureKit rect capture failed: \(error)\n", stderr)
                }
                image = capturedImage
                semaphore.signal()
            }
        } else {
            fputs("ScreenCaptureKit rect capture requires macOS 15.2+\n", stderr)
            semaphore.signal()
        }

        let waitResult = semaphore.wait(timeout: .now() + 10)
        if waitResult == .timedOut {
            fputs("Timed out waiting for simulator screenshot\n", stderr)
        }
        return image
    }

    func streamFrames() {
        let interval = 1.0 / Double(config.fps)

        while running && clientSocket >= 0 {
            var buf = [UInt8](repeating: 0, count: 256)
            let flags: Int32 = 0x40
            while recv(clientSocket, &buf, buf.count, flags) > 0 {
            }

            guard let image = captureFrame() else {
                Thread.sleep(forTimeInterval: interval)
                continue
            }

            let width = image.width
            let height = image.height
            guard let dataProvider = image.dataProvider,
                  let pixelData = dataProvider.data else {
                Thread.sleep(forTimeInterval: interval)
                continue
            }

            let data = pixelData as Data

            var update = Data()
            update.append(0)
            update.append(0)
            update.append(UInt16(1).bigEndianData)
            update.append(UInt16(0).bigEndianData)
            update.append(UInt16(0).bigEndianData)
            update.append(UInt16(width).bigEndianData)
            update.append(UInt16(height).bigEndianData)
            update.append(Int32(0).bigEndianData)

            let headerSent = update.withUnsafeBytes { ptr -> Int in
                send(clientSocket, ptr.baseAddress!, ptr.count, 0)
            }
            guard headerSent > 0 else { break }

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

let config = Config.parse()
ensureScreenCapturePermission()
let server = RfbServer(config: config)

signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)
let termSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
let intSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
termSource.setEventHandler { server.stop() }
intSource.setEventHandler { server.stop() }
termSource.resume()
intSource.resume()

server.run()
