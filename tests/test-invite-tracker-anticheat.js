const assert = require('assert');

function makeSnowflake(seed) {
  return String(seed).padStart(18, '8').slice(0, 18);
}

async function run() {
  process.env.INVITE_TRACKER_JOINER_MIN_AGE_HOURS = '1';
  process.env.INVITE_TRACKER_INVITER_BURST_WINDOW_MIN = '60';
  process.env.INVITE_TRACKER_INVITER_BURST_MAX = '3';

  const inviteTrackerService = require('../services/inviteTrackerService');

  const stamp = Date.now();
  const guildId = makeSnowflake(`93${String(stamp).slice(-16)}`);
  const inviterId = makeSnowflake(`83${String(stamp).slice(-16)}`);

  // Seed inviter with 3 recent joins to trigger burst cap.
  for (let i = 0; i < 3; i += 1) {
    inviteTrackerService._recordInviteEvent({
      guildId,
      joinedUserId: makeSnowflake(`73${String(stamp + i).slice(-16)}`),
      joinedUsername: `seed_${i}`,
      inviterUserId: inviterId,
      inviterUsername: 'inviter',
      inviteCode: 'SEED',
      source: 'invite',
    });
  }

  const burstFiltered = inviteTrackerService._applyInviteAntiCheat({
    guildId,
    member: {
      user: {
        createdTimestamp: Date.now() - (48 * 60 * 60 * 1000),
      },
    },
    inviterUserId: inviterId,
    inviterUsername: 'inviter',
    source: 'invite',
  });

  assert.strictEqual(burstFiltered.inviterUserId, null, 'burst anti-cheat should clear inviter');
  assert.strictEqual(burstFiltered.source, 'invite_filtered_burst_limit', 'burst anti-cheat should set source marker');

  const youngAccountFiltered = inviteTrackerService._applyInviteAntiCheat({
    guildId,
    member: {
      user: {
        createdTimestamp: Date.now() - (5 * 60 * 1000),
      },
    },
    inviterUserId: makeSnowflake(`84${String(stamp).slice(-16)}`),
    inviterUsername: 'young',
    source: 'invite',
  });

  assert.strictEqual(youngAccountFiltered.inviterUserId, null, 'new account anti-cheat should clear inviter');
  assert.strictEqual(youngAccountFiltered.source, 'invite_filtered_joiner_account_age', 'new account anti-cheat should set source marker');

  console.log('invite tracker anti-cheat assertions passed');
}

run().catch((error) => {
  console.error('Invite tracker anti-cheat test failed:', error.message);
  process.exit(1);
});
