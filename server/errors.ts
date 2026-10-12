/// <reference types="node" />
export class KanbanError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }

  toJSON(): Record<string, unknown> {
    return { ok: false, error: this.code, message: this.message, ...this.details };
  }
}
