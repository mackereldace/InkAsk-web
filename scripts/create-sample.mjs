// Self-authored fixture: native English text + a Chinese/English scanned page.
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { existsSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
const fontPath = [
  process.env.INKASK_CJK_FONT,
  "/System/Library/Fonts/STHeiti Light.ttc",
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
  "C:/Windows/Fonts/msyh.ttc",
].find((p) => p && existsSync(p));
if (!fontPath || !GlobalFonts.registerFromPath(fontPath, "InkAsk CJK"))
  throw new Error(
    "Set INKASK_CJK_FONT to a Chinese font file to rebuild the sample.",
  );
const canvas = createCanvas(1190, 1684),
  ctx = canvas.getContext("2d");
ctx.fillStyle = "#fff";
ctx.fillRect(0, 0, 1190, 1684);
ctx.fillStyle = "#47664a";
ctx.font = "20px sans-serif";
ctx.fillText("INKASK  /  SCANNED LEARNING MATERIAL", 110, 130);
ctx.fillStyle = "#273c31";
ctx.font = 'bold 48px "InkAsk CJK",sans-serif';
ctx.fillText("导数：变化的瞬间", 110, 235);
ctx.fillStyle = "#56634d";
ctx.font = '27px "InkAsk CJK",sans-serif';
[
  "导数描述函数在某一点的瞬时变化率。",
  "从割线到切线，我们让两个点逐渐靠近。",
  "The derivative measures an instantaneous rate of change.",
  "For f(x) = x squared, its derivative is f'(x) = 2x.",
].forEach((line, i) => ctx.fillText(line, 110, 340 + i * 55));
ctx.fillStyle = "#f2f5e9";
ctx.fillRect(100, 650, 990, 180);
ctx.fillStyle = "#4c6742";
ctx.font = "34px Georgia";
ctx.fillText("f'(x) = lim  [f(x + h) - f(x)] / h", 145, 730);
ctx.font = "23px Georgia";
ctx.fillText("h -> 0", 338, 775);
ctx.strokeStyle = "#8ba274";
ctx.lineWidth = 3;
ctx.beginPath();
ctx.moveTo(170, 1300);
ctx.lineTo(1000, 1300);
ctx.moveTo(230, 1370);
ctx.lineTo(230, 920);
ctx.stroke();
ctx.strokeStyle = "#3c684f";
ctx.lineWidth = 5;
ctx.beginPath();
for (let x = 0; x <= 650; x++) {
  const xx = 260 + x,
    yy = 1280 - (x * x) / 1400;
  x === 0 ? ctx.moveTo(xx, yy) : ctx.lineTo(xx, yy);
}
ctx.stroke();
ctx.strokeStyle = "#c19b58";
ctx.lineWidth = 3;
ctx.beginPath();
ctx.moveTo(350, 1330);
ctx.lineTo(960, 1000);
ctx.stroke();
ctx.fillStyle = "#829475";
ctx.font = "22px sans-serif";
ctx.fillText("A tangent shows the local direction of change.", 285, 1450);
ctx.fillText("02   /   Try OCR or select a region to ask.", 110, 1570);
const jpeg = canvas.toBuffer("image/jpeg");
const text = (font, size, x, y, value) =>
  `BT /${font} ${size} Tf ${x} ${y} Td (${value.replace(/[\\()]/g, "\\$&")}) Tj ET\n`;
let content =
  "0.20 0.33 0.25 rg\n" +
  text("F1", 9, 56, 780, "INKASK   /   A SMALL READER FOR BIG IDEAS") +
  text("F2", 29, 56, 714, "Understanding derivatives") +
  text("F1", 11, 56, 685, "01   Foundations of change");
content += "0.75 0.80 0.68 RG 0.7 w 56 661 m 539 661 l S\n";
const lines = [
  "A derivative measures how a function changes at a specific point.",
  "It is the slope of the tangent line to the graph of the function.",
  "Instead of asking how much a quantity changed over a long interval,",
  "we ask how quickly it changes at this exact moment.",
];
lines.forEach((line, i) => (content += text("F1", 12, 56, 620 - i * 24, line)));
content +=
  text("F2", 17, 56, 474, "From average to instantaneous") +
  text(
    "F1",
    12,
    56,
    438,
    "The average rate of change between x and x + h is:",
  ) +
  text("F3", 17, 105, 390, "[ f(x + h) - f(x) ] / h") +
  text(
    "F1",
    12,
    56,
    340,
    "As h approaches zero, the secant line becomes the tangent line.",
  ) +
  text(
    "F1",
    12,
    56,
    316,
    "This limit defines the derivative, provided that the limit exists.",
  ) +
  text("F2", 17, 56, 245, "A simple example") +
  text(
    "F1",
    12,
    56,
    209,
    "For f(x) = x squared, the derivative is f'(x) = 2x.",
  ) +
  text("F1", 12, 56, 185, "At x = 3, the instantaneous rate of change is 6.") +
  text(
    "F1",
    10,
    56,
    100,
    "Select a sentence to ask. Page 2 is a scan: try manual OCR.",
  ) +
  text("F1", 9, 56, 45, "INKASK LEARNING NOTES") +
  text("F1", 9, 526, 45, "01");
const stream = (bytes) =>
  Buffer.concat([
    Buffer.from(`<< /Length ${bytes.length} >>\nstream\n`),
    bytes,
    Buffer.from("\nendstream"),
  ]);
const objects = [
  Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
  Buffer.from("<< /Type /Pages /Kids [3 0 R 8 0 R] /Count 2 >>"),
  Buffer.from(
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R /F3 6 0 R >> >> /Contents 7 0 R >>",
  ),
  Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
  Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>"),
  Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Times-Italic >>"),
  stream(Buffer.from(content)),
  Buffer.from(
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im1 9 0 R >> >> /Contents 10 0 R >>",
  ),
  Buffer.concat([
    Buffer.from(
      `<< /Type /XObject /Subtype /Image /Width 1190 /Height 1684 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
    ),
    jpeg,
    Buffer.from("\nendstream"),
  ]),
  stream(Buffer.from("q 595 0 0 842 0 0 cm /Im1 Do Q")),
];
const parts = [Buffer.from("%PDF-1.4\n")],
  offsets = [0];
let position = parts[0].length;
objects.forEach((obj, i) => {
  offsets.push(position);
  const bytes = Buffer.concat([
    Buffer.from(`${i + 1} 0 obj\n`),
    obj,
    Buffer.from("\nendobj\n"),
  ]);
  parts.push(bytes);
  position += bytes.length;
});
parts.push(
  Buffer.from(
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
      .slice(1)
      .map((n) => `${String(n).padStart(10, "0")} 00000 n \n`)
      .join(
        "",
      )}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${position}\n%%EOF\n`,
  ),
);
await mkdir("public", { recursive: true });
await writeFile("public/sample.pdf", Buffer.concat(parts));
console.log("Created public/sample.pdf (2 pages, native + scanned).");
