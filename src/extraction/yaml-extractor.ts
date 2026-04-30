import { Node, Edge, ExtractionResult, ExtractionError, UnresolvedReference } from '../types';
import { generateNodeId } from './tree-sitter-helpers';

/**
 * YamlExtractor - Extracts structural elements from YAML files
 *
 * Extracts top-level keys and recognises common YAML schema patterns:
 * - GitHub Actions: jobs and their steps
 * - GitLab CI: top-level job definitions
 * - Docker Compose: services, volumes, networks
 * - Kubernetes: kind + metadata.name
 * - Generic: top-level scalar/mapping keys as variables
 */
export class YamlExtractor {
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
      const fileType = this.detectFileType();

      if (fileType === 'github-actions') {
        this.extractGitHubActions(fileNode.id);
      } else if (fileType === 'docker-compose') {
        this.extractDockerCompose(fileNode.id);
      } else if (fileType === 'kubernetes') {
        this.extractKubernetes(fileNode.id);
      } else {
        // Generic: top-level keys
        this.extractTopLevelKeys(fileNode.id);
      }
    } catch (error) {
      this.errors.push({
        message: `YAML extraction error: ${error instanceof Error ? error.message : String(error)}`,
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
      language: 'yaml',
      startLine: 1,
      endLine: lines.length,
      startColumn: 0,
      endColumn: lines[lines.length - 1]?.length || 0,
      updatedAt: Date.now(),
    };
    this.nodes.push(fileNode);
    return fileNode;
  }

  private detectFileType(): 'github-actions' | 'docker-compose' | 'kubernetes' | 'generic' {
    // GitHub Actions workflows contain "on:" or "jobs:" at the top level
    if (/^(?:on|jobs)\s*:/m.test(this.source)) return 'github-actions';
    // Docker Compose files have a "services:" key
    if (/^services\s*:/m.test(this.source)) return 'docker-compose';
    // Kubernetes manifests have "apiVersion:" and "kind:"
    if (/^apiVersion\s*:/m.test(this.source) && /^kind\s*:/m.test(this.source)) return 'kubernetes';
    return 'generic';
  }

  // ── GitHub Actions ────────────────────────────────────────────────────────

  private extractGitHubActions(fileNodeId: string): void {
    // Extract workflow name
    const nameMatch = /^name\s*:\s*(.+)$/m.exec(this.source);
    if (nameMatch) {
      const workflowName = nameMatch[1]!.trim().replace(/^['"]|['"]$/g, '');
      const line = this.getLineNumber(nameMatch.index!);
      const nodeId = generateNodeId(this.filePath, 'module', `workflow:${workflowName}`, line);
      const node: Node = {
        id: nodeId,
        kind: 'module',
        name: workflowName,
        qualifiedName: `${this.filePath}::workflow:${workflowName}`,
        filePath: this.filePath,
        language: 'yaml',
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: 0,
        updatedAt: Date.now(),
      };
      this.nodes.push(node);
      this.edges.push({ source: fileNodeId, target: nodeId, kind: 'contains' });
    }

    // Extract job IDs: lines indented under "jobs:" with pattern "  <job-id>:"
    const jobsMatch = /^jobs\s*:\s*\n([\s\S]*?)(?=^\S|\z)/m.exec(this.source);
    if (jobsMatch) {
      const jobsBlock = jobsMatch[1]!;
      const jobsOffset = jobsMatch.index! + jobsMatch[0].indexOf(jobsBlock);
      const jobRegex = /^  ([\w-]+)\s*:/gm;
      let match: RegExpExecArray | null;
      while ((match = jobRegex.exec(jobsBlock)) !== null) {
        const jobName = match[1]!;
        const line = this.getLineNumber(jobsOffset + match.index);
        const nodeId = generateNodeId(this.filePath, 'function', `job:${jobName}`, line);
        const node: Node = {
          id: nodeId,
          kind: 'function',
          name: jobName,
          qualifiedName: `${this.filePath}::job:${jobName}`,
          filePath: this.filePath,
          language: 'yaml',
          startLine: line,
          endLine: line,
          startColumn: 2,
          endColumn: 2 + match[0].length,
          updatedAt: Date.now(),
        };
        this.nodes.push(node);
        this.edges.push({ source: fileNodeId, target: nodeId, kind: 'contains' });
      }
    }
  }

  // ── Docker Compose ────────────────────────────────────────────────────────

  private extractDockerCompose(fileNodeId: string): void {
    const sections = ['services', 'volumes', 'networks'];
    for (const section of sections) {
      const sectionRegex = new RegExp(`^${section}\\s*:\\s*\\n([\\s\\S]*?)(?=^\\S|\\z)`, 'm');
      const sectionMatch = sectionRegex.exec(this.source);
      if (!sectionMatch) continue;

      const block = sectionMatch[1]!;
      const blockOffset = sectionMatch.index + sectionMatch[0].indexOf(block);
      const itemRegex = /^  ([\w-]+)\s*:/gm;
      let match: RegExpExecArray | null;
      while ((match = itemRegex.exec(block)) !== null) {
        const itemName = match[1]!;
        const line = this.getLineNumber(blockOffset + match.index);
        const kind: Node['kind'] = section === 'services' ? 'component' : 'variable';
        const nodeId = generateNodeId(this.filePath, kind, `${section}:${itemName}`, line);
        const node: Node = {
          id: nodeId,
          kind,
          name: itemName,
          qualifiedName: `${this.filePath}::${section}:${itemName}`,
          filePath: this.filePath,
          language: 'yaml',
          startLine: line,
          endLine: line,
          startColumn: 2,
          endColumn: 2 + match[0].length,
          updatedAt: Date.now(),
        };
        this.nodes.push(node);
        this.edges.push({ source: fileNodeId, target: nodeId, kind: 'contains' });
      }
    }
  }

  // ── Kubernetes ────────────────────────────────────────────────────────────

  private extractKubernetes(fileNodeId: string): void {
    const kindMatch = /^kind\s*:\s*(.+)$/m.exec(this.source);
    const nameMatch = /^\s+name\s*:\s*(.+)$/m.exec(this.source);

    const kind = kindMatch ? kindMatch[1]!.trim() : 'Resource';
    const name = nameMatch ? nameMatch[1]!.trim().replace(/^['"]|['"]$/g, '') : 'unnamed';
    const line = kindMatch ? this.getLineNumber(kindMatch.index!) : 1;

    const nodeId = generateNodeId(this.filePath, 'class', `${kind}:${name}`, line);
    const node: Node = {
      id: nodeId,
      kind: 'class',
      name,
      qualifiedName: `${this.filePath}::${kind}:${name}`,
      filePath: this.filePath,
      language: 'yaml',
      startLine: line,
      endLine: this.source.split('\n').length,
      startColumn: 0,
      endColumn: 0,
      docstring: kind,
      updatedAt: Date.now(),
    };
    this.nodes.push(node);
    this.edges.push({ source: fileNodeId, target: nodeId, kind: 'contains' });
  }

  // ── Generic ───────────────────────────────────────────────────────────────

  private extractTopLevelKeys(fileNodeId: string): void {
    // Match top-level keys: lines that start without indentation and have "key:"
    const keyRegex = /^([\w-]+)\s*:/gm;
    let match: RegExpExecArray | null;
    while ((match = keyRegex.exec(this.source)) !== null) {
      const key = match[1]!;
      // Skip YAML document markers and common non-semantic keys
      if (['true', 'false', 'null', 'yes', 'no'].includes(key.toLowerCase())) continue;
      const line = this.getLineNumber(match.index);
      const nodeId = generateNodeId(this.filePath, 'variable', key, line);
      const node: Node = {
        id: nodeId,
        kind: 'variable',
        name: key,
        qualifiedName: `${this.filePath}::${key}`,
        filePath: this.filePath,
        language: 'yaml',
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        updatedAt: Date.now(),
      };
      this.nodes.push(node);
      this.edges.push({ source: fileNodeId, target: nodeId, kind: 'contains' });
    }
  }

  private getLineNumber(index: number): number {
    return (this.source.substring(0, index).match(/\n/g) || []).length + 1;
  }
}
