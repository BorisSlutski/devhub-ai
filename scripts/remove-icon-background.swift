#!/usr/bin/env swift
/**
 * Remove blue panel + white frame from a generated app-icon image.
 * Outputs a 1024×1024 PNG with transparent background (mascot only).
 *
 * Usage: swift scripts/remove-icon-background.swift [input] [output]
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

let canvas: CGFloat = 1024
let outerMargin = 88

func isForeground(r: UInt8, g: UInt8, b: UInt8, x: Int, y: Int, w: Int, h: Int) -> Bool {
  let ri = Int(r)
  let gi = Int(g)
  let bi = Int(b)

  // Outer white squircle ring — always background
  if x < outerMargin || y < outerMargin || x >= w - outerMargin || y >= h - outerMargin {
    if ri > 215 && gi > 215 && bi > 215 { return false }
  }

  // Blue gradient panel
  if bi > ri + 10 && bi > gi + 4 && bi > 55 { return false }

  // Brown / tan owl
  if ri > 85 && ri > bi && gi > 50 { return true }
  // Orange beak / feet
  if ri > 130 && gi > 65 && bi < 130 { return true }
  // Black visor / AI badge
  if ri < 70 && gi < 70 && bi < 70 { return true }
  // Cyan glow
  if bi > 120 && gi > 90 && ri < 130 { return true }
  // White headset plastic
  if ri > 175 && gi > 175 && bi > 175 { return true }

  return false
}

guard let src = NSImage(contentsOf: inputPath) else {
  fputs("Could not load: \(inputPath.path)\n", stderr)
  exit(1)
}

guard
  let tiff = src.tiffRepresentation,
  let srcRep = NSBitmapImageRep(data: tiff),
  let cgSrc = srcRep.cgImage
else {
  fputs("Could not decode image\n", stderr)
  exit(1)
}

let w = cgSrc.width
let h = cgSrc.height
let colorSpace = CGColorSpaceCreateDeviceRGB()
let bitmapInfo = CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue)

guard
  let ctx = CGContext(
    data: nil,
    width: w,
    height: h,
    bitsPerComponent: 8,
    bytesPerRow: w * 4,
    space: colorSpace,
    bitmapInfo: bitmapInfo.rawValue
  ),
  let data = ctx.data
else {
  fputs("Could not create bitmap context\n", stderr)
  exit(1)
}

ctx.draw(cgSrc, in: CGRect(x: 0, y: 0, width: w, height: h))
let bytes = data.bindMemory(to: UInt8.self, capacity: w * h * 4)

var minX = w
var minY = h
var maxX = 0
var maxY = 0

for y in 0 ..< h {
  for x in 0 ..< w {
    let i = (y * w + x) * 4
    let r = bytes[i]
    let g = bytes[i + 1]
    let b = bytes[i + 2]
    if isForeground(r: r, g: g, b: b, x: x, y: y, w: w, h: h) {
      bytes[i + 3] = 255
      if x < minX { minX = x }
      if y < minY { minY = y }
      if x > maxX { maxX = x }
      if y > maxY { maxY = y }
    } else {
      bytes[i + 3] = 0
      bytes[i] = 0
      bytes[i + 1] = 0
      bytes[i + 2] = 0
    }
  }
}

guard let cut = ctx.makeImage() else {
  fputs("Failed to make cutout image\n", stderr)
  exit(1)
}

let contentW = max(maxX - minX + 1, 1)
let contentH = max(maxY - minY + 1, 1)
let pad: CGFloat = 56
let scale = min(
  (canvas - pad * 2) / CGFloat(contentW),
  (canvas - pad * 2) / CGFloat(contentH)
)
let drawW = CGFloat(contentW) * scale
let drawH = CGFloat(contentH) * scale
let drawX = (canvas - drawW) / 2
let drawY = (canvas - drawH) / 2

let outRep = NSBitmapImageRep(
  bitmapDataPlanes: nil,
  pixelsWide: Int(canvas),
  pixelsHigh: Int(canvas),
  bitsPerSample: 8,
  samplesPerPixel: 4,
  hasAlpha: true,
  isPlanar: false,
  colorSpaceName: .deviceRGB,
  bytesPerRow: 0,
  bitsPerPixel: 0
)!
outRep.size = NSSize(width: canvas, height: canvas)

NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: outRep)
let outCtx = NSGraphicsContext.current!.cgContext
outCtx.clear(CGRect(x: 0, y: 0, width: canvas, height: canvas))

let cropRect = CGRect(x: minX, y: minY, width: contentW, height: contentH)
if let cropped = cut.cropping(to: cropRect) {
  let img = NSImage(cgImage: cropped, size: NSSize(width: contentW, height: contentH))
  img.draw(
    in: CGRect(x: drawX, y: drawY, width: drawW, height: drawH),
    from: .zero,
    operation: .sourceOver,
    fraction: 1
  )
}
NSGraphicsContext.restoreGraphicsState()

guard let png = outRep.representation(using: .png, properties: [:]) else {
  fputs("Failed to encode PNG\n", stderr)
  exit(1)
}

try FileManager.default.createDirectory(
  at: outputPath.deletingLastPathComponent(),
  withIntermediateDirectories: true
)
try png.write(to: outputPath)
print("Wrote transparent icon: \(outputPath.path)")
