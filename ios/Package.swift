// swift-tools-version: 5.9
import PackageDescription

// Pure protocol fixtures only. This is deliberately separate from generated
// App/CapApp-SPM and does not pretend to compile UIKit/WebKit/Capacitor on Linux.
let package = Package(
    name: "FitFlowNativeAccountCore",
    platforms: [.macOS(.v13), .iOS(.v15)],
    products: [.library(name: "FitFlowNativeAccountCore", targets: ["FitFlowNativeAccountCore"])],
    targets: [
        .target(name: "FitFlowNativeAccountCore", path: "App/App", exclude: [
            "AppDelegate.swift", "SceneDelegate.swift", "FitFlowBridgeViewController.swift", "NativeAccountBridge.swift", "NativeAccountTransport.swift",
            "Assets.xcassets", "Base.lproj", "Info.plist"
        ], sources: ["NativeAccountProtocol.swift"]),
        .testTarget(name: "NativeAccountCoreTests", dependencies: ["FitFlowNativeAccountCore"], path: "Tests/NativeAccountCoreTests")
    ]
)
