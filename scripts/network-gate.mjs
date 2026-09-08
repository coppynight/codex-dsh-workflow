export function assertClaudeNetworkConfirmation(value) {
  if (value !== 'stable-supported') throw new Error('CLAUDE_NETWORK_UNCONFIRMED: Ask the user whether this machine currently has stable overseas IP access in a supported region with eligible account use. If no, uncertain or unanswered, use Codex review. No Claude process was started.');
  return { source: 'explicit-current-session-user-confirmation', confirmedAt: new Date().toISOString() };
}
