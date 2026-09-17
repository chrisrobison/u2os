import { Tool } from './tool.js';
import * as tasksProvider from '../integrations/mock-tasks-provider.js';

export class TasksListTool extends Tool {
  get name() { return 'tasks.list'; }
  get domain() { return 'tasks'; }
  get category() { return 'read'; }
  get schema() {
    return { type: 'object', properties: { status: { type: 'string' } } };
  }
  async execute(args) {
    return tasksProvider.listTasks(args);
  }
}

export class TasksCreateTool extends Tool {
  get name() { return 'tasks.create'; }
  get domain() { return 'tasks'; }
  get category() { return 'consequential'; }
  get schema() {
    return {
      type: 'object',
      properties: { title: { type: 'string' }, dueAt: { type: 'string' }, relatedEntityId: { type: 'string' } },
      required: ['title'],
    };
  }
  async execute(args, context) {
    const task = tasksProvider.createTask(args);
    context.eventBus.publish({
      type: 'task.created',
      source: 'mock-tasks',
      actor: context.actor,
      subject: { type: 'task', id: task.id },
      data: { after: task },
      metadata: { correlationId: context.correlationId, provenance: 'tool:tasks.create' },
    });
    return task;
  }
}

export class TasksCompleteTool extends Tool {
  get name() { return 'tasks.complete'; }
  get domain() { return 'tasks'; }
  get category() { return 'consequential'; }
  get schema() {
    return { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] };
  }
  async execute(args, context) {
    const task = tasksProvider.completeTask(args.id);
    if (!task) throw new Error(`No such task: ${args.id}`);
    context.eventBus.publish({
      type: 'task.completed',
      source: 'mock-tasks',
      actor: context.actor,
      subject: { type: 'task', id: task.id },
      data: { after: task },
      metadata: { correlationId: context.correlationId, provenance: 'tool:tasks.complete' },
    });
    return task;
  }
}
