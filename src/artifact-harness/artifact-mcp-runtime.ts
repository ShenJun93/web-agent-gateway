import type { GatewayAuthority } from '../caller-context.js';
import type { LocalMachineContext } from '../local-machine-runtime.js';
import type { ArtifactHandle } from './artifact-port.js';
import { ArtifactPort } from './artifact-port.js';

export interface ArtifactMcpView {
  readonly artifactId: string;
  readonly filename: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly createdAt: number;
}

export interface ArtifactMcpExport {
  readonly artifact: ArtifactMcpView;
  readonly workspaceId: string;
  readonly path: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly state: 'CREATED' | 'ALREADY_PRESENT';
}

export interface ArtifactMcpContext {
  list(limit?: number): Promise<readonly ArtifactMcpView[]>;
  describe(artifactId: string): Promise<ArtifactMcpView>;
  export(artifactId: string, workspaceId: string, path: string): Promise<ArtifactMcpExport>;
}

function view(artifact: ArtifactHandle): ArtifactMcpView {
  return Object.freeze({
    artifactId: artifact.artifactId,
    filename: artifact.filename,
    sizeBytes: artifact.sizeBytes,
    sha256: artifact.sha256,
    createdAt: artifact.createdAt,
  });
}

export function createArtifactMcpContext(options: {
  owner: GatewayAuthority;
  artifacts: ArtifactPort;
  machineContext: LocalMachineContext;
}): ArtifactMcpContext {
  return {
    async list(limit = 50) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new Error('Artifact list limit is invalid');
      }
      const artifacts = [...await options.artifacts.list(options.owner)]
        .sort((left, right) => right.createdAt - left.createdAt
          || left.artifactId.localeCompare(right.artifactId))
        .slice(0, limit)
        .map(view);
      return Object.freeze(artifacts);
    },

    async describe(artifactId) {
      return view(await options.artifacts.get(options.owner, artifactId));
    },

    async export(artifactId, workspaceId, path) {
      const read = await options.artifacts.readBytes(options.owner, artifactId);
      const destination = await options.machineContext.createBinaryFile(
        workspaceId,
        path,
        read.bytes,
        read.artifact.sha256,
      );
      return Object.freeze({
        artifact: view(read.artifact),
        workspaceId,
        path: destination.path,
        sizeBytes: destination.size_bytes,
        sha256: destination.sha256,
        state: destination.state,
      });
    },
  };
}
