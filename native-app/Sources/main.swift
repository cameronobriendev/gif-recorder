import Foundation
import CoreGraphics
import AppKit
import ScreenCaptureKit
import AVFoundation

// MARK: - Logging

func log(_ message: String) {
    let logFile = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Downloads/gifrecorder.log")
    let timestamp = ISO8601DateFormatter().string(from: Date())
    let logMessage = "[\(timestamp)] \(message)\n"

    if let data = logMessage.data(using: .utf8) {
        if FileManager.default.fileExists(atPath: logFile.path) {
            if let handle = try? FileHandle(forWritingTo: logFile) {
                handle.seekToEndOfFile()
                handle.write(data)
                handle.closeFile()
            }
        } else {
            try? data.write(to: logFile)
        }
    }
}

// MARK: - Message Types

struct IncomingMessage: Codable {
    let command: String
    let options: RecordingOptions?

    struct RecordingOptions: Codable {
        let fps: Int?
        let width: Int?
        let quality: String?
        let viewport: ViewportInfo?
    }

    struct ViewportInfo: Codable {
        let innerWidth: Int
        let innerHeight: Int
        let screenX: Int
        let screenY: Int
        let outerWidth: Int
        let outerHeight: Int
        let devicePixelRatio: Double
    }
}

struct OutgoingMessage: Codable {
    let status: String
    let progress: Int?
    let filepath: String?
    let error: String?
}

// MARK: - Native Messaging Protocol

class NativeMessaging {
    func readMessage() -> IncomingMessage? {
        // Read 4-byte length header (little-endian)
        var lengthBytes = [UInt8](repeating: 0, count: 4)
        let bytesRead = read(STDIN_FILENO, &lengthBytes, 4)

        guard bytesRead == 4 else {
            return nil
        }

        let length = UInt32(lengthBytes[0]) |
                     (UInt32(lengthBytes[1]) << 8) |
                     (UInt32(lengthBytes[2]) << 16) |
                     (UInt32(lengthBytes[3]) << 24)

        guard length > 0 && length < 1024 * 1024 else {
            return nil
        }

        // Read JSON message
        var messageBytes = [UInt8](repeating: 0, count: Int(length))
        let messageRead = read(STDIN_FILENO, &messageBytes, Int(length))

        guard messageRead == Int(length) else {
            return nil
        }

        let messageData = Data(messageBytes)
        return try? JSONDecoder().decode(IncomingMessage.self, from: messageData)
    }

    func sendMessage(_ message: OutgoingMessage) {
        guard let jsonData = try? JSONEncoder().encode(message) else { return }

        // Send 4-byte length header (little-endian)
        let length = UInt32(jsonData.count)
        var lengthBytes = [UInt8](repeating: 0, count: 4)
        lengthBytes[0] = UInt8(length & 0xFF)
        lengthBytes[1] = UInt8((length >> 8) & 0xFF)
        lengthBytes[2] = UInt8((length >> 16) & 0xFF)
        lengthBytes[3] = UInt8((length >> 24) & 0xFF)

        _ = write(STDOUT_FILENO, &lengthBytes, 4)

        // Send JSON message
        _ = jsonData.withUnsafeBytes { ptr in
            write(STDOUT_FILENO, ptr.baseAddress!, jsonData.count)
        }
    }
}

// MARK: - Server Communication

struct ConvertResponse: Codable {
    let jobId: String
    let status: String
    let message: String?
}

struct StatusResponse: Codable {
    let jobId: String
    let status: String
    let progress: Int
    let error: String?
}

// MARK: - Stream Output Handler

class StreamOutput: NSObject, SCStreamOutput {
    let assetWriter: AVAssetWriter
    let videoInput: AVAssetWriterInput
    let pixelBufferAdaptor: AVAssetWriterInputPixelBufferAdaptor
    var isFirstFrame = true
    var startTime: CMTime?

    init(assetWriter: AVAssetWriter, videoInput: AVAssetWriterInput) {
        self.assetWriter = assetWriter
        self.videoInput = videoInput
        self.pixelBufferAdaptor = AVAssetWriterInputPixelBufferAdaptor(
            assetWriterInput: videoInput,
            sourcePixelBufferAttributes: [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA
            ]
        )
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen else { return }
        guard sampleBuffer.isValid else { return }
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }

        let presentationTime = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)

        if isFirstFrame {
            startTime = presentationTime
            assetWriter.startSession(atSourceTime: startTime!)
            isFirstFrame = false
        }

        if videoInput.isReadyForMoreMediaData {
            pixelBufferAdaptor.append(pixelBuffer, withPresentationTime: presentationTime)
        }
    }
}

// MARK: - Recorder Controller

class RecorderController {
    private var stream: SCStream?
    private var streamOutput: StreamOutput?
    private var assetWriter: AVAssetWriter?
    private var videoInput: AVAssetWriterInput?
    private let messaging = NativeMessaging()
    private var currentRecordingURL: URL?
    private var currentOptions: IncomingMessage.RecordingOptions?
    private let serverURL = "http://143.110.154.10:3005"

    func start() {
        while let message = messaging.readMessage() {
            handleCommand(message)
        }
    }

    private func handleCommand(_ message: IncomingMessage) {
        switch message.command {
        case "start":
            startRecording(options: message.options)
        case "stop":
            currentOptions = message.options
            stopRecording()
        case "ping":
            messaging.sendMessage(OutgoingMessage(status: "pong", progress: nil, filepath: nil, error: nil))
        default:
            messaging.sendMessage(OutgoingMessage(status: "error", progress: nil, filepath: nil, error: "Unknown command: \(message.command)"))
        }
    }

    private func startRecording(options: IncomingMessage.RecordingOptions?) {
        currentOptions = options
        log("startRecording called")

        Task {
            do {
                log("Getting shareable content...")
                // Get available content
                let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
                log("Got \(content.windows.count) windows")

                // Chromium-based browsers
                let chromiumBrowsers = [
                    "com.google.Chrome",
                    "com.google.Chrome.canary",
                    "company.thebrowser.Browser",  // Arc
                    "com.brave.Browser",
                    "com.microsoft.edgemac",
                    "org.chromium.Chromium",
                    "com.vivaldi.Vivaldi",
                    "com.operasoftware.Opera"
                ]

                // Log all window bundle IDs for debugging
                for window in content.windows {
                    if let bundleId = window.owningApplication?.bundleIdentifier {
                        log("Window: \(bundleId) - \(window.frame.width)x\(window.frame.height)")
                    }
                }

                // Find browser window - prefer largest
                let browserWindows = content.windows.filter { window in
                    guard let bundleId = window.owningApplication?.bundleIdentifier else { return false }
                    return chromiumBrowsers.contains(bundleId) &&
                           window.frame.width > 100 && window.frame.height > 100
                }.sorted { $0.frame.width * $0.frame.height > $1.frame.width * $1.frame.height }

                log("Found \(browserWindows.count) browser windows")

                guard let chromeWindow = browserWindows.first else {
                    log("ERROR: No browser window found")
                    messaging.sendMessage(OutgoingMessage(
                        status: "error",
                        progress: nil,
                        filepath: nil,
                        error: "No browser window found. Make sure your browser is open."
                    ))
                    return
                }

                log("Selected window: \(chromeWindow.owningApplication?.bundleIdentifier ?? "unknown") - \(chromeWindow.frame)")

                // Create temporary file for mp4
                let tempDir = FileManager.default.temporaryDirectory
                let timestamp = Int(Date().timeIntervalSince1970)
                let mp4URL = tempDir.appendingPathComponent("recording-\(timestamp).mp4")
                currentRecordingURL = mp4URL
                log("Created temp file: \(mp4URL.path)")

                // Set up asset writer
                assetWriter = try AVAssetWriter(url: mp4URL, fileType: .mp4)
                log("Created asset writer")

                let fps = options?.fps ?? 30

                // Get window dimensions - make even for video encoding
                let windowWidth = (Int(chromeWindow.frame.width) / 2) * 2
                let windowHeight = (Int(chromeWindow.frame.height) / 2) * 2
                log("Dimensions: \(windowWidth)x\(windowHeight)")

                let videoSettings: [String: Any] = [
                    AVVideoCodecKey: AVVideoCodecType.h264,
                    AVVideoWidthKey: windowWidth,
                    AVVideoHeightKey: windowHeight
                ]

                videoInput = AVAssetWriterInput(mediaType: .video, outputSettings: videoSettings)
                videoInput!.expectsMediaDataInRealTime = true
                assetWriter!.add(videoInput!)
                log("Created video input")

                // Find display containing the window
                let windowCenterX = chromeWindow.frame.midX
                let windowCenterY = chromeWindow.frame.midY

                guard let display = content.displays.first(where: { display in
                    display.frame.contains(CGPoint(x: windowCenterX, y: windowCenterY))
                }) ?? content.displays.first else {
                    log("ERROR: No display found")
                    messaging.sendMessage(OutgoingMessage(
                        status: "error",
                        progress: nil,
                        filepath: nil,
                        error: "Could not find display"
                    ))
                    return
                }
                log("Found display: \(display.frame)")

                // Calculate window position relative to display
                let windowFrame = chromeWindow.frame
                let displayFrame = display.frame

                // sourceRect is in display coordinates
                let sourceRect = CGRect(
                    x: windowFrame.origin.x - displayFrame.origin.x,
                    y: windowFrame.origin.y - displayFrame.origin.y,
                    width: windowFrame.width,
                    height: windowFrame.height
                )
                log("Source rect: \(sourceRect)")

                // Create stream configuration
                let config = SCStreamConfiguration()
                config.width = windowWidth
                config.height = windowHeight
                config.sourceRect = sourceRect
                config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
                config.showsCursor = true
                config.pixelFormat = kCVPixelFormatType_32BGRA
                log("Created stream config")

                // Create content filter for display, excluding all windows except browser
                let excludedWindows = content.windows.filter { $0.windowID != chromeWindow.windowID }
                let filter = SCContentFilter(display: display, excludingWindows: excludedWindows)
                log("Created content filter")

                // Create stream
                stream = SCStream(filter: filter, configuration: config, delegate: nil)
                log("Created stream")

                // Set up output handler
                streamOutput = StreamOutput(assetWriter: assetWriter!, videoInput: videoInput!)
                log("Created stream output")

                try stream!.addStreamOutput(streamOutput!, type: .screen, sampleHandlerQueue: DispatchQueue(label: "com.cameron.gifrecorder.capture"))
                log("Added stream output")

                // Start writing
                assetWriter!.startWriting()
                log("Started writing")

                // Start capture
                try await stream!.startCapture()
                log("Started capture")

                messaging.sendMessage(OutgoingMessage(
                    status: "recording_started",
                    progress: nil,
                    filepath: nil,
                    error: nil
                ))

            } catch {
                log("ERROR: \(error.localizedDescription)")
                messaging.sendMessage(OutgoingMessage(
                    status: "error",
                    progress: nil,
                    filepath: nil,
                    error: "Start recording failed: \(error.localizedDescription)"
                ))
            }
        }
    }

    private func stopRecording() {
        Task {
            do {
                // Stop capture
                try await stream?.stopCapture()
                stream = nil

                // Finish writing
                videoInput?.markAsFinished()
                await assetWriter?.finishWriting()

                // Process the recording
                processRecording()

            } catch {
                messaging.sendMessage(OutgoingMessage(
                    status: "error",
                    progress: nil,
                    filepath: nil,
                    error: "Stop recording failed: \(error.localizedDescription)"
                ))
            }
        }
    }

    private func processRecording() {
        guard let mp4URL = currentRecordingURL else {
            messaging.sendMessage(OutgoingMessage(
                status: "error",
                progress: nil,
                filepath: nil,
                error: "No active recording"
            ))
            return
        }

        // Notify that we're uploading
        messaging.sendMessage(OutgoingMessage(
            status: "uploading",
            progress: 0,
            filepath: nil,
            error: nil
        ))

        // Do upload/poll/download in background
        Task {
            do {
                // Upload to server and get jobId
                let jobId = try await uploadVideo(mp4URL: mp4URL, options: currentOptions)

                // Poll for completion
                let gifData = try await pollAndDownload(jobId: jobId)

                // Save to Downloads
                let downloadsURL = FileManager.default.homeDirectoryForCurrentUser
                    .appendingPathComponent("Downloads")

                // Generate filename with timestamp
                let dateFormatter = DateFormatter()
                dateFormatter.dateFormat = "MMMd-yyyy-hmma"
                let dateString = dateFormatter.string(from: Date())
                let gifPath = downloadsURL.appendingPathComponent("recording_\(dateString).gif")

                try gifData.write(to: gifPath)

                // Clean up temporary mp4
                try? FileManager.default.removeItem(at: mp4URL)
                currentRecordingURL = nil

                messaging.sendMessage(OutgoingMessage(
                    status: "complete",
                    progress: 100,
                    filepath: gifPath.path,
                    error: nil
                ))

            } catch {
                messaging.sendMessage(OutgoingMessage(
                    status: "error",
                    progress: nil,
                    filepath: nil,
                    error: "Processing failed: \(error.localizedDescription)"
                ))
            }
        }
    }

    private func uploadVideo(mp4URL: URL, options: IncomingMessage.RecordingOptions?) async throws -> String {
        // Read mp4 data
        let mp4Data = try Data(contentsOf: mp4URL)

        // Create multipart form data
        let boundary = UUID().uuidString
        var body = Data()

        // Video file
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"video\"; filename=\"recording.mp4\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: video/mp4\r\n\r\n".data(using: .utf8)!)
        body.append(mp4Data)
        body.append("\r\n".data(using: .utf8)!)

        // FPS parameter
        let fps = options?.fps ?? 10
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"fps\"\r\n\r\n".data(using: .utf8)!)
        body.append("\(fps)\r\n".data(using: .utf8)!)

        // Width parameter
        let width = options?.width ?? 720
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"width\"\r\n\r\n".data(using: .utf8)!)
        body.append("\(width)\r\n".data(using: .utf8)!)

        // Quality parameter
        let quality = options?.quality ?? "medium"
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"quality\"\r\n\r\n".data(using: .utf8)!)
        body.append("\(quality)\r\n".data(using: .utf8)!)

        body.append("--\(boundary)--\r\n".data(using: .utf8)!)

        // Create request
        var request = URLRequest(url: URL(string: "\(serverURL)/convert")!)
        request.httpMethod = "POST"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.httpBody = body

        // Upload
        let (responseData, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
            throw NSError(domain: "Upload", code: 1, userInfo: [NSLocalizedDescriptionKey: "Upload failed"])
        }

        let convertResponse = try JSONDecoder().decode(ConvertResponse.self, from: responseData)
        return convertResponse.jobId
    }

    private func pollAndDownload(jobId: String) async throws -> Data {
        // Poll for completion
        while true {
            let statusURL = URL(string: "\(serverURL)/status/\(jobId)")!
            let (statusData, _) = try await URLSession.shared.data(from: statusURL)
            let statusResponse = try JSONDecoder().decode(StatusResponse.self, from: statusData)

            // Send progress update
            messaging.sendMessage(OutgoingMessage(
                status: "processing",
                progress: statusResponse.progress,
                filepath: nil,
                error: nil
            ))

            if statusResponse.status == "completed" {
                break
            } else if statusResponse.status == "failed" {
                throw NSError(domain: "Convert", code: 2, userInfo: [NSLocalizedDescriptionKey: statusResponse.error ?? "Conversion failed"])
            }

            // Wait 500ms before next poll
            try await Task.sleep(nanoseconds: 500_000_000)
        }

        // Download the gif
        let downloadURL = URL(string: "\(serverURL)/download/\(jobId)")!
        let (gifData, _) = try await URLSession.shared.data(from: downloadURL)

        return gifData
    }
}

// MARK: - Main Entry Point

let controller = RecorderController()

// Read stdin on background thread to not block RunLoop
DispatchQueue.global(qos: .userInitiated).async {
    controller.start()
}

// Run the main RunLoop for async callbacks
RunLoop.current.run()
