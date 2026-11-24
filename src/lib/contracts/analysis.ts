import type { ApiError, RepositorySnapshot } from "./repository";

export const ANALYZER_VERSION = "structure-v1";
export const ANALYSIS_DOWNLOAD_BATCH = 20;

export type SourceLocation = {
  fileId: string;
  path: string;
  startLine: number;
  endLine: number;
  contentHash: string;
};

export type CodeSymbol = {
  id: string;
  name: string;
  kind: "function" | "class" | "method" | "variable" | "interface" | "type" | "enum";
  exported: boolean;
  defaultExport: boolean;
  async: boolean;
  source: SourceLocation;
};

export type ModuleReference = {
  id: string;
  specifier: string;
  form: "import" | "re-export" | "dynamic";
  typeOnly: boolean;
  computed: boolean;
  resolution: "internal" | "external" | "unresolved";
  targetFileId?: string;
  packageName?: string;
  reason?: string;
  source: SourceLocation;
};

export type ParsedFile = {
  fileId: string;
  path: string;
  contentHash: string;
  lineCount: number;
  status: "parsed" | "syntax-error";
  clientDirective: boolean;
  serverDirective: boolean;
  exports: string[];
  exportLocations: Record<string, SourceLocation>;
  symbols: CodeSymbol[];
  imports: ModuleReference[];
  diagnostics: string[];
};

export type EntryPoint = {
  id: string;
  fileId: string;
  path: string;
  kind: "page" | "layout" | "route";
  routePath: string;
  methods: string[];
  source: SourceLocation;
};

export type DependencyEdge = {
  id: string;
  from: string;
  to: string;
  referenceId: string;
  form: ModuleReference["form"];
  typeOnly: boolean;
  source: SourceLocation;
};

export type StructuralAnalysis = {
  id: string;
  snapshotId: string;
  commit: string;
  analyzerVersion: string;
  fingerprint: string;
  createdAt: string;
  status: "ready" | "partial";
  framework: { name: "next-app" | "generic" | "unknown"; label: string; appRoot?: string };
  coverage: {
    candidateFiles: number;
    parsedFiles: number;
    syntaxErrorFiles: number;
    unreadFiles: number;
    symbolCount: number;
    internalReferences: number;
    externalReferences: number;
    unresolvedReferences: number;
  };
  files: ParsedFile[];
  edges: DependencyEdge[];
  entryPoints: EntryPoint[];
  groups: { name: string; fileIds: string[]; parsedCount: number }[];
  limitations: string[];
  downloadFailures: { fileId: string; message: string; code: string }[];
};

export type AnalysisResult = {
  analysis: StructuralAnalysis | null;
  snapshot: RepositorySnapshot;
  stale: boolean;
};

export type AnalysisEvent =
  | {
      type: "progress";
      stage: "reading" | "parsing" | "saving";
      message: string;
      completed: number;
      total: number;
    }
  | { type: "complete"; analysis: StructuralAnalysis; snapshot: RepositorySnapshot; stale: boolean }
  | { type: "error"; error: ApiError };
