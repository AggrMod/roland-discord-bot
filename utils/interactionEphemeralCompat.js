const {
  MessageFlags,
  CommandInteraction,
  ChatInputCommandInteraction,
  ContextMenuCommandInteraction,
  ButtonInteraction,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
  UserSelectMenuInteraction,
  RoleSelectMenuInteraction,
  ChannelSelectMenuInteraction,
  MentionableSelectMenuInteraction,
} = require('discord.js');

const TARGET_METHODS = ['reply', 'deferReply', 'followUp', 'editReply'];
const TARGET_CLASSES = [
  CommandInteraction,
  ChatInputCommandInteraction,
  ContextMenuCommandInteraction,
  ButtonInteraction,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
  UserSelectMenuInteraction,
  RoleSelectMenuInteraction,
  ChannelSelectMenuInteraction,
  MentionableSelectMenuInteraction,
];

function normalizeInteractionOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    return options;
  }
  if (!Object.prototype.hasOwnProperty.call(options, 'ephemeral')) {
    return options;
  }

  const normalized = { ...options };
  const wantsEphemeral = normalized.ephemeral === true;
  delete normalized.ephemeral;

  if (wantsEphemeral) {
    const existingFlags = Number(normalized.flags || 0);
    normalized.flags = existingFlags | MessageFlags.Ephemeral;
  }

  return normalized;
}

function patchMethod(targetClass, methodName) {
  const proto = targetClass?.prototype;
  if (!proto || typeof proto[methodName] !== 'function') return;

  const original = proto[methodName];
  if (original.__gpEphemeralCompatPatched) return;

  const wrapped = function wrappedInteractionMethod(options, ...rest) {
    return original.call(this, normalizeInteractionOptions(options), ...rest);
  };
  wrapped.__gpEphemeralCompatPatched = true;

  proto[methodName] = wrapped;
}

let installed = false;
function installInteractionEphemeralCompat() {
  if (installed) return;
  installed = true;
  for (const targetClass of TARGET_CLASSES) {
    for (const methodName of TARGET_METHODS) {
      patchMethod(targetClass, methodName);
    }
  }
}

module.exports = installInteractionEphemeralCompat;
