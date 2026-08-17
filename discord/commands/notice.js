/*
 * /notice create|broadcast|list|expire|enable|translate|show
 *
 * Authors the staff-written notices the proxy shows in game: board cards (pinned,
 * known_issue, event), the announcement rotation, one-shot broadcasts and guide tip
 * overrides. Writes go to bifrost.notices; the proxy watches that collection with a
 * change stream, so players see the result within about a second.
 *
 * Nothing here deletes: `expire` flips `enabled:false` and keeps the history. Staff-only.
 */

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const mongo = require('../../modules/mongo');
const {
    NOTICE_TYPES,
    BODY_CAP,
    TITLE_CAP,
    buildNoticeDoc,
    hasForbiddenTags
} = require('./util/noticeDoc');

const TYPE_CHOICES = NOTICE_TYPES.map(t => ({ name: t, value: t }));

/** What a type does in game — shown back to staff after a create. */
const TYPE_BLURB = {
    announcement: 'joins the announcement rotation',
    broadcast: 'goes out once to everyone online now',
    pinned: 'shows on join until the player clicks [Got it]',
    known_issue: 'shows on join and tops the board',
    event: 'shows on join and on the board until it ends',
    tip: 'overrides the guide card text with that id'
};

/** targets -> one line for the list embed. */
function targetSummary(doc) {
    const t = doc.targets || {};
    const parts = [];
    if (t.tags && t.tags.length) parts.push(t.tags.join('/'));
    if (t.newPlayersOnly) parts.push('new players');
    if (t.minProto != null) parts.push(`proto >= ${t.minProto}`);
    if (t.maxProto != null) parts.push(`proto <= ${t.maxProto}`);
    if (t.langs && t.langs.length) parts.push(t.langs.join('/'));
    return parts.length ? parts.join(', ') : 'everyone';
}

/** startsAt/expiresAt (endsAt for an event) — the proxy honours both, so both are listed. */
function whenSummary(doc) {
    const stamp = at => `<t:${Math.floor(new Date(at).getTime() / 1000)}:R>`;
    const parts = [];
    if (doc.startsAt) parts.push(`starts ${stamp(doc.startsAt)}`);
    const ends = doc.endsAt || doc.expiresAt;
    if (ends) parts.push(`ends ${stamp(ends)}`);
    return parts.length ? parts.join(' · ') : 'no expiry';
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('notice')
        .setDescription('Author the in-game notices players see (board cards, announcements, broadcasts)')
        .setDefaultMemberPermissions(16)
        .setDMPermission(false)
        .addSubcommand(subcommand =>
            subcommand
                .setName('create')
                .setDescription('Create a notice')
                .addStringOption(option =>
                    option.setName('type')
                        .setDescription('What kind of notice this is')
                        .setRequired(true)
                        .addChoices(...TYPE_CHOICES))
                .addStringOption(option =>
                    option.setName('body')
                        .setDescription(`The text players read (max ${BODY_CAP} chars, MiniMessage colours allowed)`)
                        .setRequired(true))
                .addStringOption(option =>
                    option.setName('title')
                        .setDescription(`Card title (max ${TITLE_CAP} chars; required for pinned/known_issue/event)`)
                        .setRequired(false))
                .addStringOption(option =>
                    option.setName('id')
                        .setDescription('Notice id (default: generated; a tip REQUIRES the guide card id, e.g. tip.reply)')
                        .setRequired(false))
                .addStringOption(option =>
                    option.setName('tags')
                        .setDescription('Only these server tags, comma separated (e.g. atm10,pri)')
                        .setRequired(false))
                .addStringOption(option =>
                    option.setName('expires')
                        .setDescription('When it stops showing: 12h / 3d (an event REQUIRES it)')
                        .setRequired(false))
                .addStringOption(option =>
                    option.setName('starts')
                        .setDescription('Delay before it starts showing: 12h / 3d')
                        .setRequired(false))
                .addBooleanOption(option =>
                    option.setName('new_only')
                        .setDescription('Show only to first-time players')
                        .setRequired(false))
                .addStringOption(option =>
                    option.setName('min_version')
                        .setDescription('Only clients on this version or newer (e.g. 1.12.2)')
                        .setRequired(false))
                .addStringOption(option =>
                    option.setName('max_version')
                        .setDescription('Only clients on this version or older (e.g. 1.7.10)')
                        .setRequired(false)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('broadcast')
                .setDescription('Send a one-shot line to everyone online now')
                .addStringOption(option =>
                    option.setName('body')
                        .setDescription(`The text players read (max ${BODY_CAP} chars)`)
                        .setRequired(true))
                .addStringOption(option =>
                    option.setName('tags')
                        .setDescription('Only these server tags, comma separated')
                        .setRequired(false)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('list')
                .setDescription('List notices')
                .addStringOption(option =>
                    option.setName('type')
                        .setDescription('Only this type')
                        .setRequired(false)
                        .addChoices(...TYPE_CHOICES)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('expire')
                .setDescription('Retire a notice (players stop seeing it)')
                .addStringOption(option =>
                    option.setName('id')
                        .setDescription('Notice id')
                        .setRequired(true)
                        .setAutocomplete(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('enable')
                .setDescription('Switch a retired notice back on')
                .addStringOption(option =>
                    option.setName('id')
                        .setDescription('Notice id')
                        .setRequired(true)
                        .setAutocomplete(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('translate')
                .setDescription('Add one language to a notice')
                .addStringOption(option =>
                    option.setName('id')
                        .setDescription('Notice id')
                        .setRequired(true)
                        .setAutocomplete(true))
                .addStringOption(option =>
                    option.setName('lang')
                        .setDescription('Language code (es, de, fr, ...)')
                        .setRequired(true))
                .addStringOption(option =>
                    option.setName('text')
                        .setDescription(`The text in that language (max ${BODY_CAP} chars)`)
                        .setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('show')
                .setDescription('Show the raw notice doc')
                .addStringOption(option =>
                    option.setName('id')
                        .setDescription('Notice id')
                        .setRequired(true)
                        .setAutocomplete(true))),

    async autocomplete(interaction) {
        const focused = interaction.options.getFocused(true);
        if (focused.name !== 'id') return;
        const ids = await mongo.searchNoticeIds(focused.value, 25);
        await interaction.respond(ids.map(id => ({ name: id.slice(0, 100), value: id })));
    },

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        const subcommand = interaction.options.getSubcommand();
        if (subcommand === 'create') return this.create(interaction);
        if (subcommand === 'broadcast') return this.broadcast(interaction);
        if (subcommand === 'list') return this.list(interaction);
        if (subcommand === 'expire') return this.setEnabled(interaction, false);
        if (subcommand === 'enable') return this.setEnabled(interaction, true);
        if (subcommand === 'translate') return this.translate(interaction);
        if (subcommand === 'show') return this.show(interaction);
    },

    /** Who a write is attributed to, so `/notice list` says who wrote what. */
    author(interaction) {
        return interaction.user.tag || interaction.user.username;
    },

    async create(interaction) {
        const built = buildNoticeDoc({
            type: interaction.options.getString('type'),
            body: interaction.options.getString('body'),
            title: interaction.options.getString('title'),
            id: interaction.options.getString('id'),
            tags: interaction.options.getString('tags'),
            expires: interaction.options.getString('expires'),
            starts: interaction.options.getString('starts'),
            newOnly: interaction.options.getBoolean('new_only'),
            minVersion: interaction.options.getString('min_version'),
            maxVersion: interaction.options.getString('max_version'),
            updatedBy: this.author(interaction),
            now: new Date()
        });
        if (!built.ok) {
            await interaction.editReply(`❌ ${built.error}`);
            return;
        }

        await mongo.upsertNotice(built.doc);
        await interaction.editReply(
            `✅ \`${built.doc.id}\` (**${built.doc.type}**) — ${TYPE_BLURB[built.doc.type]}.\n` +
            `Targets: ${targetSummary(built.doc)}. Players see it within ~1 s.` +
            (built.warning ? `\n⚠️ ${built.warning}` : ''));
    },

    async broadcast(interaction) {
        const built = buildNoticeDoc({
            type: 'broadcast',
            body: interaction.options.getString('body'),
            tags: interaction.options.getString('tags'),
            updatedBy: this.author(interaction),
            now: new Date()
        });
        if (!built.ok) {
            await interaction.editReply(`❌ ${built.error}`);
            return;
        }

        await mongo.upsertNotice(built.doc);
        await interaction.editReply(
            `✅ Broadcast \`${built.doc.id}\` sent to ${targetSummary(built.doc)}. ` +
            `Players online see it within ~1 s; it is never re-sent to late joiners.`);
    },

    async list(interaction) {
        const type = interaction.options.getString('type');
        const docs = await mongo.listNotices(type || undefined, 25);
        if (docs.length === 0) {
            await interaction.editReply(type ? `No \`${type}\` notices.` : 'No notices yet.');
            return;
        }

        const embed = new EmbedBuilder()
            .setColor(0x3498db)
            .setTitle(type ? `Notices — ${type} (${docs.length})` : `Notices (${docs.length})`)
            .setTimestamp();
        for (const doc of docs) {
            embed.addFields({
                name: `${doc.enabled === false ? '🚫' : '✅'} ${doc.id}`.slice(0, 256),
                value: [
                    `${doc.type}${doc.title ? ` — ${doc.title}` : ''}`,
                    `${targetSummary(doc)} · ${whenSummary(doc)}`,
                    `by ${doc.updatedBy || 'unknown'}`
                ].join('\n').slice(0, 1024),
                inline: false
            });
        }
        await interaction.editReply({ embeds: [embed] });
    },

    async setEnabled(interaction, enabled) {
        const id = interaction.options.getString('id');
        const result = await mongo.setNoticeEnabled(id, enabled, this.author(interaction));
        if (!result || result.matchedCount === 0) {
            await interaction.editReply(`❌ No notice \`${id}\`.`);
            return;
        }
        await interaction.editReply(enabled
            ? `✅ \`${id}\` is live again — players see it within ~1 s.`
            : `✅ \`${id}\` retired — players stop seeing it within ~1 s.`);
    },

    async translate(interaction) {
        const id = interaction.options.getString('id');
        const lang = String(interaction.options.getString('lang')).trim().toLowerCase();
        const text = String(interaction.options.getString('text')).trim();

        if (!/^[a-z]{2,3}([_-][a-z0-9]{2,4})?$/.test(lang)) {
            await interaction.editReply(`❌ \`${lang}\` is not a language code (es, de, pt-br, ...).`);
            return;
        }
        if (!text) {
            await interaction.editReply('❌ Text is empty.');
            return;
        }
        if (text.length > BODY_CAP) {
            await interaction.editReply(`❌ Text is ${text.length} chars — the cap is ${BODY_CAP}.`);
            return;
        }
        if (hasForbiddenTags(text)) {
            await interaction.editReply('❌ Text carries a `<click:>`/`<hover:>` tag — those are not authored from Discord.');
            return;
        }

        const result = await mongo.setNoticeBodyLang(id, lang, text, this.author(interaction));
        if (!result) {
            await interaction.editReply(`❌ No notice \`${id}\`.`);
            return;
        }
        await interaction.editReply(`✅ \`${id}\` now has a \`${lang}\` text — players on that language see it within ~1 s.`);
    },

    async show(interaction) {
        const id = interaction.options.getString('id');
        const doc = await mongo.getNotice(id);
        if (!doc) {
            await interaction.editReply(`❌ No notice \`${id}\`.`);
            return;
        }
        const json = JSON.stringify(doc, null, 2);
        await interaction.editReply('```json\n' + (json.length > 1900 ? `${json.slice(0, 1900)}\n…` : json) + '\n```');
    },
};
