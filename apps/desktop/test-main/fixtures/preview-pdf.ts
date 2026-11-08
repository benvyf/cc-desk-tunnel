// Complete local PDF pages without JavaScript, URLs or external assets.
// The default remains the compact one-page document used by existing callers.
export function previewPdf(
  text = 'CC Space PDF preview',
  options: {
    pages?: number;
    width?: number;
    height?: number;
    badPage?: number;
    rotation?: number;
    noText?: boolean;
    userUnit?: number;
  } = {},
) {
  const count = Math.max(1, Math.floor(options.pages ?? 1));
  const width = options.width ?? 300;
  const height = options.height ?? 180;
  const pageIds = Array.from({ length: count }, (_, i) => 4 + i * 2);
  // A local ToUnicode map exercises Unicode extraction without external font files.
  const unicode = [...new Set([...text].filter((char) => char.charCodeAt(0) > 127))];
  const unicodeId = 4 + count * 2;
  const hex = (value: number, length = 2) => value.toString(16).padStart(length, '0');
  const unicodeMap = unicode
    .map(
      (char, i) =>
        `<${hex(128 + i)}> <${Array.from({ length: char.length }, (_, index) => hex(char.charCodeAt(index), 4)).join('')}>`,
    )
    .join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${count} >>`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica${unicode.length ? ` /ToUnicode ${unicodeId} 0 R /Encoding << /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [128 ${unicode.map(() => '/A').join(' ')}] >>` : ''} >>`,
  ];
  pageIds.forEach((id, i) => {
    const plain = `${text}${count > 1 ? ` - page ${i + 1}` : ''}`;
    const label = plain.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
    const encoded = unicode.length
      ? `<${[...plain].map((char) => hex(char.charCodeAt(0) > 127 ? 128 + unicode.indexOf(char) : char.charCodeAt(0))).join('')}>`
      : `(${label})`;
    const stream = options.noText
      ? '0.8 g 40 40 120 80 re f'
      : `BT /F1 18 Tf 40 ${height - 60} Td ${encoded} Tj ET`;
    objects.push(
      options.badPage === i + 1
        ? 'null'
        : `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Rotate ${options.rotation ?? 0}${options.userUnit === undefined ? '' : ` /UserUnit ${options.userUnit}`} /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    );
  });
  if (unicode.length) {
    const cmap = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /FixtureUnicode def\n/CMapType 2 def\n1 begincodespacerange\n<00> <FF>\nendcodespacerange\n${unicode.length} beginbfchar\n${unicodeMap}\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`;
    objects.push(`<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream`);
  }
  let result = options.userUnit === undefined ? '%PDF-1.4\n' : '%PDF-1.6\n';
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
