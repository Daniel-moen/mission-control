// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "AgentWidget",
    platforms: [
        .macOS(.v13)
    ],
    targets: [
        .executableTarget(
            name: "AgentWidget",
            path: "Sources/AgentWidget"
        )
    ]
)
