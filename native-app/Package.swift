// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "GifRecorder",
    platforms: [.macOS(.v13)],
    dependencies: [],
    targets: [
        .executableTarget(
            name: "GifRecorder",
            dependencies: [],
            path: "Sources"
        )
    ]
)
