const COMMAND_MODULE_MAP = Object.freeze({
  verification: 'verification',
  governance: 'governance',
  proposal: 'governance',
  // Keep the legacy /treasury command under the Wallet Tracker entitlement.
  treasury: 'wallettracker',
  minigames: 'minigames',
  'wallet-tracker': 'wallettracker',
  invites: 'invites',
  'nft-tracker': 'nfttracker',
  'token-tracker': 'tokentracker',
  aiassistant: 'aiassistant',
  ticketing: 'ticketing',
  vault: 'vault',
  battle: 'minigames',
  heist: 'heist',
  higherlower: 'minigames',
  diceduel: 'minigames',
  reactionrace: 'minigames',
  numberguess: 'minigames',
  slots: 'minigames',
  trivia: 'minigames',
  wordscramble: 'minigames',
  rps: 'minigames',
  blackjack: 'minigames',
  codebreaker: 'minigames',
  gamenight: 'minigames',
  points: 'engagement',
  guildguard: 'guildguard',
  guard: 'guildguard'
});

function getCommandModuleKey(commandName) {
  return COMMAND_MODULE_MAP[commandName] || null;
}

function getCommandModuleMap() {
  return { ...COMMAND_MODULE_MAP };
}

module.exports = {
  COMMAND_MODULE_MAP,
  getCommandModuleKey,
  getCommandModuleMap
};
