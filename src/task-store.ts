import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks';
import type { Task } from '@modelcontextprotocol/sdk/types.js';

export class NonCancellingTaskStore extends InMemoryTaskStore {
  override async updateTaskStatus(
    taskId: string,
    status: Task['status'],
    statusMessage?: string,
    sessionId?: string,
  ): Promise<void> {
    if (status === 'cancelled') {
      throw new Error('Task cancellation is not supported until executor interruption is implemented');
    }
    return super.updateTaskStatus(taskId, status, statusMessage, sessionId);
  }
}
