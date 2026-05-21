#!/usr/bin/env swift
/**
 * Normalize macOS app icon framing to match Zoom Meeting Hub style:
 * thick white squircle border, blue gradient inner panel, centered mascot.
 *
 * Usage: swift scripts/frame-app-icon.swift [input.png] [output.png]
 * Defaults: resources/icon-source.png -> resources/icon.png
 */

import AppKit
import CoreGraphics

let args = CommandLine.arguments
let projectRoot = URL(fileURLWithPath: #file).deletingLastPathComponent().deletingLastPathComponent()
let inputPath =
  args.count > 1
  ? URL(fileURLWithPath: args[1])
  : projectRoot.appendingPathComponent("resources/icon-source.png")
let outputPath =
  args.count > 2
  ? URL(fileURLWithPath: args[2])
  : projectRoot.appendingPathComponent("resources/icon.png")

let size: CGFloat = 1024
// Zoom Meeting Hub–style proportions (thick white ring, ~22% corner radius)
let borderWidth: CGFloat = 78
let innerCornerRadius: CGFloat = 178
let outerCornerRadius: CGFloat = 228

func loadImage(_ url: URL) -> NSImage? {
  guard let img = NSImage(contentsOf: url) else { return nil }
  img.size = NSSize(width: size, height: size)
  return img
}

func roundedRectPath(in rect: CGRect, radius: CGFloat) -> CGPath {
  CGPath(
    roundedRect: rect,
    cornerWidth: radius,
    cornerHeight: radius,
    transform: nil
  )
}

func blueGradient(in ctx: CGContext, rect: CGRect) {
  let colors = [
    CGColor(red: 0.35, green: 0.62, blue: 0.98, alpha: 1),
    CGColor(red: 0.12, green: 0.38, blue: 0.86, alpha: 1),
  ] as CFArray
  guard let gradient = CGGradient(
    colorsSpace: CGColorSpaceCreateDeviceRGB(),
    colors: colors,
    locations: [0, 1]
  ) else { return }
  ctx.saveGState()
  ctx.addPath(roundedRectPath(in: rect, radius: innerCornerRadius))
  ctx.clip()
  ctx.drawLinearGradient(
    gradient,
    start: CGPoint(x: rect.midX, y: rect.maxY),
    end: CGPoint(x: rect.midX, y: rect.minY),
    options: []
  )
  ctx.restoreGState()
}

guard let source = loadImage(inputPath) else {
  fputs("Could not load image: \(inputPath.path)\n", stderr)
  fputs("Place your mascot artwork at resources/icon-source.png (1024×1024, no outer frame).\n", stderr)
  exit(1)
}

let rep = NSBitmapImageRep(
  bitmapDataPlanes: nil,
  pixelsWide: Int(size),
  pixelsHigh: Int(size),
  bitsPerSample: 8,
  samplesPerPixel: 4,
  hasAlpha: true,
  isPlanar: false,
  colorSpaceName: .deviceRGB,
  bytesPerRow: 0,
  bitsPerPixel: 0
)!
rep.size = NSSize(width: size, height: size)

NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)

let ctx = NSGraphicsContext.current!.cgContext
let full = CGRect(x: 0, y: 0, width: size, height: size)
let inner = full.insetBy(dx: borderWidth, dy: borderWidth)

// White outer squircle frame
ctx.setFillColor(NSColor.white.cgColor)
ctx.addPath(roundedRectPath(in: full, radius: outerCornerRadius))
ctx.fillPath()

// Blue gradient inner panel
blueGradient(in: ctx, rect: inner)

// Mascot: scale source to fit inner panel (assume source is full icon or artwork)
let mascotInset: CGFloat = 24
let mascotRect = inner.insetBy(dx: mascotInset, dy: mascotInset)
ctx.saveGState()
ctx.addPath(roundedRectPath(in: inner, radius: innerCornerRadius))
ctx.clip()
source.draw(
  in: mascotRect,
  from: NSRect(origin: .zero, size: source.size),
  operation: .sourceOver,
  fraction: 1
)
ctx.restoreGState()

NSGraphicsContext.restoreGraphicsState()

guard
  let png = rep.representation(using: .png, properties: [:]),
  let outDir = outputPath.deletingLastPathComponent() as URL?
else {
  fputs("Failed to encode PNG\n", stderr)
  exit(1)
}
try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
try png.write(to: outputPath)
print("Wrote \(outputPath.path)")
