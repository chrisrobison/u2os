export function validatePlan(plan, toolRegistry) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new Error('Model returned an invalid plan object');
  if (typeof plan.reasoning_summary !== 'string') throw new Error('Model plan requires reasoning_summary');
  if (!Array.isArray(plan.actions)) throw new Error('Model plan requires an actions array');
  if (plan.actions.length > 10) throw new Error('Model plan exceeds the 10-action limit');
  for (const action of plan.actions) {
    if (!action || typeof action !== 'object' || typeof action.tool !== 'string' || !plainObject(action.arguments)) throw new Error('Model returned a malformed action');
    const tool = toolRegistry.get(action.tool); // fail closed on unregistered tools
    validateArguments(action.arguments, tool.schema, action.tool);
  }
  return { reasoning_summary: plan.reasoning_summary, actions: plan.actions.map((a) => ({ tool: a.tool, arguments: a.arguments })) };
}
function plainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function validateArguments(args, schema = {}, toolName) {
  for (const key of schema.required || []) if (!(key in args)) throw new Error(`Model action ${toolName} is missing required argument ${key}`);
  const properties = schema.properties || {};
  for (const [key, value] of Object.entries(args)) {
    if (!(key in properties)) throw new Error(`Model action ${toolName} contains unknown argument ${key}`);
    const type = properties[key]?.type;
    if (type && !matchesType(value, type)) throw new Error(`Model action ${toolName}.${key} must be ${type}`);
  }
}
function matchesType(value, type) {
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return plainObject(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'integer') return Number.isInteger(value);
  return typeof value === type;
}
