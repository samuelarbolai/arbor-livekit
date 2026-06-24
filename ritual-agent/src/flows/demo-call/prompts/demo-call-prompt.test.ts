import { describe, expect, it } from 'vitest';
import { buildDemoCallPrompt } from './demo-call-prompt';

// These assert the grado_de_identificacion-driven desidentificación skip
// branch is authored into the prompt (the agent composes lines from these
// goals; full behavioural eval needs a live model, so we assert the
// load-bearing instructions are present and coherent).
describe('buildDemoCallPrompt — grado-driven desidentificación skip', () => {
  const prompt = buildDemoCallPrompt('es', 'Tomás');

  it('explains the grado branch (high vs low/medium vs low+referral)', () => {
    expect(prompt).toContain('<how-grado-branches>');
    // low/medium skip the heavy desid teaching (Phases 7 and 8)
    expect(prompt).toMatch(/SKIP 7 and 8|skip Phases 7 and 8|Phases 7–8/i);
    // low additionally appends the referral conversation (Phases 16–17)
    expect(prompt).toMatch(/low → same as medium, AND .* APPEND/);
  });

  it('Phase 6 has both a full (high) and a short (low/medium) variant', () => {
    expect(prompt).toContain('If grado_de_identificacion is HIGH');
    expect(prompt).toContain('If grado_de_identificacion is LOW or MEDIUM');
    // the short block acknowledges they already handle desidentificación
    expect(prompt).toContain('ya manejás bastante bien el uso de la desidentificación');
    // and dynamically names the level rather than hardcoding "bajo"
    expect(prompt).toContain('grado de identificación {{grado_de_identificacion}}');
  });

  it('Phases 7 and 8 are gated to high only', () => {
    expect(prompt).toMatch(
      /Run ONLY when grado_de_identificacion is high[\s\S]*Solution: introduce desidentification/,
    );
    expect(prompt).toMatch(
      /Run ONLY when grado_de_identificacion is high[\s\S]*Third close \(mantra commitment\)/,
    );
  });

  it('Phase 8.5 is a warm acknowledgment, not an evaluation, and never sets fit_state', () => {
    expect(prompt).toContain('Acknowledge the fit.');
    expect(prompt).toContain('NO LONGER an evaluation');
    expect(prompt).toContain('Do NOT set fit_state here');
  });

  it('Phase 9 keeps the doc + promise visuals for everyone', () => {
    expect(prompt).toContain('ALWAYS show the doc and promise visuals above — for EVERY prospect');
  });

  it('relocates the admission-test scarcity pause to end of Phase 5b', () => {
    expect(prompt).toContain('Dejame tomar un momento con lo que acabamos de ver.');
    expect(prompt).toMatch(/admission-test (beats|scarcity)/i);
  });

  it('drops fit_state as a judgment/branch driver', () => {
    expect(prompt).toContain('Do NOT set fit_state');
    expect(prompt).not.toMatch(/\[If fit_state = qualified/);
    expect(prompt).not.toContain('[CONDITION: fit_state=qualified]');
    expect(prompt).not.toContain('[CONDITION: fit_state=still_disqualified]');
  });

  it('gates the referral phases (16–17) on grado=low, appended after the close', () => {
    expect(prompt).toContain('[CONDITION: grado_de_identificacion=low — APPENDED after the close');
  });
});
