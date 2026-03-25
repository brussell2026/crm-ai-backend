const { createEmptyLeadState, normalizeLeadState, summarizeLeadState } = require('./lead-state');
const { createEmptyCoachingPlan, normalizeCoachingPlan } = require('./coaching-contract');
const { deriveRuleSignals } = require('./rule-engine');

module.exports = {
  createEmptyLeadState,
  normalizeLeadState,
  summarizeLeadState,
  createEmptyCoachingPlan,
  normalizeCoachingPlan,
  deriveRuleSignals
};
