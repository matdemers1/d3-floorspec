import { describe, expect, it } from 'vitest';
import { editedLevel } from '../src/index.js';

/**
 * Found adding a stair guard upstairs in Georgia West House: `render: true` drew the main floor, where
 * nothing had changed. The render after an edit now draws the level the batch drew on.
 */
describe('the level an edit is drawn on', () => {
  it('is the level the resolved operations name most', () => {
    expect(
      editedLevel([
        { op: 'removeElement', id: 'S5' },
        { op: 'addWall', id: 'W57', level: 'L2', start: 'J41', end: 'J42' },
        { op: 'addWall', id: 'W58', level: 'L2', start: 'J42', end: 'J43' },
        { op: 'addElement', collection: 'stairs', id: 'ST2', element: { level: 'L1', to: 'L2' } },
      ]),
    ).toBe('L2');
  });

  it('is an added element\'s level when only elements are added, and none when no operation names one', () => {
    expect(editedLevel([{ op: 'addElement', collection: 'rooms', id: 'R1', element: { level: 'L3', anchor: [0, 0] } }])).toBe('L3');
    expect(editedLevel([{ op: 'setProperty', id: 'O1', path: '/swing', value: 'left' }])).toBeUndefined();
  });
});
