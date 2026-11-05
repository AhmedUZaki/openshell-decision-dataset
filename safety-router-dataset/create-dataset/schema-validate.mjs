// Dependency-free checker for the JSON Schema subset used by safety-router-dataset/create-dataset/schemas/*.schema.json: type, enum, const, required, properties,
// additionalProperties: false, items, oneOf, minItems, minLength, minimum, minProperties, pattern.
const kindOf = v => v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v;

export function validate(schema, value, path = '$') {
  const errors = [];
  const types = schema.type === undefined ? null : [].concat(schema.type);
  const kind = kindOf(value);
  if (types && !types.some(t => t === kind || (t === 'number' && typeof value === 'number'))) { errors.push(`${path}: expected ${types.join('|')}, got ${kind}`); return errors; }
  if ('const' in schema && value !== schema.const) errors.push(`${path}: must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  if (schema.oneOf) {
    const passing = schema.oneOf.filter(s => validate(s, value, path).length === 0).length;
    if (passing !== 1) errors.push(`${path}: matches ${passing} of ${schema.oneOf.length} allowed shapes (needs exactly 1)`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: does not match ${schema.pattern}`);
  }
  if ((kind === 'integer' || kind === 'number') && schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below ${schema.minimum}`);
  if (kind === 'object') {
    for (const key of schema.required || []) if (!(key in value)) errors.push(`${path}: missing ${key}`);
    for (const [key, sub] of Object.entries(schema.properties || {})) if (key in value) errors.push(...validate(sub, value[key], `${path}.${key}`));
    if (schema.additionalProperties === false) for (const key of Object.keys(value)) if (!(key in (schema.properties || {}))) errors.push(`${path}: unexpected ${key}`);
    if (schema.minProperties !== undefined && Object.keys(value).length < schema.minProperties) errors.push(`${path}: fewer than ${schema.minProperties} properties`);
  }
  if (kind === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.items) value.forEach((item, i) => errors.push(...validate(schema.items, item, `${path}[${i}]`)));
  }
  return errors;
}
