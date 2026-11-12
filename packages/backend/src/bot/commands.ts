import { SlashCommandBuilder } from 'discord.js';

export function swapCommand() {
  return new SlashCommandBuilder()
    .setName('swap')
    .setDescription('BTQ ⇄ USDT atomic swaps (HTLC). All replies are private.')
    .setDMPermission(false)
    .addSubcommand((s) => s.setName('start').setDescription('Read and accept the terms'))
    .addSubcommand((s) => s.setName('help').setDescription('How swaps work and every command'))
    .addSubcommand((s) => s.setName('link-evm').setDescription('Link your EVM wallet (private form + signature)'))
    .addSubcommand((s) => s.setName('link-btq').setDescription('Link your BTQ swap key and receive address (private form)'))
    .addSubcommand((s) => s.setName('profile').setDescription('Your linked wallets and swap stats'))
    .addSubcommand((s) => s.setName('book').setDescription('Public order book'))
    .addSubcommand((s) => s.setName('buy').setDescription('Buy BTQ with USDT (private form)'))
    .addSubcommand((s) => s.setName('sell').setDescription('Sell BTQ for USDT (private form)'))
    .addSubcommand((s) =>
      s.setName('take').setDescription('Take a specific order from the book (private form)')
        .addIntegerOption((o) => o.setName('order').setDescription('Order number').setRequired(true).setMinValue(1)),
    )
    .addSubcommand((s) => s.setName('orders').setDescription('Your open orders'))
    .addSubcommand((s) => s.setName('swaps').setDescription('Your swaps and what to do next'))
    .addSubcommand((s) =>
      s.setName('status').setDescription('One swap in detail with the next step')
        .addIntegerOption((o) => o.setName('id').setDescription('Swap number').setRequired(true).setMinValue(1)),
    )
    .addSubcommand((s) =>
      s.setName('fund').setDescription('Lock your side of a swap')
        .addIntegerOption((o) => o.setName('id').setDescription('Swap number').setRequired(true).setMinValue(1)),
    )
    .addSubcommand((s) =>
      s.setName('claim').setDescription('Claim the other side of a swap')
        .addIntegerOption((o) => o.setName('id').setDescription('Swap number').setRequired(true).setMinValue(1)),
    )
    .addSubcommand((s) =>
      s.setName('refund').setDescription('Refund your locked funds after a timeout')
        .addIntegerOption((o) => o.setName('id').setDescription('Swap number').setRequired(true).setMinValue(1)),
    )
    .addSubcommand((s) =>
      s.setName('notifications').setDescription('Turn swap DMs on or off')
        .addStringOption((o) => o.setName('state').setDescription('on or off').setRequired(true).addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' })),
    );
}

export function adminCommand() {
  return new SlashCommandBuilder()
    .setName('swap-admin')
    .setDescription('BTQ Swap operator view (read-only)')
    .setDMPermission(false)
    .addSubcommand((s) => s.setName('status').setDescription('Book, inventory, swaps by state, watcher health'))
    .addSubcommand((s) =>
      s.setName('lookup').setDescription('Look up a user (read-only)')
        .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true)),
    );
}

export function commandPayloads() {
  return [swapCommand().toJSON(), adminCommand().toJSON()];
}

export const PUBLIC_COMMANDS = new Set(['swap start', 'swap help', 'component:swap:tos']);
