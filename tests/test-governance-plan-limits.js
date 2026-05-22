#!/usr/bin/env node

const assert = require('assert');
const createGovernanceUserRouter = require('../web/routes/governanceUser');

function makeMockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

async function runRouteHandlers(handlers, req, res) {
  let idx = 0;
  const next = async () => {
    const handler = handlers[idx++];
    if (!handler) return;
    await handler(req, res, next);
  };
  await next();
}

async function run() {
  let createCalled = 0;
  const router = createGovernanceUserRouter({
    logger: { error: () => {} },
    roleService: {
      getUserInfo: async () => ({ discord_id: 'user-1', voting_power: 10 }),
      getUserVotingPower: () => 10,
    },
    proposalService: {
      createProposal: () => {
        createCalled += 1;
        return { success: true, proposalId: 1 };
      },
      postToProposalsChannel: async () => {},
    },
    tenantService: { isMultitenantEnabled: () => true },
    entitlementService: {
      enforceLimit: () => ({
        success: false,
        message: 'Governance active proposal limit reached for current plan.',
        limit: 1,
        used: 1,
      }),
    },
    countActiveGovernanceProposals: () => 1,
    getRequestedGuildId: () => '1468176555091034265',
    fetchGuildById: async () => ({
      id: '1468176555091034265',
      members: {
        fetch: async () => ({
          id: 'user-1',
          roles: { cache: new Map() },
          permissions: { has: () => false },
        }),
      },
    }),
    settingsManager: { getSettings: () => ({}) },
    isProposalInGuildScope: () => true,
    ensurePublicGovernanceScope: () => '1468176555091034265',
    commentLimiter: (_req, _res, next) => next(),
  });

  const layer = router.stack.find(entry => entry.route && entry.route.path === '/api/user/proposals');
  assert.ok(layer, 'proposal create route should exist');
  const handlers = layer.route.stack.map(entry => entry.handle);

  const req = {
    session: { discordUser: { id: 'user-1', username: 'tester' } },
    body: {
      title: 'A',
      goal: 'B',
      description: 'C',
      category: 'Other',
      costIndication: 'Low',
    },
  };
  const res = makeMockRes();
  await runRouteHandlers(handlers, req, res);

  assert.strictEqual(res.statusCode, 400, 'limit exceed should return 400');
  assert.strictEqual(createCalled, 0, 'proposal creation must not run when entitlement limit blocks request');
  assert.strictEqual(res.body?.error?.code, 'LIMIT_EXCEEDED', 'response should expose limit exceeded error code');

  console.log('governance plan limit enforcement assertions passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

