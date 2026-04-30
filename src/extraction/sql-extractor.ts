import { Node, Edge, ExtractionResult, ExtractionError, UnresolvedReference } from '../types';
import { generateNodeId } from './tree-sitter-helpers';

/**
 * SqlExtractor - Extracts structural elements from SQL files
 *
 * Extracts DDL objects:
 * - Tables (CREATE TABLE)
 * - Views (CREATE [OR REPLACE] VIEW)
 * - Functions (CREATE [OR REPLACE] FUNCTION)
 * - Stored procedures (CREATE [OR REPLACE] PROCEDURE)
 * - Indexes (CREATE [UNIQUE] INDEX)
 * - Triggers (CREATE [OR REPLACE] TRIGGER)
 */
export class SqlExtractor {
  private filePath: string;
  private source: string;
  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private unresolvedReferences: UnresolvedReference[] = [];
  private errors: ExtractionError[] = [];

  constructor(filePath: string, source: string) {
    this.filePath = filePath;
    this.source = source;
  }

  extract(): ExtractionResult {
    const startTime = Date.now();

    try {
      const fileNode = this.createFileNode();
      this.extractDdlObjects(fileNode.id);
    } catch (error) {
      this.errors.push({
        message: `SQL extraction error: ${error instanceof Error ? error.message : String(error)}`,
        severity: 'error',
        code: 'parse_error',
      });
    }

    return {
      nodes: this.nodes,
      edges: this.edges,
      unresolvedReferences: this.unresolvedReferences,
      errors: this.errors,
      durationMs: Date.now() - startTime,
    };
  }

  private createFileNode(): Node {
    const lines = this.source.split('\n');
    const id = generateNodeId(this.filePath, 'file', this.filePath, 1);
    const fileNode: Node = {
      id,
      kind: 'file',
      name: this.filePath.split('/').pop() || this.filePath,
      qualifiedName: this.filePath,
      filePath: this.filePath,
      language: 'sql',
      startLine: 1,
      endLine: lines.length,
      startColumn: 0,
      endColumn: lines[lines.length - 1]?.length || 0,
      updatedAt: Date.now(),
    };
    this.nodes.push(fileNode);
    return fileNode;
  }

  private extractDdlObjects(fileNodeId: string): void {
    // Strip single-line and block comments to avoid false matches
    const stripped = this.source
      .replace(/--[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');

    const patterns: Array<{ regex: RegExp; kind: Node['kind']; label: string }> = [
      {
        regex: /\bCREATE\s+(?:OR\s+REPLACE\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"[\w.]+)/gi,
        kind: 'class',
        label: 'table',
      },
      {
        regex: /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"[\w.]+)/gi,
        kind: 'variable',
        label: 'view',
      },
      {
        regex: /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:AGGREGATE\s+|WINDOW\s+)?FUNCTION\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"[\w.]+)/gi,
        kind: 'function',
        label: 'function',
      },
      {
        regex: /\bCREATE\s+(?:OR\s+REPLACE\s+)?PROCEDURE\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"[\w.]+)/gi,
        kind: 'function',
        label: 'procedure',
      },
      {
        regex: /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"[\w.]+)/gi,
        kind: 'constant',
        label: 'index',
      },
      {
        regex: /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"[\w.]+)/gi,
        kind: 'function',
        label: 'trigger',
      },
      {
        regex: /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:TYPE|DOMAIN|SEQUENCE|SCHEMA)\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"[\w.]+)/gi,
        kind: 'type_alias',
        label: 'type',
      },
    ];

    for (const { regex, kind, label } of patterns) {
      let match: RegExpExecArray | null;
      while ((match = regex.exec(stripped)) !== null) {
        const rawName = match[1]!;
        // Strip quoting characters and schema prefix (keep only object name)
        const name = rawName.replace(/[`"[\]]/g, '').split('.').pop()!;
        const line = this.getLineNumber(match.index);

        const nodeId = generateNodeId(this.filePath, kind, `${label}:${name}`, line);
        const node: Node = {
          id: nodeId,
          kind,
          name,
          qualifiedName: `${this.filePath}::${label}:${name}`,
          filePath: this.filePath,
          language: 'sql',
          startLine: line,
          endLine: line,
          startColumn: 0,
          endColumn: 0,
          updatedAt: Date.now(),
        };
        this.nodes.push(node);
        this.edges.push({ source: fileNodeId, target: nodeId, kind: 'contains' });
      }
    }
  }

  private getLineNumber(index: number): number {
    return (this.source.substring(0, index).match(/\n/g) || []).length + 1;
  }
}
