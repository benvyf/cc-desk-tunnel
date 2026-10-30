import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { access, mkdtemp, mkdir, readFile, rm, writeFile, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const { createPreviewOffice, unpackedModulePath } = createRequire(import.meta.url)(
  '../electron/preview-office.cjs',
);
const pdf = Buffer.from('%PDF-1.7\npreview');

test('packaged Office runtime uses physical unpacked module paths for engines and workers', () => {
  assert.equal(typeof unpackedModulePath, 'function');
  assert.equal(
    unpackedModulePath('C:\\app\\resources\\app.asar\\node_modules\\kit\\index.js'),
    'C:\\app\\resources\\app.asar.unpacked\\node_modules\\kit\\index.js',
  );
  assert.equal(
    unpackedModulePath('/Applications/app/resources/app.asar/node_modules/kit/index.js'),
    '/Applications/app/resources/app.asar.unpacked/node_modules/kit/index.js',
  );
  assert.equal(
    unpackedModulePath('C:\\dev\\node_modules\\kit\\index.js'),
    'C:\\dev\\node_modules\\kit\\index.js',
  );
  assert.equal(
    unpackedModulePath('/apps/app.asar.unpacked/node_modules/kit/index.js'),
    '/apps/app.asar.unpacked/node_modules/kit/index.js',
  );
});
async function fixture(t, render, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cc-office-test-'));
  const input = join(root, 'source.docx');
  await writeFile(input, 'document bytes');
  let settings;
  const office = createPreviewOffice({
    ...options,
    createConverter: async (value) => {
      settings = value;
      return { render, dispose: async () => {} };
    },
  });
  t.after(async () => {
    await office.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, input, office, settings: () => settings };
}

test('Office preview converts a private copy to bounded PDF bytes and cleans scratch', async (t) => {
  let scratch;
  const { input, office, settings } = await fixture(t, async (request) => {
    scratch = dirname(request.inputPath);
    assert.notEqual(request.inputPath, input);
    assert.equal((await readFile(request.inputPath)).toString(), 'document bytes');
    assert.equal(
      await access(request.outputPath).then(
        () => true,
        () => false,
      ),
      false,
    );
    await writeFile(request.outputPath, pdf);
    return { missingFonts: ['Missing Font'] };
  });
  assert.deepEqual(await office.render(input), {
    data: pdf.toString('base64'),
    missingFonts: ['Missing Font'],
  });
  assert.equal(settings().maxInputBytes, 20 * 1024 * 1024);
  assert.equal(settings().maxOutputBytes, 20 * 1024 * 1024);
  assert.equal(settings().timeoutMs, 60_000);
  await assert.rejects(access(scratch));
});

test('Office preview rejects shared, relative, nonregular, unsupported and oversized sources', async (t) => {
  let called = 0;
  const { root, office } = await fixture(t, async () => {
    called++;
  });
  await mkdir(join(root, 'directory.docx'));
  await writeFile(join(root, 'large.docx'), Buffer.alloc(20 * 1024 * 1024 + 1));
  await writeFile(join(root, 'source.exe'), 'executable');
  for (const input of [
    'relative.docx',
    '\\\\server\\share\\file.docx',
    join(root, 'directory.docx'),
    join(root, 'large.docx'),
    join(root, 'source.exe'),
  ])
    await assert.rejects(office.render(input));
  assert.equal(called, 0);
});

test('Office preview validates PDF output and removes scratch after errors and oversized output', async (t) => {
  let scratch;
  let attempt = 0;
  const { input, office } = await fixture(t, async (request) => {
    scratch = dirname(request.inputPath);
    if (!attempt++) throw new Error('conversion failed');
    await writeFile(
      request.outputPath,
      attempt === 2 ? 'not PDF' : Buffer.alloc(20 * 1024 * 1024 + 1),
    );
    return { missingFonts: [] };
  });
  for (const error of [/conversion failed/, /PDF/, /大小限制/]) {
    await assert.rejects(office.render(input), error);
    await assert.rejects(access(scratch));
  }
});

test('Office preview bounds the queue, serializes work, cancels reset, and can render again', async (t) => {
  let active = 0;
  let started;
  let scratch;
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  let blocking = true;
  const { input, office } = await fixture(t, async (request, signal) => {
    assert.equal(++active, 1);
    scratch = dirname(request.inputPath);
    try {
      if (blocking) {
        started();
        await new Promise((resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        );
      }
      await writeFile(request.outputPath, pdf);
      return { missingFonts: [] };
    } finally {
      active--;
    }
  });
  const pending = Array.from({ length: 4 }, () => office.render(input));
  const settled = Promise.allSettled(pending);
  await assert.rejects(office.render(input), /等待/);
  await entered;
  office.reset();
  assert((await settled).every((result) => result.status === 'rejected'));
  await assert.rejects(access(scratch));
  blocking = false;
  assert.equal((await office.render(input)).data, pdf.toString('base64'));
  await office.close();
  await assert.rejects(office.render(input), /关闭/);
});

test('Office preview times out conversion and close joins cancellation cleanup', async (t) => {
  let scratch;
  const { input, office } = await fixture(
    t,
    async (request, signal) => {
      scratch = dirname(request.inputPath);
      await new Promise((resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      );
    },
    { timeoutMs: 30 },
  );
  await assert.rejects(office.render(input), /超时/);
  assert.equal(
    await access(scratch).then(
      () => true,
      () => false,
    ),
    false,
  );
  const pending = office.render(input);
  const failed = assert.rejects(pending, /失效/);
  await office.close();
  await failed;
});

// Generate small, readable OOXML fixtures rather than checking opaque binary files into source.
function officeFixture(format, externalImage) {
  const { zipSync, strToU8 } = createRequire(import.meta.url)('fflate');
  const rels = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  let parts;
  let root;
  let contentTypes;
  if (format === 'docx') {
    root = 'word/document.xml';
    contentTypes = {
      [root]: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
    };
    const image = externalImage
      ? '<w:p><w:r><w:drawing><wp:inline><wp:extent cx="914400" cy="914400"/><wp:docPr id="1" name="External image"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="External image"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:link="rImage"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>'
      : '';
    parts = {
      [root]: `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="${office}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body><w:p><w:r><w:t>Local Office preview: hello world</w:t></w:r></w:p>${image}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>`,
    };
    if (externalImage)
      parts['word/_rels/document.xml.rels'] =
        `<Relationships xmlns="${rels}"><Relationship Id="rImage" Type="${office}/image" Target="${externalImage}" TargetMode="External"/></Relationships>`;
  } else if (format === 'xlsx') {
    root = 'xl/workbook.xml';
    contentTypes = {
      [root]: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
      'xl/worksheets/sheet1.xml':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml',
    };
    parts = {
      [root]: `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${office}"><sheets><sheet name="Preview" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      'xl/_rels/workbook.xml.rels': `<Relationships xmlns="${rels}"><Relationship Id="rId1" Type="${office}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
      'xl/worksheets/sheet1.xml':
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Local spreadsheet preview</t></is></c><c r="B1"><v>42</v></c></row></sheetData></worksheet>',
    };
  } else {
    root = 'ppt/presentation.xml';
    contentTypes = {
      [root]: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
      'ppt/slides/slide1.xml':
        'application/vnd.openxmlformats-officedocument.presentationml.slide+xml',
    };
    parts = {
      [root]: `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="${office}"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
      'ppt/_rels/presentation.xml.rels': `<Relationships xmlns="${rels}"><Relationship Id="rId1" Type="${office}/slide" Target="slides/slide1.xml"/></Relationships>`,
      'ppt/slides/slide1.xml':
        '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Preview"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="7315200" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Local presentation preview</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
    };
  }
  parts['_rels/.rels'] =
    `<Relationships xmlns="${rels}"><Relationship Id="rId1" Type="${office}/officeDocument" Target="${root}"/></Relationships>`;
  parts['[Content_Types].xml'] =
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${Object.entries(
      contentTypes,
    )
      .map(([name, type]) => `<Override PartName="/${name}" ContentType="${type}"/>`)
      .join('')}</Types>`;
  return zipSync(
    Object.fromEntries(Object.entries(parts).map(([name, xml]) => [name, strToU8(xml)])),
  );
}

test(
  'bundled engine converts real DOC/DOCX, PPT/PPTX and XLS/XLSX into readable PDF containers',
  { skip: !process.env.CC_OFFICE_INTEGRATION, timeout: 420_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'cc-office-real-'));
    const office = createPreviewOffice();
    t.after(async () => {
      await office.close();
      await rm(root, { recursive: true, force: true });
    });
    for (const format of ['docx', 'pptx', 'xlsx']) {
      const input = join(root, `preview.${format}`);
      await writeFile(input, officeFixture(format));
      const result = await office.render(input);
      const output = Buffer.from(result.data, 'base64');
      assert.equal(output.subarray(0, 5).toString(), '%PDF-', format);
      assert(output.length > 500, format);
      assert(Array.isArray(result.missingFonts));
    }
    for (const format of ['doc', 'ppt', 'xls']) {
      const input = fileURLToPath(new URL(`./fixtures/office/sample.${format}`, import.meta.url));
      assert.equal((await readFile(input)).subarray(0, 8).toString('hex'), 'd0cf11e0a1b11ae1');
      const result = await office.render(input);
      const output = Buffer.from(result.data, 'base64');
      assert.equal(output.subarray(0, 5).toString(), '%PDF-', format);
      assert(output.length > 500, format);
      assert.deepEqual(result.missingFonts, [], format);
    }
  },
);

test(
  'bundled engine denies external OOXML image requests while exporting a document',
  { skip: !process.env.CC_OFFICE_INTEGRATION, timeout: 90_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'cc-office-network-'));
    const office = createPreviewOffice();
    let requests = 0;
    const server = createServer((request, response) => {
      requests++;
      response.writeHead(200, { 'content-type': 'image/png' });
      response.end(
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=',
          'base64',
        ),
      );
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      await office.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    });
    const input = join(root, 'external-image.docx');
    const externalImage = `http://127.0.0.1:${server.address().port}/tracking.png`;
    assert.equal((await fetch(externalImage)).status, 200);
    assert.equal(requests, 1, 'probe server must be reachable');
    requests = 0;
    await writeFile(input, officeFixture('docx', externalImage));
    assert.equal(
      Buffer.from((await office.render(input)).data, 'base64')
        .subarray(0, 5)
        .toString(),
      '%PDF-',
    );
    assert.equal(requests, 0, 'converting linked OOXML image must not contact its host');
  },
);

test('a queued Office read revalidates its selected folder before reading a snapshot', async (t) => {
  let release, entered;
  const started = new Promise((resolve) => (entered = resolve));
  const gate = new Promise((resolve) => (release = resolve));
  let calls = 0;
  const { root, input, office } = await fixture(t, async (request) => {
    if (++calls === 1) {
      entered();
      await gate;
    }
    await writeFile(request.outputPath, pdf);
    return { missingFonts: [] };
  });
  const project = join(root, 'selected'),
    other = join(root, 'other');
  await mkdir(project);
  await mkdir(other);
  const queued = join(project, 'report.docx');
  await writeFile(queued, 'selected fixture');
  await writeFile(join(other, 'report.docx'), 'other fixture');
  const first = office.render(input);
  await started;
  const second = office.render(queued, (candidate) => {
    if (relative(project, candidate).startsWith('..')) throw new Error('源文件已离开所选目录');
  });
  const rejected = assert.rejects(second, /所选目录/);
  await rename(project, join(root, 'previous'));
  await symlink(other, project, 'junction');
  release();
  await first;
  await rejected;
  assert.equal(calls, 1);
});
