// Complete local PDF pages without JavaScript, URLs or external assets.
// The default remains the compact one-page document used by existing callers.
export function previewPdf(
  text = 'CC SPACE PDF preview',
  options: { pages?: number; width?: number; height?: number; badPage?: number } = {},
) {
  const count = Math.max(1, Math.floor(options.pages ?? 1));
  const width = options.width ?? 300;
  const height = options.height ?? 180;
  const pageIds = Array.from({ length: count }, (_, i) => 4 + i * 2);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${count} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  pageIds.forEach((id, i) => {
    const label = `${text}${count > 1 ? ` - page ${i + 1}` : ''}`
      .replaceAll('\\', '\\\\')
      .replaceAll('(', '\\(')
      .replaceAll(')', '\\)');
    const stream = `BT /F1 18 Tf 40 ${height - 60} Td (${label}) Tj ET`;
    objects.push(
      options.badPage === i + 1
        ? 'null'
        : `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    );
  });
  let result = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(result.length);
    result += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = result.length;
  result += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) result += `${String(offset).padStart(10, '0')} 00000 n \n`;
  result += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(result);
}
