import AppKit
import ImageIO
import UniformTypeIdentifiers
import Foundation

// Helper: write GIF data to NSPasteboard with multiple conforming types.
// Usage:
//   gifclip <path.gif>
//   gifclip --debug <path.gif>   (prints pasteboard types after write)
// Exit Codes:
//   0 success | 1 usage/file errors | 2 read error | 3 pasteboard write error | 4 png fallback error

func err(_ msg: String, code: Int32) -> Never {
    FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
    exit(code)
}

let args = CommandLine.arguments.dropFirst()
var debug = false
var path: String? = nil
var idx = 0
while idx < args.count {
    let a = args[args.index(args.startIndex, offsetBy: idx)]
    if a == "--debug" { debug = true; idx += 1; continue }
    if path == nil { path = a; idx += 1; continue }
    err("Unexpected argument: \(a)", code: 1)
}
guard let p = path else { err("Usage: gifclip [--debug] <path.gif>", code: 1) }

let url = URL(fileURLWithPath: p)
guard FileManager.default.fileExists(atPath: url.path) else { err("File not found: \(url.path)", code: 1) }
guard let data = try? Data(contentsOf: url) else { err("Failed to read file", code: 2) }

let pb = NSPasteboard.general
pb.clearContents()

// Primary write as GIF
let gifType = NSPasteboard.PasteboardType("public.gif")
let wroteGif = pb.setData(data, forType: gifType)
if !wroteGif { err("Pasteboard write failed (public.gif)", code: 3) }

// Some apps only look for public.image; provide an alias
pb.setData(data, forType: .tiff) // minimal to ensure there is an image flavor; replaced by PNG fallback below

// Provide file URL (metadata)
pb.writeObjects([url as NSURL])

// Fallback: also push first frame as PNG -> public.png / public.image
if let source = CGImageSourceCreateWithData(data as CFData, nil),
   let first = CGImageSourceCreateImageAtIndex(source, 0, nil) {
    let rep = NSBitmapImageRep(cgImage: first)
    if let pngData = rep.representation(using: .png, properties: [:]) {
        pb.setData(pngData, forType: NSPasteboard.PasteboardType.png)
    } else {
        // Non-fatal; just emit debug if requested
        if debug { fputs("[warn] png fallback failed\n", stderr) }
    }
} else {
    if debug { fputs("[warn] cannot decode first frame for png fallback\n", stderr) }
}

if debug {
    let typeList = (pb.types ?? []).map { String(describing: $0) }.joined(separator: ", ")
    fputs("[debug] pasteboard types: \(typeList)\n", stderr)
}

print("GIF copied to clipboard: \(url.path)")
