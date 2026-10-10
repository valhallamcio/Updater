/*
 * serverTargets.js
 *
 * Turns what staff typed into the servers a command runs on. Tags are not unique: one tag can
 * name several instances (evol, pri). A tag names every instance of the pack. A Pterodactyl id
 * or an exact instance name names one instance. Nothing here picks one instance of a tag for
 * the others.
 */

const norm = value => String(value || '').trim().toLowerCase();

/**
 * The instances of one tag, in the given order.
 * @param {Array} servers Server docs from Yggdrasil.
 * @param {string} tag Pack tag.
 * @returns {Array}
 */
function instancesOfTag(servers, tag) {
    const needle = norm(tag);
    if (!needle) return [];
    return servers.filter(s => norm(s.tag) === needle);
}

/**
 * The servers a typed value names.
 * Order: Pterodactyl id, tag, exact instance name, then a name cut to 20 characters plus "...".
 * @param {Array} servers Server docs from Yggdrasil.
 * @param {string} query What staff typed or picked.
 * @returns {{servers: Array, by: string|null, error: string|null}} by is 'id', 'tag', 'name' or
 *   'prefix'. A tag gives every instance of the pack. error is set when nothing or more than
 *   one instance matches a name.
 */
function resolveTargets(servers, query) {
    const needle = norm(query);
    if (!needle) return { servers: [], by: null, error: 'No server given.' };

    const byId = servers.filter(s => norm(s.serverId) === needle);
    if (byId.length === 1) return { servers: byId, by: 'id', error: null };

    const byTag = instancesOfTag(servers, needle);
    if (byTag.length > 0) return { servers: byTag, by: 'tag', error: null };

    const byName = servers.filter(s => norm(s.name) === needle);
    if (byName.length === 1) return { servers: byName, by: 'name', error: null };
    if (byName.length > 1) {
        return { servers: [], by: null, error: `${byName.length} instances are named \`${String(query).trim()}\`. Use the Pterodactyl id.` };
    }

    if (needle.endsWith('...')) {
        const prefix = needle.slice(0, -3).trim();
        const hits = prefix ? servers.filter(s => norm(s.name).startsWith(prefix)) : [];
        if (hits.length === 1) return { servers: hits, by: 'prefix', error: null };
        if (hits.length > 1) {
            return { servers: [], by: null, error: `\`${String(query).trim()}\` matches ${hits.length} instances (${hits.map(s => s.name).join(', ')}). Pick one from the list.` };
        }
    }
    return { servers: [], by: null, error: null };
}

/**
 * Autocomplete choices: one per single-instance pack, and for a pack with several instances
 * one choice for the whole tag plus one per instance. The value is the tag or the Pterodactyl
 * id, so resolveTargets always reads it back as the same servers.
 * @param {Array} servers Server docs from Yggdrasil.
 * @param {string} focused What staff typed so far.
 * @param {Array<string>} extra Fixed choices that go first (for example "all").
 * @returns {Array<{name: string, value: string}>} At most 25.
 */
function autocompleteChoices(servers, focused, extra = []) {
    const byTag = new Map();
    const untagged = [];
    for (const server of servers) {
        if (!server.tag) {
            untagged.push(server);
            continue;
        }
        if (!byTag.has(server.tag)) byTag.set(server.tag, []);
        byTag.get(server.tag).push(server);
    }

    const choices = extra.map(value => ({ name: value, value }));
    const name = s => String(s.name || s.serverId || '').trim();
    for (const [tag, instances] of byTag) {
        if (instances.length === 1) {
            choices.push({ name: `${name(instances[0])} (${tag})`, value: tag });
            continue;
        }
        choices.push({ name: `${tag}: all ${instances.length} instances`, value: tag });
        for (const s of instances) {
            if (s.serverId) choices.push({ name: `${tag}: ${name(s)}`, value: s.serverId });
        }
    }
    for (const s of untagged) {
        if (s.serverId) choices.push({ name: name(s), value: s.serverId });
    }

    const needle = norm(focused);
    return choices
        .filter(c => c.name.toLowerCase().includes(needle) || c.value.toLowerCase().includes(needle))
        .slice(0, 25)
        .map(c => ({ name: c.name.slice(0, 100), value: c.value.slice(0, 100) }));
}

module.exports = {
    instancesOfTag,
    resolveTargets,
    autocompleteChoices
};
