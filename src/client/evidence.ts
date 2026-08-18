/**
 * v1.10 A5: the certificate of completion — pure helpers for rendering a
 * task's execution evidence as an auditable "履约证明书" (certificate):
 *
 *   - `evidenceScore` reduces per-criterion self-assessments to a pass ratio,
 *   - `evidenceVerdict` turns the ratio into a human verdict label key,
 *   - `evidenceStamp` formats the certificate stamp line (key + date).
 *
 * No DOM here, so the unit tests pin the contract. The visual certificate
 * lives in TaskboardView.
 * @module @navidid/dsh-taskboard/client/evidence
 */

/** The subset of a task's evidence the certificate renders. */
export interface CertificateEvidence {
  criteria: Array<{ criterion: string, met: boolean, note: string }>
  artifacts: string[]
  summary: string
}

export interface EvidenceScore {
  /** Criteria met. */
  met: number
  /** Criteria assessed. */
  total: number
  /** met / total; 0 when there is nothing to assess. */
  ratio: number
}

/** Reduce evidence to a pass ratio. Missing/null evidence scores 0/0. */
export function evidenceScore(evidence: CertificateEvidence | null | undefined): EvidenceScore {
  const total = evidence?.criteria.length ?? 0
  const met = total === 0 ? 0 : (evidence?.criteria.filter(criterion => criterion.met).length ?? 0)
  return { met, total, ratio: total === 0 ? 0 : met / total }
}

/** Human verdict for a score — the certificate's badge. */
export function evidenceVerdict(score: EvidenceScore): 'verified' | 'partial' | 'unverified' {
  if (score.total === 0) return 'unverified'
  if (score.met === score.total) return 'verified'
  return 'partial'
}

/** The certificate's stamp line: "TB-5 · 8/18/2026". Guards against bad or
 * missing timestamps without throwing. */
export function evidenceStamp(key: string | undefined, updatedAt: number | null | undefined): string {
  const date = updatedAt === null || updatedAt === undefined || Number.isNaN(updatedAt) || updatedAt <= 0
    ? '—'
    : new Date(updatedAt).toLocaleDateString()
  return `${key ?? 'task'} · ${date}`
}

/**
 * v1.10 A3: the bounce note — the human's reason PLUS a digest of the rejected
 * evidence, so the next dispatch starts from the memory of what was tried and
 * why it was bounced ("打回带记忆"). Safe on missing evidence.
 */
export function bounceMemoryNote(reason: string, evidence: CertificateEvidence | null | undefined): string {
  const parts = [`bounce: ${reason}`]
  const summary = evidence?.summary.trim() ?? ''
  const artifacts = evidence?.artifacts ?? []
  if (summary !== '' || artifacts.length > 0) {
    const digest = [
      summary !== '' ? summary : null,
      artifacts.length > 0 ? `artifacts: ${artifacts.join(', ')}` : null,
    ].filter((part): part is string => part !== null).join('; ')
    parts.push(`rejected evidence — ${digest}`)
  }
  return parts.join('; ')
}
