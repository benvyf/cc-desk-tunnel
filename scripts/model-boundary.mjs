import ts from 'typescript';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const modelPackage = (name) => {
  const root = name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0];
  return (
    root.startsWith('@anthropic-ai/') ||
    root.startsWith('@ai-sdk/') ||
    ['openai', '@cc-desk-tunnel/server'].includes(root)
  );
};

// Build-time architecture guard, not a network sandbox. Model runtimes belong to
// the remote server; the desktop owns UI, local previews and the control tunnel.
export function modelBoundaryIssues(file, source) {
  const issues = [];
  if (file === 'apps/desktop/package.json') {
    let manifest;
    try {
      manifest = JSON.parse(source);
    } catch {
      return issues;
    }
    for (const field of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ]) {
      for (const [name, version] of Object.entries(manifest[field] ?? {})) {
        const target =
          typeof version === 'string' && version.startsWith('npm:') ? version.slice(4) : '';
        const at = target.indexOf('@', target.startsWith('@') ? 1 : 0);
        const alias = at < 0 ? target : target.slice(0, at);
        if (modelPackage(name) || modelPackage(alias))
          issues.push(`客户端禁止声明模型运行依赖：${file} → ${name}`);
      }
    }
  }
  if (!/^apps\/desktop\/(?:src|electron)\/.*\.(?:[cm]?[jt]sx?)$/.test(file)) return issues;
  const check = (literal, typeOnly = false) => {
    if (!literal || !ts.isStringLiteralLike(literal)) return;
    const name = literal.text;
    if (
      modelPackage(name) ||
      (!typeOnly && /(?:^|\/)server\/(?:src|dist)(?:\/|$)/.test(name.replaceAll('\\', '/')))
    )
      issues.push(`客户端禁止导入模型运行入口：${file} → ${name}`);
  };
  const onlyTypes = (elements) =>
    elements?.length > 0 && elements.every((element) => element.isTypeOnly);
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const named = clause?.namedBindings;
      check(
        node.moduleSpecifier,
        clause?.isTypeOnly ||
          (!clause?.name && named && ts.isNamedImports(named) && onlyTypes(named.elements)),
      );
    } else if (ts.isExportDeclaration(node)) {
      check(
        node.moduleSpecifier,
        node.isTypeOnly ||
          (node.exportClause &&
            ts.isNamedExports(node.exportClause) &&
            onlyTypes(node.exportClause.elements)),
      );
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      check(node.moduleReference.expression, node.isTypeOnly);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      check(node.argument.literal, true);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      check(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(file, source, ts.ScriptTarget.Latest));
  return issues;
}

export function assertDesktopModelBoundary(root) {
  const files = ['apps/desktop/package.json'];
  const directories = ['apps/desktop/src', 'apps/desktop/electron'];
  while (directories.length) {
    const directory = directories.pop();
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) directories.push(file);
      else if (/\.[cm]?[jt]sx?$/.test(file)) files.push(file);
    }
  }
  const issues = files.flatMap((file) =>
    modelBoundaryIssues(file, readFileSync(join(root, file), 'utf8')),
  );
  if (issues.length) throw new Error(issues.join('\n'));
}
