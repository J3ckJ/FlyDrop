// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "PultProtocol",
    products: [
        .library(name: "PultProtocol", targets: ["PultProtocol"]),
    ],
    targets: [
        .target(name: "PultProtocol"),
        .testTarget(name: "PultProtocolTests", dependencies: ["PultProtocol"]),
    ]
)
