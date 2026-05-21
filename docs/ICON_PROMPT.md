# DevHub-AI app icon — image prompt (Meeting Hub / Zoom style)

Use this when regenerating the mascot in **Figma AI**, **Midjourney**, **DALL·E**, **Ideogram**, etc.

## What to match (from Zoom Meeting Hub)

- **Canvas:** 1024×1024 px, square, no transparency (macOS app icon).
- **Frame:** Thick **white rounded-square border** (~7–8% of width), like iOS/macOS squircle icons.
- **Inner panel:** Blue vertical gradient (sky blue → royal blue) inside the white frame.
- **Mascot:** Centered 3D owl, ~70% of inner area, friendly tech look.
- **Badge (optional):** Small **AI** chip badge, bottom-right on inner panel (not on the white border).
- **Do not add:** App name text, calendar icons, or macOS shadow (the system adds that).

## Copy-paste prompt

```
macOS app icon, 1024x1024, flat front view, no drop shadow.

Thick white rounded-square border frame (squircle, ~8% border width), exactly like Zoom Meeting Hub app icon framing.

Inside the frame: smooth blue gradient background (light sky blue top to deep royal blue bottom).

Center: cute 3D Pixar-style brown owl developer mascot, forward-facing, chibi proportions, tan chest feathers, small orange beak.

Owl wears a white futuristic AR visor with glowing cyan curved smile eyes and three cyan dots on the visor; white over-ear headset with cyan LED ring on one ear; thin white microphone boom with cyan tip.

Small bottom-right badge on the blue panel only: black rounded square with white circuit traces and cyan "AI" letters (not overlapping the white border).

High detail, soft studio lighting, glossy 3D render, centered composition, no text, no watermark, no calendar icon, vector-clean edges suitable for app store icon.
```

## Negative prompt (if your tool supports it)

```
text, logo typography, DevHub wordmark, calendar, flat 2D cartoon, thin border, transparent background, drop shadow, blurry, cropped, asymmetric frame, realistic photo
```

## After you generate

1. Save as `resources/icon-source.png` (1024×1024, mascot only or full bleed — script will re-frame).
2. Run:

```bash
swift scripts/frame-app-icon.swift resources/icon-source.png resources/icon.png
npm run icons
npm run refresh-icon   # if installed to /Applications
npm run patch-dev-icon # if using npm run dev
```

3. Restart the app; if Dock still shows the old flat owl, quit DevHub-AI, run `npm run refresh-icon`, or remove the icon from Dock and re-add after launch.

## Source files

| File | Role |
|------|------|
| `resources/icon-source.png` | Raw AI export (optional) |
| `resources/icon.png` | Framed source of truth |
| `resources/icon.icns` | Generated for macOS |
