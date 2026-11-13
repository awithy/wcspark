// Regenerates the PNG app icons from public/icons/icon.svg. Run with `npm run icons`.
import fs from "node:fs";
import sharp from "sharp";

const dir = "public/icons";
const svg = fs.readFileSync(`${dir}/icon.svg`);

const render = (size: number) => sharp(svg, { density: 300 }).resize(size, size).png();

await render(192).toFile(`${dir}/icon-192.png`);
await render(512).toFile(`${dir}/icon-512.png`);
await render(180).toFile(`${dir}/apple-touch-icon.png`);

// Maskable: full-bleed background with the glyph inside the 80% safe zone.
const inner = await render(400).toBuffer();
await sharp({ create: { width: 512, height: 512, channels: 4, background: "#0f1012" } })
  .composite([{ input: inner, gravity: "center" }])
  .png()
  .toFile(`${dir}/icon-maskable-512.png`);

console.log("icons written to", dir);
