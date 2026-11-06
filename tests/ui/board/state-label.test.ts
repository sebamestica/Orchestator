import { describe, expect, it } from 'vitest';
import { taskStateSchema } from '../../../src/shared/tasks.ts';
import { taskStateLabel } from '../../../src/ui/features/board/types.ts';

describe('taskStateLabel', () => {
  it('traduce todos los estados y ninguno queda en inglés', () => {
    for (const state of taskStateSchema.options) {
      const label = taskStateLabel(state);
      expect(label).not.toBe(state);
      expect(label.length).toBeGreaterThan(0);
    }
  });
});
