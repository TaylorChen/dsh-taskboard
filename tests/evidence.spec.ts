/**
 * v1.10 A5: the certificate of completion — unit tests for the pure helpers.
 * The visual certificate + artifact copy is verified by the browser E2E in
 * tests/e2e/v110-a5.py.
 */
import { describe, expect, it } from 'vitest'
import { evidenceScore, evidenceStamp, evidenceVerdict } from '../src/client/evidence.ts'

describe('v1.10 A5 certificate helpers', () => {
  it('evidenceScore counts met criteria and the ratio', () => {
    const score = evidenceScore({
      criteria: [
        { criterion: 'a', met: true, note: '' },
        { criterion: 'b', met: true, note: '' },
        { criterion: 'c', met: false, note: 'missed' },
      ],
      artifacts: ['x'],
      summary: 'done',
    })
    expect(score).toEqual({ met: 2, total: 3, ratio: 2 / 3 })
  })

  it('evidenceScore handles all-met and all-missed', () => {
    expect(evidenceScore({ criteria: [{ criterion: 'a', met: true, note: '' }], artifacts: [], summary: '' }))
      .toEqual({ met: 1, total: 1, ratio: 1 })
    expect(evidenceScore({ criteria: [{ criterion: 'a', met: false, note: '' }], artifacts: [], summary: '' }))
      .toEqual({ met: 0, total: 1, ratio: 0 })
  })

  it('evidenceScore is safe on null/missing/empty evidence', () => {
    expect(evidenceScore(null)).toEqual({ met: 0, total: 0, ratio: 0 })
    expect(evidenceScore(undefined)).toEqual({ met: 0, total: 0, ratio: 0 })
    expect(evidenceScore({ criteria: [], artifacts: [], summary: '' })).toEqual({ met: 0, total: 0, ratio: 0 })
  })

  it('evidenceVerdict maps scores to badges', () => {
    expect(evidenceVerdict({ met: 3, total: 3, ratio: 1 })).toBe('verified')
    expect(evidenceVerdict({ met: 2, total: 3, ratio: 2 / 3 })).toBe('partial')
    expect(evidenceVerdict({ met: 0, total: 3, ratio: 0 })).toBe('partial')
    expect(evidenceVerdict({ met: 0, total: 0, ratio: 0 })).toBe('unverified')
  })

  it('evidenceStamp formats key + date and guards bad timestamps', () => {
    expect(evidenceStamp('TB-5', 1_784_000_000_000)).toMatch(/^TB-5 · /)
    expect(evidenceStamp(undefined, null)).toBe('task · —')
    expect(evidenceStamp('TB-9', NaN)).toBe('TB-9 · —')
    expect(evidenceStamp('TB-9', 0)).toBe('TB-9 · —')
  })
})
