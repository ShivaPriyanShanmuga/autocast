import { z } from 'zod';
import { DemoScript } from '../schema/demo.js';
import type { CliIO } from './run.js';

export async function schemaCommand(_argv: string[], io: CliIO): Promise<number> {
  const schema = z.toJSONSchema(DemoScript, { io: 'input' });
  io.out(JSON.stringify(schema, null, 2));
  return 0;
}
