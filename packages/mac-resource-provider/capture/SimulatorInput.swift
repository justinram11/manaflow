#!/usr/bin/env swift

import AppKit
import ApplicationServices
import Foundation

struct Config {
    let simulatorUdid: String
    let action: String
    let x: Double?
    let y: Double?
    let fromX: Double?
    let fromY: Double?
    let toX: Double?
    let toY: Double?
    let duration: Double
    let text: String?
    let button: String?

    static func parse() -> Config {
        let args = CommandLine.arguments
        var values = [String: String]()
        var index = 1

        while index < args.count {
            let arg = args[index]
            if arg.hasPrefix("--"), index + 1 < args.count {
                values[String(arg.dropFirst(2))] = args[index + 1]
                index += 2
                continue
            }
            index += 1
        }

        guard let simulatorUdid = values["udid"], !simulatorUdid.isEmpty else {
            fputs("Missing --udid\n", stderr)
            exit(1)
        }
        guard let action = values["action"], !action.isEmpty else {
            fputs("Missing --action\n", stderr)
            exit(1)
        }

        return Config(
            simulatorUdid: simulatorUdid,
            action: action,
            x: values["x"].flatMap(Double.init),
            y: values["y"].flatMap(Double.init),
            fromX: values["from-x"].flatMap(Double.init),
            fromY: values["from-y"].flatMap(Double.init),
            toX: values["to-x"].flatMap(Double.init),
            toY: values["to-y"].flatMap(Double.init),
            duration: values["duration"].flatMap(Double.init) ?? 0.3,
            text: values["text"],
            button: values["button"]
        )
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

func findSimulatorWindowFrame(udid: String) -> CGRect? {
    guard let deviceName = getSimulatorDeviceName(udid: udid) else {
        return nil
    }

    guard
        let infoList = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
            as? [[String: Any]]
    else {
        return nil
    }

    for info in infoList {
        guard
            let owner = info[kCGWindowOwnerName as String] as? String,
            owner == "Simulator",
            let title = info[kCGWindowName as String] as? String,
            title.contains(deviceName),
            let bounds = info[kCGWindowBounds as String] as? [String: CGFloat]
        else {
            continue
        }

        let frame = CGRect(
            x: bounds["X"] ?? 0,
            y: bounds["Y"] ?? 0,
            width: bounds["Width"] ?? 0,
            height: bounds["Height"] ?? 0
        )
        if frame.width > 0, frame.height > 0 {
            return frame
        }
    }

    return nil
}

func findScreen(for frame: CGRect) -> NSScreen? {
    let midpoint = CGPoint(x: frame.midX, y: frame.midY)
    return NSScreen.screens.first(where: { $0.frame.contains(midpoint) }) ?? NSScreen.main
}

func activateSimulator() {
    let apps = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.iphonesimulator")
    guard let app = apps.first else { return }
    app.activate(options: [.activateIgnoringOtherApps])
    Thread.sleep(forTimeInterval: 0.15)
}

func eventPoint(fromPixel pixelX: Double, pixelY: Double, frame: CGRect) -> CGPoint {
    let screen = findScreen(for: frame)
    let scale = screen?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2.0

    let globalX = frame.origin.x + CGFloat(pixelX / scale)
    let globalYFromTop = frame.origin.y + CGFloat(pixelY / scale)

    if let screen {
        let globalY = screen.frame.maxY - globalYFromTop
        return CGPoint(x: globalX, y: globalY)
    }

    return CGPoint(x: globalX, y: globalYFromTop)
}

func postMouseEvent(type: CGEventType, point: CGPoint, button: CGMouseButton = .left) throws {
    guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: button) else {
        throw NSError(domain: "SimulatorInput", code: 1, userInfo: [NSLocalizedDescriptionKey: "Failed to create mouse event"])
    }
    event.post(tap: .cghidEventTap)
}

func postClick(at point: CGPoint) throws {
    try postMouseEvent(type: .mouseMoved, point: point)
    usleep(8_000)
    try postMouseEvent(type: .leftMouseDown, point: point)
    usleep(12_000)
    try postMouseEvent(type: .leftMouseUp, point: point)
}

func postSwipe(from start: CGPoint, to end: CGPoint, duration: Double) throws {
    let steps = max(Int(duration * 60), 6)
    try postMouseEvent(type: .mouseMoved, point: start)
    usleep(8_000)
    try postMouseEvent(type: .leftMouseDown, point: start)

    for step in 1...steps {
        let progress = Double(step) / Double(steps)
        let point = CGPoint(
            x: start.x + (end.x - start.x) * progress,
            y: start.y + (end.y - start.y) * progress
        )
        try postMouseEvent(type: .leftMouseDragged, point: point)
        usleep(useconds_t((duration / Double(steps)) * 1_000_000))
    }

    try postMouseEvent(type: .leftMouseUp, point: end)
}

func postKey(keyCode: CGKeyCode, keyDown: Bool, flags: CGEventFlags = []) throws {
    guard let event = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: keyDown) else {
        throw NSError(domain: "SimulatorInput", code: 2, userInfo: [NSLocalizedDescriptionKey: "Failed to create key event"])
    }
    event.flags = flags
    event.post(tap: .cghidEventTap)
}

func typeText(_ text: String) throws {
    let pasteboard = NSPasteboard.general
    pasteboard.clearContents()
    pasteboard.setString(text, forType: .string)
    try postKey(keyCode: 0x37, keyDown: true) // Command
    try postKey(keyCode: 0x09, keyDown: true, flags: .maskCommand) // V
    try postKey(keyCode: 0x09, keyDown: false, flags: .maskCommand)
    try postKey(keyCode: 0x37, keyDown: false)
}

func pressButton(_ button: String) throws {
    switch button {
    case "home":
        try postKey(keyCode: 0x37, keyDown: true) // Command
        try postKey(keyCode: 0x38, keyDown: true, flags: [.maskCommand, .maskShift]) // Shift
        try postKey(keyCode: 0x04, keyDown: true, flags: [.maskCommand, .maskShift]) // H
        try postKey(keyCode: 0x04, keyDown: false, flags: [.maskCommand, .maskShift])
        try postKey(keyCode: 0x38, keyDown: false, flags: .maskCommand)
        try postKey(keyCode: 0x37, keyDown: false)
    case "lock":
        try postKey(keyCode: 0x37, keyDown: true) // Command
        try postKey(keyCode: 0x25, keyDown: true, flags: .maskCommand) // L
        try postKey(keyCode: 0x25, keyDown: false, flags: .maskCommand)
        try postKey(keyCode: 0x37, keyDown: false)
    default:
        throw NSError(domain: "SimulatorInput", code: 3, userInfo: [NSLocalizedDescriptionKey: "Unsupported button \(button)"])
    }
}

func printJson(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted]) else {
        print("{\"success\":false}")
        return
    }
    print(String(decoding: data, as: UTF8.self))
}

let config = Config.parse()

do {
    activateSimulator()

    switch config.action {
    case "tap":
        guard let x = config.x, let y = config.y, let frame = findSimulatorWindowFrame(udid: config.simulatorUdid) else {
            throw NSError(domain: "SimulatorInput", code: 4, userInfo: [NSLocalizedDescriptionKey: "Missing tap coordinates or simulator window"])
        }
        try postClick(at: eventPoint(fromPixel: x, pixelY: y, frame: frame))
        printJson(["success": true, "action": "tap"])
    case "swipe":
        guard
            let fromX = config.fromX,
            let fromY = config.fromY,
            let toX = config.toX,
            let toY = config.toY,
            let frame = findSimulatorWindowFrame(udid: config.simulatorUdid)
        else {
            throw NSError(domain: "SimulatorInput", code: 5, userInfo: [NSLocalizedDescriptionKey: "Missing swipe coordinates or simulator window"])
        }
        try postSwipe(
            from: eventPoint(fromPixel: fromX, pixelY: fromY, frame: frame),
            to: eventPoint(fromPixel: toX, pixelY: toY, frame: frame),
            duration: config.duration
        )
        printJson(["success": true, "action": "swipe"])
    case "type":
        guard let text = config.text else {
            throw NSError(domain: "SimulatorInput", code: 6, userInfo: [NSLocalizedDescriptionKey: "Missing text"])
        }
        try typeText(text)
        printJson(["success": true, "action": "type"])
    case "button":
        guard let button = config.button else {
            throw NSError(domain: "SimulatorInput", code: 7, userInfo: [NSLocalizedDescriptionKey: "Missing button"])
        }
        try pressButton(button)
        printJson(["success": true, "action": "button", "button": button])
    default:
        throw NSError(domain: "SimulatorInput", code: 8, userInfo: [NSLocalizedDescriptionKey: "Unsupported action \(config.action)"])
    }
} catch {
    printJson([
        "error": error.localizedDescription,
        "success": false,
    ])
    exit(1)
}
