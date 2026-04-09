const COMMAND_MODULE_MAP = Object.freeze({
  verification: 'verification',
  governance: 'governance',
  treasury: 'treasury',
  minigames: 'minigames',
  'wallet-tracker': 'wallettracker',
  'nft-tracker': 'nfttracker',
  'token-tracker': 'tokentracker',
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
  gamenight: 'minigames',
  points: 'engagement'
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
