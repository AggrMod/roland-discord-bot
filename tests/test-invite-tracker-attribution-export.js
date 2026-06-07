const assert = require('assert');

const inviteTrackerService = require('../services/inviteTrackerService');
const entitlementService = require('../services/entitlementService');

function makeSnowflake(seed) {
  const text = String(seed);
  return text.padStart(18, '7').slice(0, 18);
}

async function run() {
  const stamp = Date.now();
  const guildId = makeSnowflake(`91${String(stamp).slice(-16)}`);

  const originalGetEffectiveLimit = entitlementService.getEffectiveLimit;

  try {
    entitlementService.getEffectiveLimit = (targetGuildId, moduleKey, limitKey) => {
      if (String(targetGuildId) === String(guildId) && moduleKey === 'invites') {
        if (limitKey === 'allow_export') return 1;
        if (limitKey === 'allow_time_filters') return 1;
        if (limitKey === 'max_history_days') return null;
        if (limitKey === 'max_leaderboard_rows') return 100;
      }
      return originalGetEffectiveLimit(targetGuildId, moduleKey, limitKey);
    };

    const inviterA = makeSnowflake(`81${String(stamp).slice(-16)}`);
    const inviterB = makeSnowflake(`82${String(stamp).slice(-16)}`);

    const first = inviteTrackerService._recordInviteEvent({
      guildId,
      joinedUserId: makeSnowflake(`71${String(stamp).slice(-16)}`),
      joinedUsername: 'joined_a',
      inviterUserId: inviterA,
      inviterUsername: 'inviter_a',
      inviteCode: 'CODEA',
      source: 'invite',
    });
    assert.strictEqual(first.success, true, 'first event should record');

    const duplicate = inviteTrackerService._recordInviteEvent({
      guildId,
      joinedUserId: makeSnowflake(`71${String(stamp).slice(-16)}`),
      joinedUsername: 'joined_a_again',
      inviterUserId: inviterB,
      inviterUsername: 'inviter_b',
      inviteCode: 'CODEB',
      source: 'invite',
    });
    assert.strictEqual(duplicate.success, true, 'duplicate insert should be safe');
    assert.strictEqual(duplicate.duplicate, true, 'duplicate join should be ignored by unique key');

    const unknown = inviteTrackerService._recordInviteEvent({
      guildId,
      joinedUserId: makeSnowflake(`72${String(stamp).slice(-16)}`),
      joinedUsername: 'joined_unknown',
      inviterUserId: null,
      inviterUsername: null,
      inviteCode: null,
      source: 'unknown',
    });
    assert.strictEqual(unknown.success, true, 'unknown-source event should record');

    for (let i = 0; i < 620; i += 1) {
      const joinedSeed = `73${String(stamp + i).slice(-16)}`;
      inviteTrackerService._recordInviteEvent({
        guildId,
        joinedUserId: makeSnowflake(joinedSeed),
        joinedUsername: `joined_${i}`,
        inviterUserId: inviterA,
        inviterUsername: 'inviter_a',
        inviteCode: i % 2 === 0 ? 'CODEA' : 'CODEA2',
        source: 'invite',
      });
    }

    const summary = inviteTrackerService.getSummary(guildId);
    assert.strictEqual(summary.success, true, 'summary should succeed');
    assert.ok(Number(summary.summary.totalJoins || 0) >= 622, 'summary should include all unique joins');
    assert.ok(Number(summary.summary.resolvedJoins || 0) >= 621, 'summary should count resolved joins');
    assert.ok(Number(summary.summary.unknownJoins || 0) >= 1, 'summary should include unknown joins');

    const exported = await inviteTrackerService.exportCsv(guildId, { days: null });
    assert.strictEqual(exported.success, true, 'csv export should succeed for allowed plan');
    const csv = String(exported.csv || '');
    assert.ok(csv.startsWith('\uFEFF'), 'csv export should include UTF-8 BOM for Excel compatibility');
    assert.ok(csv.includes('\r\n'), 'csv export should use CRLF line endings for Excel compatibility');
    const lines = csv.split('\r\n');
    assert.ok(lines.length >= 623, 'csv export should include header + full large dataset without 500-row truncation');
    assert.strictEqual(lines[0].replace(/^\uFEFF/, ''), 'joined_at,joined_user_id,joined_username,inviter_user_id,inviter_username,invite_code,source', 'csv header should match expected schema');

    console.log('invite tracker attribution + large export assertions passed');
  } finally {
    entitlementService.getEffectiveLimit = originalGetEffectiveLimit;
  }
}

run().catch((error) => {
  console.error('Invite tracker attribution/export test failed:', error.message);
  process.exit(1);
});
