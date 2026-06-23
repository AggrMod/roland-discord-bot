#!/usr/bin/env node

const assert = require('assert');
const db = require('../database/db');
const proposalService = require('../services/proposalService');

async function run() {
  const suffix = String(Date.now());
  const guildId = `guild-gov-${suffix}`;
  const creatorId = `gov-creator-${suffix}`;
  const supporterId = `gov-supporter-${suffix}`;
  // Extra eligible-but-non-voting voters. The VP snapshot counts every user
  // with total_nfts > 0, so these pad the proposal's total VP. Without them,
  // the creator + supporter would be the only eligible voters and their two
  // votes would be 100% of the VP, tripping checkAutoClose's ">50% voted"
  // early-close BEFORE the repeat-vote assertion below. (That early-close is
  // correct product behavior — the test simply needs a realistic electorate.)
  const padVoterIds = Array.from({ length: 6 }, (_, i) => `gov-padvoter-${i}-${suffix}`);

  db.prepare('DELETE FROM proposal_supporters WHERE proposal_id IN (SELECT proposal_id FROM proposals WHERE guild_id = ?)').run(guildId);
  db.prepare('DELETE FROM votes WHERE proposal_id IN (SELECT proposal_id FROM proposals WHERE guild_id = ?)').run(guildId);
  db.prepare('DELETE FROM proposals WHERE guild_id = ?').run(guildId);
  db.prepare('DELETE FROM users WHERE discord_id IN (?, ?)').run(creatorId, supporterId);
  for (const padId of padVoterIds) {
    db.prepare('DELETE FROM users WHERE discord_id = ?').run(padId);
  }

  db.prepare(`
    INSERT OR REPLACE INTO users (discord_id, username, total_nfts, total_tokens, tier, voting_power, created_at, updated_at)
    VALUES (?, ?, ?, 0, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(creatorId, `creator_${suffix}`, 12, 'Gold', 0);
  db.prepare(`
    INSERT OR REPLACE INTO users (discord_id, username, total_nfts, total_tokens, tier, voting_power, created_at, updated_at)
    VALUES (?, ?, ?, 0, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(supporterId, `supporter_${suffix}`, 8, 'Silver', 0);
  for (const padId of padVoterIds) {
    db.prepare(`
      INSERT OR REPLACE INTO users (discord_id, username, total_nfts, total_tokens, tier, voting_power, created_at, updated_at)
      VALUES (?, ?, ?, 0, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(padId, `padvoter_${padId}`, 50, 'Gold', 0);
  }

  const created = proposalService.createProposal(creatorId, {
    title: `Governance lifecycle ${suffix}`,
    goal: 'Validate lifecycle flow',
    description: 'Lifecycle smoke for support -> voting -> conclude',
    category: 'Other',
    costIndication: '0',
    guildId,
    initialStatus: 'supporting',
  });
  assert.strictEqual(created.success, true, 'proposal should be created');

  const proposalId = created.proposalId;
  assert.ok(proposalId, 'proposal id should be returned');
  let proposal = proposalService.getProposal(proposalId);
  assert.strictEqual(proposal.status, 'supporting', 'proposal should start in supporting');

  const creatorSupport = proposalService.addSupporter(proposalId, creatorId);
  assert.strictEqual(creatorSupport.success, false, 'creator should not be able to self-support');

  const support = proposalService.addSupporter(proposalId, supporterId);
  assert.strictEqual(support.success, true, 'supporter should be able to support proposal');
  assert.ok(Number(support.supporterCount || 0) >= 1, 'support count should increment');

  const promoted = await proposalService.promoteToVoting(proposalId, 'gov-admin');
  assert.strictEqual(promoted.success, true, 'proposal should promote to voting');
  proposal = proposalService.getProposal(proposalId);
  assert.strictEqual(proposal.status, 'voting', 'proposal should be in voting phase');

  const voteYes = proposalService.castVote(proposalId, creatorId, 'yes', 10);
  assert.strictEqual(voteYes.success, true, 'creator vote should succeed');
  const voteNo = proposalService.castVote(proposalId, supporterId, 'no', 8);
  assert.strictEqual(voteNo.success, true, 'supporter vote should succeed');

  const duplicateVote = proposalService.castVote(proposalId, creatorId, 'no', 10);
  assert.strictEqual(duplicateVote.success, true, 'repeat vote should be accepted as a vote update');

  const concluded = await proposalService.concludeProposal(proposalId);
  assert.strictEqual(concluded.success, true, 'proposal should conclude');
  assert.ok(['passed', 'rejected', 'quorum_not_met'].includes(String(concluded.result || concluded.status)), 'conclusion should produce valid terminal result');

  proposal = proposalService.getProposal(proposalId);
  assert.ok(['passed', 'rejected', 'quorum_not_met'].includes(String(proposal.status)), 'proposal status should be terminal after conclude');

  console.log('governance proposal lifecycle assertions passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
