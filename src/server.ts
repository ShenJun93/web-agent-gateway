import {
  DEVSPACE_PROTOCOL_VERSION,
  REQUIRED_DEVSPACE_TOOLS,
  type DevspaceExecutor,
} from './executor/devspace.js';

export function createGateway({ executor }: { executor: DevspaceExecutor }) {
  return {
    async health() {
      const tools = await executor.listTools();
      const names = tools.map((tool) => tool.name);
      const compatible = names.length === REQUIRED_DEVSPACE_TOOLS.length
        && REQUIRED_DEVSPACE_TOOLS.every((name, index) => names[index] === name);
      if (!compatible) throw new Error(`Incompatible DevSpace tool contract: ${names.join(', ')}`);
      return {
        status: 'ok' as const,
        executor: 'devspace' as const,
        protocolVersion: DEVSPACE_PROTOCOL_VERSION,
        toolCount: tools.length,
      };
    },
  };
}
