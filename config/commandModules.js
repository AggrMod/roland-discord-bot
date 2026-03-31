const COMMAND_MODULE_MAP = Object.freeze({
  verification: 'verification',
  governance: 'governance',
  treasury: 'treasury',
  battle: 'battle',
  heist: 'heist',
  higherlower: 'battle',
  diceduel: 'battle',
  reactionrace: 'battle',
  numberguess: 'battle',
  slots: 'battle',
  trivia: 'battle',
  wordscramble: 'battle',
  rps: 'battle',
  blackjack: 'battle',
  gamenight: 'battle',
  'og-config': 'verification'
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
