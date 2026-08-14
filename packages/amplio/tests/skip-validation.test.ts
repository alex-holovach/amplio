import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineEvent, init, logger, resetConfigForTests, type LogRecord, type Sink } from '../src/legacy.js';

const capture = (): { records: LogRecord[]; sink: Sink } => {
  const records: LogRecord[] = [];
  return {
    records,
    sink: (record) => {
      records.push(record);
    },
  };
};

const userSchema = z.object({ user_id: z.string() });

beforeEach(() => {
  resetConfigForTests();
});

describe('skipValidation', () => {
  it('exposes skipValidation from DefineEventOptions (default false, true when passed)', () => {
    const defaultDef = defineEvent('user.updated', userSchema);
    const skipDef = defineEvent('user.updated.loose', userSchema, { skipValidation: true });

    expect(defaultDef.skipValidation).toBe(false);
    expect(skipDef.skipValidation).toBe(true);
  });

  it('emit succeeds with wrong zod shape when skipValidation is true', () => {
    const { records, sink } = capture();
    init({ service: 'api', env: 'test', sinks: [sink] });

    const looseDef = defineEvent('user.updated.loose', userSchema, { skipValidation: true });

    const record = logger
      .event(looseDef)
      .set({ user_id: 123 } as { user_id: string })
      .emit();

    expect(records).toHaveLength(1);
    expect(records[0]).toBe(record);
    expect(record.user_id).toBe(123);
  });

  it('emit throws /Event validation failed/ when skipValidation is false and shape is wrong', () => {
    const { records, sink } = capture();
    init({ service: 'api', env: 'test', sinks: [sink] });

    const strictDef = defineEvent('user.updated', userSchema);

    expect(() =>
      logger
        .event(strictDef)
        .set({ user_id: 123 } as { user_id: string })
        .emit(),
    ).toThrow(/Event validation failed/);

    expect(records).toHaveLength(0);
  });
});
