import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Requires librsvg (rsvg-convert) and ImageMagick (magick).
const root = fileURLToPath(new URL("../", import.meta.url));
const source = readFileSync(path.join(root, "assets/branding/nook.svg"), "utf8");
const opaque = source.replace('rx="96"', 'rx="0"');
const output = (name, data) => {
  const target = path.join(root, name);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, data);
};
const png = (svg, size, target) => output(target, execFileSync("rsvg-convert", ["-w", String(size), "-h", String(size)], { input: svg }));
output("public/nook.svg", source);
png(source, 512, "public/icon.png");
png(source, 192, "public/icon-192.png");
png(opaque, 180, "app/apple-icon.png");
const maskable = opaque.replace('<rect width="512"', '<g transform="translate(64 64) scale(.75)"><rect width="512"').replace('</svg>', '</g></svg>').replace('<g transform=', '<rect width="512" height="512" fill="#FBF5E8"/><g transform=');
png(maskable, 512, "public/icon-maskable.png");
const favicon = execFileSync("rsvg-convert", ["-w", "48", "-h", "48"], { input: source });
output("app/favicon.ico", execFileSync("magick", ["png:-", "-define", "icon:auto-resize=48,32,16", "ico:-"], { input: favicon }));
const catalog = "ios/Nook/Assets.xcassets";
const info = { version: 1, author: "xcode" };
output(`${catalog}/Contents.json`, JSON.stringify({ info }, null, 2) + "\n");
png(opaque, 1024, `${catalog}/AppIcon.appiconset/AppIcon.png`);
output(`${catalog}/AppIcon.appiconset/Contents.json`, JSON.stringify({ images: [{ filename: "AppIcon.png", idiom: "universal", platform: "ios", size: "1024x1024" }], info }, null, 2) + "\n");
copyFileSync(path.join(root, "public/nook.svg"), path.join(root, "app/icon.svg"));
