import type { GatewayAuthority } from '../caller-context.js';
import type { ArtifactHandle } from '../artifact-harness/artifact-port.js';

export interface ArtifactReader {
  get(owner: GatewayAuthority, artifactId: string): Promise<ArtifactHandle>;
}

export interface SemanticFileSetter {
  setFiles(
    owner: GatewayAuthority,
    browserSessionId: string,
    ref: string,
    internalPaths: readonly string[],
  ): Promise<void>;
}

export interface BrowserUploadController {
  upload(
    owner: GatewayAuthority,
    browserSessionId: string,
    ref: string,
    artifactIds: readonly string[],
  ): Promise<readonly ArtifactHandle[]>;
}

export function createBrowserUploadController(options: {
  artifacts: ArtifactReader;
  semantic: SemanticFileSetter;
}): BrowserUploadController {
  return {
    async upload(owner, browserSessionId, ref, artifactIds) {
      if (!Array.isArray(artifactIds) || artifactIds.length < 1 || artifactIds.length > 20) {
        throw new Error('Browser upload artifact set is invalid');
      }
      const artifacts: ArtifactHandle[] = [];
      for (const artifactId of artifactIds) {
        artifacts.push(await options.artifacts.get(owner, artifactId));
      }
      await options.semantic.setFiles(
        owner,
        browserSessionId,
        ref,
        artifacts.map((artifact) => artifact.internalPath),
      );
      return Object.freeze(artifacts);
    },
  };
}
