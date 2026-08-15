/**
 * The contract, translated into the schema Gemini will actually decode against.
 *
 * A response schema is not documentation: the decoder is constrained by it, so
 * a shape it forbids cannot be produced in the first place. That is a different
 * kind of guarantee from Zod's, which can only tell us afterwards that the turn
 * is lost. Both are kept — the schema stops the common mistakes at the source,
 * Zod remains the wall — but this is the half that makes malformed JSON, an
 * invented tool name and a `duration_minutes: "sixty"` impossible rather than
 * merely detected.
 *
 * It is *derived* from the Zod contract rather than written out beside it.
 * Twenty-eight hand-maintained tool schemas would drift from the union within a
 * release, and a schema that disagrees with the validator is worse than none:
 * it teaches the model a shape we then reject.
 *
 * Two dialects have to be bridged. `z.toJSONSchema` emits JSON Schema
 * 2020-12; `generationConfig.responseSchema` takes Google's OpenAPI 3.0 subset,
 * which spells its types in capitals, calls a union `anyOf`, has no `const` and
 * no `additionalProperties`. Anything this file has not been taught to
 * translate makes it throw, so a zod upgrade that starts emitting a new keyword
 * fails the test rather than silently shipping a schema Gemini will reject.
 */
import { z } from 'zod';

import { llmResponseSchema } from '@/llm/contract';

export type GeminiSchema = Record<string, unknown>;

type JsonSchemaNode = Record<string, unknown>;

/** JSON Schema type name to the proto enum name Gemini expects. */
const TYPES: Record<string, string> = {
  string: 'STRING',
  number: 'NUMBER',
  integer: 'INTEGER',
  boolean: 'BOOLEAN',
  array: 'ARRAY',
  object: 'OBJECT',
};

/**
 * Keywords Google's Schema object does not carry, and why dropping each one
 * costs nothing: Zod still enforces every one of them on the way in.
 *  - `$schema`            metadata about the document, not the shape.
 *  - `additionalProperties` unrepresentable; the decoder only ever emits
 *                         properties the schema declares, which is the same
 *                         thing arrived at from the other side.
 *  - `default`            the decoder would emit the default explicitly rather
 *                         than omitting the field, which is noise.
 */
const DROPPED = new Set(['$schema', 'additionalProperties', 'default']);

/** Keywords that pass through untouched. */
const PASS_THROUGH = new Set([
  'description',
  'enum',
  'format',
  'maxItems',
  'maxLength',
  'maximum',
  'minItems',
  'minLength',
  'minimum',
  'pattern',
  'required',
]);

export function toGeminiSchema(node: unknown): GeminiSchema {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) {
    throw new Error(`Cannot translate a non-object schema node: ${JSON.stringify(node)}`);
  }
  const source = node as JsonSchemaNode;
  const out: GeminiSchema = {};

  for (const [key, value] of Object.entries(source)) {
    if (DROPPED.has(key)) continue;
    if (PASS_THROUGH.has(key)) {
      out[key] = value;
      continue;
    }

    switch (key) {
      case 'type': {
        const mapped = typeof value === 'string' ? TYPES[value] : undefined;
        if (!mapped) throw new Error(`Unsupported JSON Schema type: ${JSON.stringify(value)}`);
        out.type = mapped;
        break;
      }
      // A discriminated union arrives as `oneOf`. Gemini only knows `anyOf`,
      // which is weaker in theory — it does not promise the branches are
      // mutually exclusive — and identical here, because `tool_name` is pinned
      // to a different literal in every branch.
      case 'oneOf':
      case 'anyOf': {
        if (!Array.isArray(value)) throw new Error(`${key} must be an array`);
        out.anyOf = value.map(toGeminiSchema);
        break;
      }
      // No `const` in the subset. A one-value enum says the same thing and is
      // what pins each branch of the union to its tool name.
      case 'const': {
        out.enum = [value];
        break;
      }
      // No exclusive bounds either. Widening by one endpoint is the safe
      // direction: `amount: 0` becomes decodable and Zod rejects it.
      case 'exclusiveMinimum': {
        out.minimum = value;
        break;
      }
      case 'exclusiveMaximum': {
        out.maximum = value;
        break;
      }
      case 'properties': {
        if (typeof value !== 'object' || value === null) throw new Error('properties must be an object');
        out.properties = Object.fromEntries(
          Object.entries(value as Record<string, unknown>).map(([name, child]) => [
            name,
            toGeminiSchema(child),
          ]),
        );
        break;
      }
      case 'items': {
        out.items = toGeminiSchema(value);
        break;
      }
      default:
        throw new Error(`No Gemini translation for the JSON Schema keyword "${key}"`);
    }
  }

  return out;
}

/**
 * Built once and reused. It is ~17 kB of JSON that goes out with every request,
 * which is the price of the guarantee; rebuilding it per turn would be paying
 * twice.
 */
let cached: GeminiSchema | null = null;

export function strictResponseSchema(): GeminiSchema {
  if (!cached) {
    // `io: 'input'` is what the model is being asked to produce: the shape
    // *before* defaults are applied and before `currency` is normalised, so an
    // optional-with-a-default field is correctly not required.
    const schema = toGeminiSchema(z.toJSONSchema(llmResponseSchema, { io: 'input' }));
    // `actions` has a default, so the derivation makes it optional — correct for
    // the validator, wrong for the decoder. The prompt's rule is "may be empty
    // but must be present", and a reply that simply omits it is the shape of a
    // model that has drifted into conversation.
    const required = new Set([...((schema.required as string[] | undefined) ?? []), 'actions']);
    schema.required = [...required];
    cached = schema;
  }
  return cached;
}
