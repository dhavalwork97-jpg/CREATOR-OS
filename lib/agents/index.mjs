// Handler registry keyed by "<agent>.<task_type>". Each phase registers its agents here.
// Empty until Phase 1: the supervisor fails unknown task types visibly rather than pretending they ran.
export const handlers = {};

// Recurring task definitions the worker tick makes sure exist (idempotent per interval bucket).
export function recurringDefinitions() { return []; }
