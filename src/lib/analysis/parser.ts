import ts from "typescript";
import { createHash } from "node:crypto";
import type { SourceFile } from "@/lib/contracts/repository";
import type {
  CodeSymbol,
  ModuleReference,
  ParsedFile,
  SourceLocation,
} from "@/lib/contracts/analysis";

export function stableId(...parts: (string | number)[]) {
  return createHash("sha256").update(parts.join(":")).digest("hex").slice(0, 24);
}

export function isCodePath(path: string) {
  return /\.(?:[cm]?[jt]s|[jt]sx)$/i.test(path);
}

export function locationOf(source: SourceFile, file: ts.SourceFile, node: ts.Node): SourceLocation {
  return {
    fileId: source.fileId,
    path: source.path,
    startLine: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
    endLine: Math.min(
      source.lineCount || 1,
      file.getLineAndCharacterOfPosition(Math.max(node.getStart(file), node.getEnd() - 1)).line + 1,
    ),
    contentHash: source.contentHash,
  };
}

export function parseSource(source: SourceFile): ParsedFile {
  const kind = /\.tsx$/i.test(source.path)
    ? ts.ScriptKind.TSX
    : /\.jsx$/i.test(source.path)
      ? ts.ScriptKind.JSX
      : /\.[cm]?js$/i.test(source.path)
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
  const file = ts.createSourceFile(source.path, source.content, ts.ScriptTarget.Latest, true, kind);
  const diagnostics =
    (file as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ??
    [];
  const result: ParsedFile = {
    fileId: source.fileId,
    path: source.path,
    contentHash: source.contentHash,
    lineCount: source.lineCount,
    status: diagnostics.length ? "syntax-error" : "parsed",
    clientDirective: false,
    serverDirective: false,
    exports: [],
    exportLocations: {},
    symbols: [],
    imports: [],
    diagnostics: diagnostics
      .slice(0, 8)
      .map(
        (error) =>
          `${error.start === undefined ? "" : `Line ${file.getLineAndCharacterOfPosition(error.start).line + 1}: `}${ts.flattenDiagnosticMessageText(error.messageText, " ")}`,
      ),
  };
  // A malformed file is visible as a parse failure, never a source of verified edges.
  if (diagnostics.length) return result;

  for (const statement of file.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
    if (statement.expression.text === "use client") result.clientDirective = true;
    if (statement.expression.text === "use server") result.serverDirective = true;
  }
  const exported = (node: ts.Node) =>
    ts.canHaveModifiers(node) &&
    Boolean(
      ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword),
    );
  const isDefault = (node: ts.Node) =>
    ts.canHaveModifiers(node) &&
    Boolean(
      ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword),
    );
  const isAsync = (node: ts.Node) =>
    ts.canHaveModifiers(node) &&
    Boolean(
      ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword),
    );

  function addSymbol(
    node: ts.Node,
    name: string,
    kind: CodeSymbol["kind"],
    owner: ts.Node = node,
    exportFlag = exported(owner),
  ) {
    if (result.symbols.length >= 300) return;
    const sourceLocation = locationOf(source, file, node);
    const symbol = {
      id: stableId(source.fileId, name, kind, node.pos),
      name,
      kind,
      exported: exportFlag,
      defaultExport: isDefault(owner),
      async: isAsync(node),
      source: sourceLocation,
    };
    result.symbols.push(symbol);
    if (symbol.defaultExport) {
      result.exports.push("default");
      result.exportLocations.default = sourceLocation;
    } else if (symbol.exported) {
      result.exports.push(name);
      if (kind !== "interface" && kind !== "type")
        result.exportLocations[name] = locationOf(source, file, owner);
    }
  }

  function addReference(
    node: ts.Node,
    specifier: ts.Expression | undefined,
    form: ModuleReference["form"],
    typeOnly = false,
  ) {
    if (result.imports.length >= 400 || !specifier) return;
    const literal = ts.isStringLiteralLike(specifier);
    result.imports.push({
      id: stableId(source.fileId, form, node.pos),
      specifier: literal ? specifier.text : specifier.getText(file).slice(0, 160),
      form,
      typeOnly,
      computed: !literal,
      resolution: "unresolved",
      ...(literal ? {} : { reason: "Computed import target cannot be resolved statically." }),
      source: locationOf(source, file, node),
    });
  }

  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      const bindings = clause?.namedBindings;
      const allTypeOnly = Boolean(
        bindings &&
        ts.isNamedImports(bindings) &&
        bindings.elements.length &&
        bindings.elements.every((element) => element.isTypeOnly) &&
        !clause?.name,
      );
      addReference(
        statement,
        statement.moduleSpecifier,
        "import",
        Boolean(clause?.isTypeOnly || allTypeOnly),
      );
    } else if (ts.isExportDeclaration(statement)) {
      const allTypeOnly = Boolean(
        statement.exportClause &&
        ts.isNamedExports(statement.exportClause) &&
        statement.exportClause.elements.length &&
        statement.exportClause.elements.every((element) => element.isTypeOnly),
      );
      if (statement.moduleSpecifier)
        addReference(
          statement,
          statement.moduleSpecifier,
          "re-export",
          statement.isTypeOnly || allTypeOnly,
        );
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          result.exports.push(element.name.text);
          if (!statement.isTypeOnly && !element.isTypeOnly)
            result.exportLocations[element.name.text] = locationOf(source, file, statement);
        }
      }
    } else if (ts.isExportAssignment(statement)) {
      if (!statement.isExportEquals) {
        result.exports.push("default");
        result.exportLocations.default = locationOf(source, file, statement);
      }
    } else if (ts.isFunctionDeclaration(statement)) {
      addSymbol(statement, statement.name?.text ?? "default export", "function");
    } else if (ts.isClassDeclaration(statement)) {
      const name = statement.name?.text ?? "default export";
      addSymbol(statement, name, "class");
      for (const member of statement.members) {
        if (
          ts.isMethodDeclaration(member) &&
          member.name &&
          !ts.isComputedPropertyName(member.name)
        )
          addSymbol(member, `${name}.${member.name.getText(file)}`, "method", member, false);
      }
    } else if (ts.isInterfaceDeclaration(statement))
      addSymbol(statement, statement.name.text, "interface");
    else if (ts.isTypeAliasDeclaration(statement))
      addSymbol(statement, statement.name.text, "type");
    else if (ts.isEnumDeclaration(statement)) addSymbol(statement, statement.name.text, "enum");
    else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        const functionLike =
          declaration.initializer &&
          (ts.isArrowFunction(declaration.initializer) ||
            ts.isFunctionExpression(declaration.initializer));
        const before = result.symbols.length;
        addSymbol(
          declaration,
          declaration.name.text,
          functionLike ? "function" : "variable",
          statement,
        );
        if (functionLike && result.symbols.length > before)
          result.symbols[result.symbols.length - 1].async = isAsync(declaration.initializer!);
      }
    }
  }

  // Traverse only to observe import expressions, not to execute or infer calls.
  let requireFound = false;
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword)
        addReference(node, node.arguments[0], "dynamic");
      if (ts.isIdentifier(node.expression) && node.expression.text === "require")
        requireFound = true;
    }
    if (ts.isImportEqualsDeclaration(node)) requireFound = true;
    ts.forEachChild(node, visit);
  }
  visit(file);
  if (requireFound)
    result.diagnostics.push(
      "CommonJS require/import-equals references are not resolved in this version.",
    );
  if (result.symbols.length >= 300)
    result.diagnostics.push("Symbol list reached the 300-per-file display limit.");
  if (result.imports.length >= 400)
    result.diagnostics.push("Import list reached the 400-per-file limit.");
  result.exports = [...new Set(result.exports)].sort();
  for (const symbol of result.symbols) {
    if (result.exports.includes(symbol.name)) symbol.exported = true;
  }
  return result;
}
