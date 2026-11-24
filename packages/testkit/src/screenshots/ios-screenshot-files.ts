import { PNG } from "pngjs";

/** A small bar chart, so the image viewer has something to show. */
export function chartPng() {
  const png = new PNG({ width: 480, height: 320 });
  const bars = [120, 200, 160, 260, 220];
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const bar = Math.floor((x - 40) / 84);
      const inBar = x >= 40 && (x - 40) % 84 < 60 && bar < bars.length;
      const filled = inBar && png.height - 30 - y < (bars[bar] ?? 0) && y < png.height - 30;
      const offset = (y * png.width + x) * 4;
      const shade = filled ? 40 + bar * 30 : 248;
      png.data[offset] = shade;
      png.data[offset + 1] = shade;
      png.data[offset + 2] = filled ? shade + 20 : 248;
      png.data[offset + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

/** A one-page PDF with a heading and two lines, built by hand so no PDF library is needed. */
export function briefPdf() {
  const text = [
    "BT /F1 28 Tf 72 720 Td (Launch brief) Tj ET",
    "BT /F1 14 Tf 72 680 Td (Ship the announcement on Tuesday.) Tj ET",
    "BT /F1 14 Tf 72 656 Td (Quotes and changelog are the last open items.) Tj ET",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = body.length;
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}
